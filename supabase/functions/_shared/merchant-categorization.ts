// Layered merchant categorisation for imported transactions.
//
// Five layers, tried in order, cheapest and most-trusted first:
//
//   1. household_rule  a household's own learned override (this file)
//   2. global_rule      resolveCategory()'s provider_category/merchant_category/mcc
//   3. keyword          resolveCategory()'s multilingual merchant-name matching
//   4. ai               Claude text classification, feature-flagged, optional
//   5. fallback         "other" -- the existing terminal fallback
//
// Layers 2 and 3 are BOTH served by the existing resolveCategory() in
// categories.ts: it already tries provider_category, then merchant_category,
// then mcc, then description (the merchant name, run through the same
// multilingual keyword table) in that order. For a Wise email import, only
// the merchant name is ever populated, so calling it once here correctly
// realises both layers without duplicating its logic. Layer 1 and layer 4 are
// what's new; this file adds exactly those two, plus the orchestration.
//
// Nothing here creates a category. Every layer, including AI, only ever
// picks from the household's OWN currently-allowed set -- built-in or
// custom, never invented.

import { q, type Db } from "./import-core.ts";
import { resolveCategory, type AppCategory, type CategoryInput } from "./categories.ts";

// ---------------------------------------------------------------------------
// Merchant normalisation -- the one reusable function
// ---------------------------------------------------------------------------
//
// Mirrored (deliberately, not accidentally -- see the comment there) by
// normalizeMerchantForRule() in app.js, the same way perEur()/fmt() already
// are: this repo has no build step to share code between the Deno backend
// and the classic-script frontend, so a small, stable, well-tested pure
// function is kept in sync by hand rather than by tooling. Both sides must
// produce IDENTICAL normalized values, or a rule taught in the browser would
// never match what the import pipeline looks up.

// Card/payment-processor prefixes that precede the real merchant name.
const STRIP_PREFIXES = ["sq", "tst", "sp", "paypal", "www"];
// Legal-entity and country/region qualifiers that trail the real merchant
// name. Stripped as whole trailing WORDS only, one at a time, never from the
// middle of a name -- "Colombian Coffee Co" is not touched mid-string, only
// a genuinely trailing qualifier word is removed.
const STRIP_SUFFIXES = [
  "bv", "inc", "llc", "ltd", "sa", "nv", "gmbh", "corp", "co", "com",
  "colombia", "netherlands", "nederland", "usa", "us", "uk", "eu",
];

export type NormalizedMerchant = { normalized: string; display: string };

/**
 * Normalizes a merchant string for matching, while preserving the original
 * for display. "UBER *TRIP", "Uber BV" and "UBER COLOMBIA" all normalize to
 * "uber" -- the same merchant under three different card-descriptor shapes.
 * "Uber Eats" does NOT collapse onto "uber": "eats" is not a stripped
 * prefix/suffix/legal qualifier, so two genuinely different merchants stay
 * genuinely different.
 */
export function normalizeMerchant(raw: unknown): NormalizedMerchant {
  const display = String(raw ?? "").trim();
  if (!display) return { normalized: "", display: "" };

  let s = display
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents stripped for matching only
    .toLowerCase();

  // A card/payment descriptor often tacks a sub-reference on after `*`
  // ("UBER *TRIP", "SQ *COFFEE SHOP") -- that names a specific charge, not
  // the merchant, and left in place would fragment one merchant into many
  // normalized forms that never match each other or a learned rule.
  s = s.split("*")[0];

  s = s.replace(/[^a-z0-9\s]+/g, " "); // punctuation -> space
  const words = s.split(/\s+/).filter(Boolean);

  while (words.length > 1 && STRIP_PREFIXES.includes(words[0])) words.shift();
  while (words.length > 1 && STRIP_SUFFIXES.includes(words[words.length - 1])) words.pop();

  return { normalized: words.join(" ").trim(), display };
}

/**
 * "Blank or overly generic" merchants must never prompt "always categorize
 * X as Y?" or seed a rule -- a rule keyed on nothing, or on the literal
 * placeholder this app writes when a provider gave no merchant at all,
 * would either never match anything or match everything.
 */
export function isGenericMerchant(normalized: string): boolean {
  if (!normalized || normalized.length < 3) return true;
  const GENERIC = new Set([
    "imported transaction", "transaction", "payment", "purchase", "unknown",
  ]);
  return GENERIC.has(normalized);
}

// ---------------------------------------------------------------------------
// Layer 1: household-learned rules
// ---------------------------------------------------------------------------

export type HouseholdRule = {
  categoryKey: string;
  normalizedMerchant: string;
};

/** Layer 1. Only ever returns a category the household currently allows. */
export async function lookupHouseholdMerchantRule(
  db: Db,
  householdId: string,
  normalizedMerchant: string,
  allowed: Set<string>,
): Promise<HouseholdRule | null> {
  if (!normalizedMerchant) return null;
  try {
    const rows = await db.select(
      `merchant_category_rules?household_id=eq.${q(householdId)}` +
        `&normalized_merchant=eq.${q(normalizedMerchant)}&select=category_key&limit=1`,
    );
    const categoryKey = rows[0]?.category_key ? String(rows[0].category_key) : null;
    if (categoryKey && allowed.has(categoryKey)) {
      return { categoryKey, normalizedMerchant };
    }
    return null;
  } catch {
    // A rule-lookup problem must never stop an import, same principle as
    // allowedCategories() in import-core.ts.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer 4: AI fallback -- feature-flagged, optional, never blocking
// ---------------------------------------------------------------------------

/** Below this, an AI guess is not trusted -- "other" is safer than a wrong category. */
export const AI_CONFIDENCE_THRESHOLD = 0.85;

export type AiClassification = { category: string; confidence: number };
export type AiClassifier = (input: {
  merchant: string;
  subject?: string | null;
  categories: string[];
}) => Promise<AiClassification | null>;

const AI_SYSTEM_PROMPT = "Classify a bank transaction merchant into exactly one of the given " +
  "category names. Reply with ONLY a JSON object, no other text: " +
  '{"category": "<one of the given categories>", "confidence": <0.0-1.0>}. ' +
  "If genuinely unsure, use a low confidence rather than guessing high. " +
  "Never invent a category name outside the given list.";

/**
 * Builds an AiClassifier backed by Claude. Isolated behind this factory so
 * the orchestrator below never imports `fetch` behaviour directly and tests
 * never need a real ANTHROPIC_API_KEY -- they inject a fake AiClassifier.
 *
 * Sends the absolute minimum: the merchant name, the email subject (only
 * when it differs from the merchant -- Wise subjects already ARE the
 * transaction, e.g. "71,362 COP spent at Éxito Express"), and the household's
 * own category names. Never an amount, a person's name, an email address or
 * any part of the email body.
 */
export function createAiClassifier(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  model = "claude-haiku-4-5-20251001",
): AiClassifier {
  return async ({ merchant, subject, categories }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const userText = subject && subject.trim() && subject.trim() !== merchant.trim()
        ? `Merchant: ${merchant}\nSubject: ${subject}`
        : `Merchant: ${merchant}`;

      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 100,
          system: AI_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: `Categories: ${categories.join(", ")}\n\n${userText}`,
          }],
        }),
      });
      if (!res.ok) return null;

      const data = await res.json();
      const text: string = data?.content?.[0]?.text ?? "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]);
      if (typeof parsed.category !== "string" || typeof parsed.confidence !== "number") return null;
      if (!Number.isFinite(parsed.confidence)) return null;
      return { category: parsed.category, confidence: parsed.confidence };
    } catch {
      // Timeout, network failure, malformed JSON -- an AI outage or a bad
      // reply must never block an import. The orchestrator treats a null
      // result exactly like "no match": falls through to the fallback.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type CategoryProvenance = "household_rule" | "global_rule" | "keyword" | "ai" | "fallback";

export type CategorizationResult = {
  category: AppCategory;
  provenance: CategoryProvenance;
  /** The normalized merchant or keyword that matched, safe to store. Never email content. */
  matched: string | null;
};

/**
 * Runs all five layers in priority order and returns the first hit. Total:
 * never throws, so a categorisation problem is always "other", never a
 * failed import.
 */
export async function categorizeTransaction(db: Db, params: {
  householdId: string;
  merchant: string | null;
  subject?: string | null;
  categoryInput: CategoryInput;
  allowed: Set<string>;
  aiClassifier?: AiClassifier | null;
}): Promise<CategorizationResult> {
  const { normalized, display } = normalizeMerchant(params.merchant);

  // ---- 1. household-learned rule ----
  if (normalized) {
    const rule = await lookupHouseholdMerchantRule(db, params.householdId, normalized, params.allowed);
    if (rule) {
      return { category: rule.categoryKey as AppCategory, provenance: "household_rule", matched: normalized };
    }
  }

  // ---- 2 + 3. existing global mapping, then multilingual keyword mapping ----
  const existing = resolveCategory(params.categoryInput, params.allowed);
  if (existing.source !== "fallback") {
    const provenance: CategoryProvenance = existing.source === "description" ? "keyword" : "global_rule";
    return { category: existing.category, provenance, matched: existing.matched };
  }

  // ---- 4. AI fallback, only reached when nothing deterministic matched ----
  if (params.aiClassifier && normalized) {
    try {
      const ai = await params.aiClassifier({
        merchant: display,
        subject: params.subject ?? null,
        categories: [...params.allowed],
      });
      if (
        ai &&
        ai.confidence >= AI_CONFIDENCE_THRESHOLD &&
        params.allowed.has(ai.category)
      ) {
        return { category: ai.category as AppCategory, provenance: "ai", matched: null };
      }
    } catch {
      // AI outage must never block import -- fall through to layer 5.
    }
  }

  // ---- 5. terminal fallback ----
  return { category: existing.category, provenance: "fallback", matched: null };
}
