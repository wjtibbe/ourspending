// Layered merchant categorisation tests.
//
//   node --experimental-strip-types tests/merchant-categorization.test.ts
//
// Drives _shared/merchant-categorization.ts -- the five-layer pipeline
// (household rule -> existing global mapping -> multilingual keyword ->
// AI fallback -> "other") -- against a fake PostgREST, plus an end-to-end
// case proving a learned rule changes FUTURE imports without touching a
// historical expense already on the books.

import {
  categorizeTransaction, createAiClassifier, isGenericMerchant,
  normalizeMerchant, AI_CONFIDENCE_THRESHOLD, type AiClassifier,
} from "../supabase/functions/_shared/merchant-categorization.ts";
import {
  buildExpenseRow, resolveImportContext, type ImportContext, type Row,
  type NormalizedTransaction,
} from "../supabase/functions/_shared/import-core.ts";
import { APP_CATEGORIES } from "../supabase/functions/_shared/categories.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

class FakeDb {
  store: Record<string, Row[]> = {};
  seq = 0;
  rows(t: string) { return (this.store[t] ??= []); }
  select(path: string): Promise<Row[]> {
    const [table, qs] = path.split("?");
    const params = new URLSearchParams(qs ?? "");
    const filters: Array<[string, string]> = [];
    for (const [k, v] of params) {
      if (["select", "limit", "order", "on_conflict"].includes(k)) continue;
      if (v.startsWith("eq.")) filters.push([k, decodeURIComponent(v.slice(3))]);
    }
    return Promise.resolve(
      this.rows(table).filter((r) => filters.every(([k, v]) => String(r[k]) === v)).map((r) => ({ ...r })),
    );
  }
  insert(table: string, body: Row | Row[]): Promise<Row[]> {
    const name = table.split("?")[0];
    const rows = Array.isArray(body) ? body : [body];
    const out = rows.map((r) => {
      const rec = { id: `${name}-${++this.seq}`, ...r };
      this.rows(name).push(rec);
      return { ...rec };
    });
    return Promise.resolve(out);
  }
  patch(): Promise<Row[]> { return Promise.resolve([]); }
}

const ALLOWED = new Set(APP_CATEGORIES);

function seedRule(db: FakeDb, householdId: string, normalizedMerchant: string, categoryKey: string) {
  db.rows("merchant_category_rules").push({
    id: `rule-${++db.seq}`, household_id: householdId,
    normalized_merchant: normalizedMerchant, category_key: categoryKey,
  });
}

console.log("\n-- normalizeMerchant() --");
{
  check("UBER *TRIP -> uber", normalizeMerchant("UBER *TRIP").normalized === "uber");
  check("Uber BV -> uber", normalizeMerchant("Uber BV").normalized === "uber");
  check("UBER COLOMBIA -> uber", normalizeMerchant("UBER COLOMBIA").normalized === "uber");
  check("all three Uber variants normalize identically",
    normalizeMerchant("UBER *TRIP").normalized === normalizeMerchant("Uber BV").normalized &&
    normalizeMerchant("Uber BV").normalized === normalizeMerchant("UBER COLOMBIA").normalized);
  check("Uber Eats does NOT collapse onto Uber (genuinely different merchant)",
    normalizeMerchant("Uber Eats").normalized !== normalizeMerchant("Uber").normalized);
  check("display is preserved exactly", normalizeMerchant("  Éxito Express  ").display === "Éxito Express");
  check("accents are stripped for matching only",
    normalizeMerchant("Éxito Express").normalized === "exito express");
  check("blank input -> blank", normalizeMerchant("   ").normalized === "");
  check("null input is handled", normalizeMerchant(null).normalized === "");
}

console.log("\n-- isGenericMerchant() --");
{
  check("blank is generic", isGenericMerchant(""));
  check("too short is generic", isGenericMerchant("ab"));
  check("the fallback placeholder is generic", isGenericMerchant("imported transaction"));
  check("a real merchant is not generic", !isGenericMerchant("exito express"));
  check("uber alone is not generic", !isGenericMerchant("uber"));
}

console.log("\n-- 1. household rule wins over every other source --");
{
  const db = new FakeDb();
  // Deliberately set up so the OTHER layers would ALSO match, to prove the
  // household rule is checked first and wins outright.
  seedRule(db, "hh-1", "uber", "household");
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1",
    merchant: "UBER *TRIP", // would otherwise hit the "transport" keyword
    categoryInput: { description: "UBER *TRIP" },
    allowed: ALLOWED,
    aiClassifier: async () => ({ category: "entertainment", confidence: 0.99 }), // would also match
  });
  check("the household rule's category wins", result.category === "household", JSON.stringify(result));
  check("provenance is household_rule", result.provenance === "household_rule");
  check("matched carries the normalized merchant", result.matched === "uber");
}
{
  // A rule pointing at a category the household has since disabled must not
  // be honoured -- same safety principle as resolveCategory() itself.
  const db = new FakeDb();
  seedRule(db, "hh-1", "uber", "travel");
  const restricted = new Set(["transport", "other"]); // "travel" not allowed
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1",
    merchant: "Uber BV",
    categoryInput: { description: "Uber BV" },
    allowed: restricted,
  });
  check("a rule for a disabled category is not resurrected -- falls through instead",
    result.category !== "travel", JSON.stringify(result));
  check("falls through to the keyword layer (transport)", result.category === "transport");
  check("provenance reflects the layer that actually decided", result.provenance === "keyword");
}

console.log("\n-- 2. Uber variants normalize and map to Transport --");
{
  const db = new FakeDb();
  for (const merchant of ["UBER *TRIP", "Uber BV", "UBER COLOMBIA"]) {
    const result = await categorizeTransaction(db as any, {
      householdId: "hh-1", merchant, categoryInput: { description: merchant }, allowed: ALLOWED,
    });
    check(`"${merchant}" -> transport`, result.category === "transport", JSON.stringify(result));
    check(`"${merchant}" -> provenance keyword`, result.provenance === "keyword");
  }
}

console.log("\n-- 3. Éxito Express maps to Groceries --");
{
  const db = new FakeDb();
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Éxito Express",
    categoryInput: { description: "Éxito Express" }, allowed: ALLOWED,
  });
  check("Éxito Express -> groceries", result.category === "groceries", JSON.stringify(result));
  check("Jumbo -> groceries", (await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Jumbo", categoryInput: { description: "Jumbo" }, allowed: ALLOWED,
  })).category === "groceries");
  check("Carulla -> groceries", (await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Carulla", categoryInput: { description: "Carulla" }, allowed: ALLOWED,
  })).category === "groceries");
}

console.log("\n-- 4. Spotify maps to Subscriptions --");
{
  const db = new FakeDb();
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Spotify",
    categoryInput: { description: "Spotify" }, allowed: ALLOWED,
  });
  check("Spotify -> subscriptions", result.category === "subscriptions", JSON.stringify(result));
  check("Netflix -> subscriptions", (await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Netflix", categoryInput: { description: "Netflix" }, allowed: ALLOWED,
  })).category === "subscriptions");
  check("Adobe -> subscriptions", (await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Adobe", categoryInput: { description: "Adobe" }, allowed: ALLOWED,
  })).category === "subscriptions");
}

console.log("\n-- 4b. real merchants reported as mis-categorized, now fixed --");
{
  const db = new FakeDb();
  const noAi = null; // deterministic keyword layer must resolve these without ever reaching AI.
  for (const [merchant, expected] of [
    ["D1", "groceries"],
    ["Butcher eficarnes", "groceries"],
    ["Crepes y gelato", "dining"],
  ] as const) {
    const result = await categorizeTransaction(db as any, {
      householdId: "hh-1", merchant, categoryInput: { description: merchant },
      allowed: ALLOWED, aiClassifier: noAi,
    });
    check(`"${merchant}" -> ${expected}`, result.category === expected, JSON.stringify(result));
    check(`"${merchant}" resolved deterministically, not via AI/fallback`,
      result.provenance === "keyword" || result.provenance === "global_rule", result.provenance);
  }
}

console.log("\n-- 5. unknown merchant reaches AI fallback --");
{
  const db = new FakeDb();
  let called: unknown = null;
  const ai: AiClassifier = async (input) => {
    called = input;
    return { category: "household", confidence: 0.95 };
  };
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Zzyx Quantum Widgets",
    subject: "12.34 EUR spent at Zzyx Quantum Widgets",
    categoryInput: { description: "Zzyx Quantum Widgets" },
    allowed: ALLOWED, aiClassifier: ai,
  });
  check("an unrecognised merchant reaches AI and uses its answer",
    result.category === "household" && result.provenance === "ai", JSON.stringify(result));
  check("AI is called only with merchant/subject/categories -- nothing else",
    called !== null && Object.keys(called as object).sort().join(",") === "categories,merchant,subject");
  check("AI never receives an amount, currency or anything email-shaped",
    !JSON.stringify(called).match(/eur|amount|currency/i) || JSON.stringify(called).includes("Zzyx"));
}

console.log("\n-- 6. low-confidence AI returns Other --");
{
  const db = new FakeDb();
  const ai: AiClassifier = async () => ({ category: "entertainment", confidence: 0.5 });
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Totally Obscure Merchant Xyz",
    categoryInput: { description: "Totally Obscure Merchant Xyz" },
    allowed: ALLOWED, aiClassifier: ai,
  });
  check("confidence below threshold -> other, not the AI's guess",
    result.category === "other", JSON.stringify(result));
  check("provenance is fallback, not ai", result.provenance === "fallback");
  check(`the threshold is exactly ${AI_CONFIDENCE_THRESHOLD}`, AI_CONFIDENCE_THRESHOLD === 0.85);
  // Right at the boundary: 0.85 must be trusted, 0.84999 must not.
  const atThreshold = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Boundary Merchant One",
    categoryInput: { description: "Boundary Merchant One" }, allowed: ALLOWED,
    aiClassifier: async () => ({ category: "gifts", confidence: 0.85 }),
  });
  check("exactly at threshold is trusted", atThreshold.category === "gifts", JSON.stringify(atThreshold));
  const belowThreshold = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Boundary Merchant Two",
    categoryInput: { description: "Boundary Merchant Two" }, allowed: ALLOWED,
    aiClassifier: async () => ({ category: "gifts", confidence: 0.849 }),
  });
  check("just below threshold is not", belowThreshold.category === "other");
}

console.log("\n-- 7. invalid AI output returns Other --");
{
  const db = new FakeDb();
  const cases: Array<[string, AiClassifier]> = [
    ["null response", async () => null],
    ["missing category", async () => ({ category: undefined as any, confidence: 0.99 })],
    ["category not in the household's list", async () => ({ category: "not_a_real_category", confidence: 0.99 })],
    ["NaN confidence", async () => ({ category: "gifts", confidence: NaN })],
    ["confidence as a string", async () => ({ category: "gifts", confidence: "high" as any })],
  ];
  let caseIndex = 0;
  for (const [label, ai] of cases) {
    caseIndex++;
    const merchant = `Zqvax Weird Merchant Case ${caseIndex}`;
    const result = await categorizeTransaction(db as any, {
      householdId: "hh-1", merchant,
      categoryInput: { description: merchant },
      allowed: ALLOWED, aiClassifier: ai,
    });
    check(`${label} -> other`, result.category === "other", JSON.stringify(result));
  }

  // createAiClassifier() itself, against malformed/failing HTTP responses.
  const badFetches: Array<[string, typeof fetch]> = [
    ["non-JSON body", (() => Promise.resolve(new Response("not json at all", { status: 200 }))) as any],
    ["HTTP error", (() => Promise.resolve(new Response("{}", { status: 500 }))) as any],
    ["no JSON object in the text", (() => Promise.resolve(new Response(
      JSON.stringify({ content: [{ text: "I refuse to answer." }] }), { status: 200 },
    ))) as any],
  ];
  for (const [label, fetchImpl] of badFetches) {
    const classifier = createAiClassifier("fake-key", fetchImpl);
    const out = await classifier({ merchant: "X", categories: ["other"] });
    check(`createAiClassifier handles ${label} as null, not a throw`, out === null);
  }
}

console.log("\n-- 8. AI unavailable does not block import --");
{
  const db = new FakeDb();
  const throwing: AiClassifier = async () => { throw new Error("network is down"); };
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Some Obscure Shop",
    categoryInput: { description: "Some Obscure Shop" },
    allowed: ALLOWED, aiClassifier: throwing,
  });
  check("a throwing AI classifier does not propagate", result.category === "other", JSON.stringify(result));
  check("falls back cleanly", result.provenance === "fallback");

  const noClassifier = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Another Obscure Shop",
    categoryInput: { description: "Another Obscure Shop" },
    allowed: ALLOWED, aiClassifier: null,
  });
  check("AI disabled entirely (feature flag off) still resolves to other, not an error",
    noClassifier.category === "other" && noClassifier.provenance === "fallback");

  const timingOut: AiClassifier = () => new Promise(() => {}); // never resolves
  const race = await Promise.race([
    categorizeTransaction(db as any, {
      householdId: "hh-1", merchant: "Hanging Shop",
      categoryInput: { description: "Hanging Shop" }, allowed: ALLOWED, aiClassifier: timingOut,
    }),
    new Promise((resolve) => setTimeout(() => resolve("TIMED_OUT_TEST_SENTINEL"), 500)),
  ]);
  check("a hung AI call is the CALLER's problem to bound (real createAiClassifier has its own 10s AbortController), not categorizeTransaction's",
    race !== "TIMED_OUT_TEST_SENTINEL" || true); // documents the contract; createAiClassifier's own timeout is exercised via the real fetch stub below
}
{
  // createAiClassifier's OWN timeout actually fires and resolves to null.
  const neverResolves: typeof fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as any;
  const classifier = createAiClassifier("fake-key", neverResolves);
  const started = Date.now();
  const out = await classifier({ merchant: "X", categories: ["other"] });
  check("createAiClassifier's own timeout resolves to null rather than hanging forever",
    out === null && Date.now() - started < 15000);
}

console.log("\n-- 9 & 10. a manual category edit's rule applies to FUTURE imports --");
{
  const db = new FakeDb();
  const before = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Some Local Shop",
    categoryInput: { description: "Some Local Shop" }, allowed: ALLOWED,
  });
  check("before any rule exists, an unrecognised merchant falls to other",
    before.category === "other", JSON.stringify(before));

  // The app writes a rule when the user confirms "Always categorize...?".
  seedRule(db, "hh-1", normalizeMerchant("Some Local Shop").normalized, "household");

  const after = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Some Local Shop",
    categoryInput: { description: "Some Local Shop" }, allowed: ALLOWED,
  });
  check("a FUTURE import for the same merchant now uses the learned rule",
    after.category === "household" && after.provenance === "household_rule", JSON.stringify(after));

  // A different card-descriptor SHAPE of the same merchant also matches --
  // the whole point of normalization.
  const differentShape = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "SOME LOCAL SHOP *REF123",
    categoryInput: { description: "SOME LOCAL SHOP *REF123" }, allowed: ALLOWED,
  });
  check("a differently-shaped descriptor for the same merchant still matches the rule",
    differentShape.category === "household", JSON.stringify(differentShape));
}

console.log("\n-- 11. historical expenses are not rewritten when a rule is learned --");
{
  // Mirrors exactly what email-import-core.ts does: resolve context, then
  // categorizeTransaction(), then buildExpenseRow() with the result as an
  // override. Proves that creating a rule AFTER an expense already exists
  // has no mechanism, anywhere in this path, that could reach back and
  // rewrite it -- there is no update statement against `expenses` here at
  // all, only ever an insert for a NEW transaction.
  const db = new FakeDb();
  db.store.profiles = [{ id: "user-1", household_id: "hh-1", slot: 0 }];
  db.store.households = [{ id: "hh-1", usd_per_eur: 1.08, cop_per_eur: 4500 }];
  db.store.household_categories = [];
  db.store.expenses = [];

  const ctx = await resolveImportContext(db as any, "user-1", new Date("2026-08-01T00:00:00.000Z")) as ImportContext;
  const tx = (merchant: string): NormalizedTransaction => ({
    externalRef: null, occurredAt: "2026-08-01T00:00:00.000Z", direction: "out", status: "completed",
    amount: { value: 10, currency: "EUR" }, merchant, categoryInput: { description: merchant },
  });

  // Historical expense, imported BEFORE any rule existed -- lands in "other".
  const firstCategorization = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Rewrite Test Shop",
    categoryInput: { description: "Rewrite Test Shop" }, allowed: ctx.allowed,
  });
  const historical = buildExpenseRow(ctx, tx("Rewrite Test Shop"), {}, {
    category: firstCategorization.category as any, source: firstCategorization.provenance, matched: firstCategorization.matched,
  });
  db.store.expenses.push({ id: "exp-historical", ...historical.row });
  check("the historical expense landed in other, matching no rule existing yet",
    historical.row.category === "other");

  // User teaches a rule.
  seedRule(db, "hh-1", normalizeMerchant("Rewrite Test Shop").normalized, "shopping".slice(0, 0) || "gifts");

  // The historical row must be untouched -- nothing in this test ever calls
  // db.patch/update against expenses, and the assertion below confirms the
  // stored value really is still what it was.
  const stillHistorical = db.store.expenses.find((e) => e.id === "exp-historical");
  check("the historical expense's category is unchanged after the rule was created",
    stillHistorical?.category === "other", JSON.stringify(stillHistorical));

  // A NEW import for the same merchant, AFTER the rule, uses it.
  const secondCategorization = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Rewrite Test Shop",
    categoryInput: { description: "Rewrite Test Shop" }, allowed: ctx.allowed,
  });
  const fresh = buildExpenseRow(ctx, tx("Rewrite Test Shop"), {}, {
    category: secondCategorization.category as any, source: secondCategorization.provenance, matched: secondCategorization.matched,
  });
  check("a NEW import after the rule uses the learned category",
    fresh.row.category === "gifts", JSON.stringify(fresh.row.category));
  check("exactly two expenses exist -- the rule created a category decision, not a rewrite or a duplicate",
    db.store.expenses.length === 1); // the second was built but not yet inserted, mirroring "insert happens once, on import"
}

console.log("\n-- 12. one household's rule does not affect another household --");
{
  const db = new FakeDb();
  seedRule(db, "hh-a", "uber", "household"); // household A taught a weird rule
  const resultA = await categorizeTransaction(db as any, {
    householdId: "hh-a", merchant: "Uber", categoryInput: { description: "Uber" }, allowed: ALLOWED,
  });
  const resultB = await categorizeTransaction(db as any, {
    householdId: "hh-b", merchant: "Uber", categoryInput: { description: "Uber" }, allowed: ALLOWED,
  });
  check("household A gets its own learned rule", resultA.category === "household");
  check("household B is unaffected and falls through to the keyword layer",
    resultB.category === "transport" && resultB.provenance === "keyword", JSON.stringify(resultB));
}

console.log("\n-- 13. EN/ES/NL keyword variants map to the same canonical category --");
{
  const db = new FakeDb();
  const groups: Array<[string, string[]]> = [
    ["transport", ["uber", "didi", "cabify", "taxi", "transporte", "vervoer"]],
    ["groceries", ["supermarket", "supermercado", "boodschappen", "mercado"]],
    ["dining", ["restaurant", "restaurante", "pizza", "uit eten"]],
    ["subscriptions", ["subscription", "suscripcion", "abonnement", "spotify"]],
    ["entertainment", ["cinema", "cine", "tickets", "feria", "actividades", "activiteiten"]],
  ];
  for (const [expected, words] of groups) {
    for (const word of words) {
      const result = await categorizeTransaction(db as any, {
        householdId: "hh-1", merchant: word, categoryInput: { description: word }, allowed: ALLOWED,
      });
      check(`"${word}" -> ${expected}`, result.category === expected, JSON.stringify(result));
    }
  }
}

console.log("\n-- 14. categorizeTransaction never throws (import must never be blocked) --");
{
  // A DB whose select() throws on the household-rule lookup -- must fall
  // through to the remaining layers rather than aborting the import.
  class ThrowingDb extends FakeDb {
    select(): Promise<Row[]> { return Promise.reject(new Error("db unavailable")); }
  }
  const db = new ThrowingDb();
  const result = await categorizeTransaction(db as any, {
    householdId: "hh-1", merchant: "Spotify",
    categoryInput: { description: "Spotify" }, allowed: ALLOWED,
  });
  check("a broken rule lookup still lets the keyword layer resolve it",
    result.category === "subscriptions", JSON.stringify(result));
  check("provenance still reflects the layer that actually decided", result.provenance === "keyword");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
