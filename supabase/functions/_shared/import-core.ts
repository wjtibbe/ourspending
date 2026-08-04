// Provider-neutral transaction import.
//
// This module knows nothing about Wise, Resend, Gmail, email HTML or balance
// statements. It accepts a NormalizedTransaction and owns the parts that must
// behave identically no matter where a transaction came from:
//
//   * the household is re-derived from the owner's CURRENT profile, never
//     taken from a request payload or a stale connection row;
//   * the payer slot is resolved from that same profile and never defaulted,
//     because guessing it would misattribute money between household members;
//   * currency support is enforced (EUR/USD/COP) rather than guessed at;
//   * EUR conversion matches app.js exactly, so an imported expense and a
//     typed one convert the same way;
//   * category mapping goes through the shared mapper, honouring categories
//     the household has switched off;
//   * the expense is SHARED, with the importing user as payer, and stays
//     editable in the normal expense screen.
//
// What is deliberately NOT here: the ledger. Each input method has its own
// ledger table with its own dedupe columns (an API sync dedupes on a provider
// reference; an inbound email dedupes on message ids too). The caller claims
// its own ledger row and then calls into this module, so the "which row is
// this" question stays with the code that knows the answer.

import { resolveCategory, APP_CATEGORIES, type CategoryInput } from "./categories.ts";

export type Row = Record<string, unknown>;

/** The narrow PostgREST surface this module needs. _shared/rest.ts satisfies it. */
export interface Db {
  select(path: string): Promise<Row[]>;
  insert(table: string, body: Row | Row[], prefer?: string): Promise<Row[]>;
  patch(path: string, body: Row, prefer?: string): Promise<Row[]>;
}

const q = (v: string) => encodeURIComponent(v);

// ---------------------------------------------------------------------------
// The neutral contract
// ---------------------------------------------------------------------------

export type Money = { value: number; currency: string };

export type NormalizedTransaction = {
  /** Stable provider-side identifier, when the source supplies one. */
  externalRef: string | null;
  /** ISO 8601, or null when the source gives no usable timestamp. */
  occurredAt: string | null;
  direction: "out" | "in";
  status: "completed" | "declined" | "reversed" | "refund" | "unknown";
  /** What actually left the account, in the account's own currency. */
  amount: Money;
  /** The merchant's own amount when a conversion happened. Metadata only. */
  merchantAmount?: Money;
  merchant: string | null;
  categoryInput: CategoryInput;
  /** Free-form provenance for the ledger. Never used for decisions. */
  sourceMetadata?: Record<string, unknown>;
};

// The app's expense.currency values. Anything else is skipped rather than
// converted with a rate the app does not hold.
export const SUPPORTED_CURRENCIES = new Set(["EUR", "USD", "COP"]);

// ---------------------------------------------------------------------------
// Context: household, payer slot, rates, enabled categories
// ---------------------------------------------------------------------------

export type ImportContext = {
  userId: string;
  householdId: string;
  /** 0 or 1 — the household member slot that owns this input method. */
  slot: number;
  rates: { usd: number; cop: number };
  allowed: Set<string>;
  now: Date;
};

export type ContextFailure = { error: "no_household" | "unresolved_slot" };

export const isContextFailure = (
  v: ImportContext | ContextFailure,
): v is ContextFailure => "error" in v;

/** Mirrors perEur() in app.js, so imported rows convert exactly like typed ones. */
export function perEur(currency: string, rates: { usd: number; cop: number }): number {
  if (currency === "EUR") return 1;
  if (currency === "USD") return rates.usd;
  if (currency === "COP") return rates.cop;
  throw new Error("unsupported_currency");
}

/**
 * The categories this household actually has switched on. The override model
 * is sparse: no rows means every built-in is active, and only rows with
 * active=false hide one. Mapping never resurrects a disabled category.
 */
export async function allowedCategories(db: Db, householdId: string): Promise<Set<string>> {
  const allowed = new Set<string>(APP_CATEGORIES);
  try {
    const rows = await db.select(
      `household_categories?household_id=eq.${q(householdId)}&select=category_key,active,is_custom`,
    );
    for (const r of rows) {
      if (r.active === false && r.is_custom !== true) allowed.delete(String(r.category_key));
    }
  } catch {
    // A category-lookup problem must never stop an import.
  }
  // "other" is the terminal fallback and always remains available.
  allowed.add("other");
  return allowed;
}

/**
 * Resolves everything an import needs about the owning user, from the database
 * only. Nothing here is accepted from a caller-supplied payload.
 */
export async function resolveImportContext(
  db: Db,
  userId: string,
  now: Date,
): Promise<ImportContext | ContextFailure> {
  const profiles = await db.select(
    `profiles?id=eq.${q(userId)}&select=household_id,slot&limit=1`,
  );
  const householdId = profiles[0]?.household_id ? String(profiles[0].household_id) : null;
  if (!householdId) return { error: "no_household" };

  // Never defaulted: an imported expense is SHARED, so `payer` decides who the
  // household owes. A wrong slot silently moves money between two people.
  const slotRaw = profiles[0]?.slot;
  const slot = slotRaw === 0 || slotRaw === 1 ? Number(slotRaw) : null;
  if (slot === null) return { error: "unresolved_slot" };

  const households = await db.select(
    `households?id=eq.${q(householdId)}&select=usd_per_eur,cop_per_eur&limit=1`,
  );

  return {
    userId,
    householdId,
    slot,
    rates: {
      usd: Number(households[0]?.usd_per_eur ?? 0),
      cop: Number(households[0]?.cop_per_eur ?? 0),
    },
    allowed: await allowedCategories(db, householdId),
    now,
  };
}

// ---------------------------------------------------------------------------
// Classification — which normalized transactions become expenses
// ---------------------------------------------------------------------------

export type Classification =
  | { action: "import"; reason: null }
  | { action: "skip"; reason: string };

/**
 * Only completed OUTGOING spend becomes an expense. Everything else is
 * recorded with a reason and skipped: declined and reversed payments never
 * happened, refunds are money coming back (not a negative expense), and
 * incoming transfers are not spending at all.
 *
 * Pure and total — safe to call on anything a parser produced.
 */
export function classifyNormalized(tx: NormalizedTransaction): Classification {
  if (tx.direction === "in") return { action: "skip", reason: "incoming" };
  if (tx.status !== "completed") return { action: "skip", reason: `status_${tx.status}` };
  if (!SUPPORTED_CURRENCIES.has(tx.amount.currency)) {
    return { action: "skip", reason: `unsupported_currency_${tx.amount.currency}` };
  }
  if (!Number.isFinite(tx.amount.value) || tx.amount.value <= 0) {
    // The app stores expenses as positive amounts (AddExpense rejects <= 0).
    return { action: "skip", reason: "non_positive_amount" };
  }
  return { action: "import", reason: null };
}

// ---------------------------------------------------------------------------
// Expense construction
// ---------------------------------------------------------------------------

export type ExpenseRow = {
  household_id: string;
  amount_orig: number;
  currency: string;
  amount_eur: number;
  rate_used: number;
  kind: string;
  payer: number;
  category: string;
  note: string;
  spent_on: string;
  created_by: string;
  // The merchant's own amount, kept ONLY for display/audit -- never the
  // authoritative amount, never summed on its own. Null unless a real
  // conversion happened (see had_currency_conversion).
  merchant_amount: number | null;
  merchant_currency: string | null;
  // True only when merchant_currency differs from currency: a provider that
  // echoes the same currency in both fields made no conversion, and no
  // merchant amount is invented for it.
  had_currency_conversion: boolean;
  // amount_orig/currency is ALWAYS what left the account -- a fact of the
  // NormalizedTransaction contract, not a per-provider guess. Recorded so a
  // later rate update is never mistaken for a reason to recompute this row.
  amount_authority: "deducted_balance_amount";
  source_provider: string | null;
  conversion_source: string | null;
};

/** Caller-supplied audit labels. Optional: import-core itself stays provider-neutral. */
export type ImportProvenance = {
  sourceProvider?: string | null;
  conversionSource?: string | null;
};

/** YYYY-MM-DD for the app's `spent_on` date column. */
export function spentOn(tx: NormalizedTransaction, fallback: Date): string {
  const d = tx.occurredAt ? new Date(tx.occurredAt) : null;
  const use = d && !isNaN(d.getTime()) ? d : fallback;
  return use.toISOString().slice(0, 10);
}

/**
 * Builds the exact expenses row for a transaction. Pure, so the ownership and
 * conversion rules can be asserted directly in tests without a database.
 *
 * `tx.amount` is ALWAYS what actually left the account, and is ALWAYS what
 * becomes `amount_orig`/`currency` -- never recalculated, never replaced by a
 * later exchange rate. `tx.merchantAmount` is stored alongside it purely as
 * display/audit metadata, ONLY when it names a genuinely different currency
 * (a real conversion); it never creates a second expense and never becomes
 * the authoritative amount.
 */
export function buildExpenseRow(
  ctx: ImportContext,
  tx: NormalizedTransaction,
  provenance: ImportProvenance = {},
): { row: ExpenseRow; category: ReturnType<typeof resolveCategory> } {
  const rate = perEur(tx.amount.currency, ctx.rates);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("missing_household_rate");

  const category = resolveCategory(tx.categoryInput, ctx.allowed);

  // A real conversion only when the merchant's own amount is in a DIFFERENT
  // currency from what was actually deducted -- a provider that echoes the
  // same currency in both fields made a direct, unconverted payment, and no
  // merchant amount is invented for it.
  const hadConversion = !!tx.merchantAmount && tx.merchantAmount.currency !== tx.amount.currency;

  return {
    category,
    row: {
      household_id: ctx.householdId,
      amount_orig: tx.amount.value,
      currency: tx.amount.currency,
      amount_eur: Math.round((tx.amount.value / rate) * 100) / 100,
      rate_used: rate,
      // Imported spend is a SHARED household expense using the app's own
      // convention: "shared" means the household splits it, and `payer`
      // records which member actually paid. Fully editable afterwards.
      kind: "shared",
      payer: ctx.slot,
      category: category.category,
      note: (tx.merchant ?? "Imported transaction").slice(0, 60),
      spent_on: spentOn(tx, ctx.now),
      created_by: ctx.userId,
      merchant_amount: hadConversion ? tx.merchantAmount!.value : null,
      merchant_currency: hadConversion ? tx.merchantAmount!.currency : null,
      had_currency_conversion: hadConversion,
      amount_authority: "deducted_balance_amount",
      source_provider: provenance.sourceProvider ?? null,
      conversion_source: provenance.conversionSource ?? null,
    },
  };
}

export type ImportOutcome =
  | { status: "imported"; expenseId: string | null; category: string; categoryFallback: boolean }
  | { status: "failed"; reason: string };

/**
 * Creates the expense. The caller is responsible for having claimed its own
 * ledger row first, and for recording this outcome against it — that keeps
 * crash-safe pending->imported recovery with the code that owns the table.
 */
export async function createExpense(
  db: Db,
  ctx: ImportContext,
  tx: NormalizedTransaction,
  provenance: ImportProvenance = {},
): Promise<ImportOutcome> {
  try {
    const { row, category } = buildExpenseRow(ctx, tx, provenance);
    const inserted = await db.insert("expenses", row);
    return {
      status: "imported",
      expenseId: inserted[0]?.id ? String(inserted[0].id) : null,
      category: category.category,
      categoryFallback: category.source === "fallback",
    };
  } catch (e) {
    return { status: "failed", reason: safeError(e) };
  }
}

/** Short, non-sensitive error label. Never a provider body, token or amount. */
export function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/[^a-zA-Z0-9_ .:-]/g, "").slice(0, 120);
}
