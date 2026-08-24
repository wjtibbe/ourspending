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

import { resolveCategory, APP_CATEGORIES, type AppCategory, type CategoryInput } from "./categories.ts";

export type Row = Record<string, unknown>;

/** The narrow PostgREST surface this module needs. _shared/rest.ts satisfies it. */
export interface Db {
  select(path: string): Promise<Row[]>;
  insert(table: string, body: Row | Row[], prefer?: string): Promise<Row[]>;
  patch(path: string, body: Row, prefer?: string): Promise<Row[]>;
}

/**
 * PostgREST filter-value escaping. Exported so the modules layered on top of
 * this one can build queries without importing _shared/rest.ts, which reads
 * the service-role key from the environment at module scope. Those modules
 * receive their Db by parameter and must stay independent of how it was
 * constructed.
 */
export const q = (v: string) => encodeURIComponent(v);

// ---------------------------------------------------------------------------
// The neutral contract
// ---------------------------------------------------------------------------

export type Money = { value: number; currency: string };

export type NormalizedTransaction = {
  /** Stable provider-side identifier, when the source supplies one. */
  externalRef: string | null;
  /** ISO 8601, or null when the source gives no usable timestamp. */
  occurredAt: string | null;
  /**
   * When the DELIVERING system received the notification -- Gmail's
   * internalDate for a polled message. Optional so existing callers are
   * unaffected. Used only when occurredAt is absent, and always preferred over
   * the sync clock because it is a stable property of the message: a retry
   * re-derives the same value and therefore the same calendar day.
   */
  receivedAt?: string | null;
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
  /**
   * IANA zone the household's calendar days are measured in, e.g.
   * "America/Bogota". Falls back to UTC when unset, which is exactly the old
   * behaviour, so an unconfigured household sees no change.
   */
  timezone: string;
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

/** IANA zone used for a household's calendar days. UTC when unset. */
export const DEFAULT_TIMEZONE = "UTC";

/**
 * Reads households.timezone, best-effort.
 *
 * Deliberately a SEPARATE query rather than another column on the rates
 * select: `timezone` is added by a later migration, and PostgREST rejects the
 * WHOLE request when it names an unknown column. Folding it into the rates
 * query would therefore turn "migration not applied yet" into "every import
 * fails", so this isolates that risk and falls back to UTC -- which is exactly
 * the behaviour that existed before timezones were considered at all.
 */
export async function householdTimezone(db: Db, householdId: string): Promise<string> {
  try {
    const rows = await db.select(
      `households?id=eq.${q(householdId)}&select=timezone&limit=1`,
    );
    const tz = rows[0]?.timezone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

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
    timezone: await householdTimezone(db, householdId),
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
  /** The authoritative instant the transaction happened, ISO-8601 UTC. */
  occurred_at: string;
  /** Which source that instant came from -- see OccurredAtSource. */
  occurred_at_source: OccurredAtSource;
};

/** Caller-supplied audit labels. Optional: import-core itself stays provider-neutral. */
export type ImportProvenance = {
  sourceProvider?: string | null;
  conversionSource?: string | null;
};

/**
 * A category already decided by a caller -- e.g. the layered household-rule
 * / global-mapping / keyword / AI pipeline in
 * _shared/merchant-categorization.ts -- bypassing resolveCategory() entirely.
 *
 * Optional and fully backward compatible: every existing caller that has
 * never heard of this (every test in import-core.test.ts included) omits it
 * and gets exactly today's behaviour. `source` is caller-defined free text --
 * import-core does not interpret it beyond the literal string "fallback",
 * which is what makes `categoryFallback` in ImportOutcome true. Passing the
 * SAME string a caller intends to store as categorisation provenance (e.g.
 * "household_rule") means one value flows end to end with no translation
 * step and no second place that can drift out of sync with the first.
 */
export type CategoryOverride = {
  category: AppCategory;
  source: string;
  matched: string | null;
};

/**
 * Which instant a transaction actually happened at, and how confident we are.
 *
 *   wise_explicit        the email itself carried a transaction timestamp
 *   gmail_internal_date  when Gmail received the notification -- within
 *                        seconds of the payment in practice
 *   sync_fallback        neither existed; the time the sync ran
 *
 * The order matters more than it looks. `sync_fallback` is the only source
 * that is not a property of the transaction: it changes every run, so a retry
 * would move an expense to a different day than its first attempt. Preferring
 * Gmail's internalDate -- which is stable for a given message forever -- is
 * what makes a retry reproduce the same date.
 */
export type OccurredAtSource = "wise_explicit" | "gmail_internal_date" | "sync_fallback";

export type ResolvedOccurredAt = {
  /** The authoritative instant, ISO-8601 UTC. */
  occurredAt: string;
  source: OccurredAtSource;
};

const validDate = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = new Date(typeof v === "number" ? v : String(v));
  return isNaN(d.getTime()) ? null : d;
};

/** Applies the precedence above. Never throws. */
export function resolveOccurredAt(
  tx: NormalizedTransaction,
  fallback: Date,
): ResolvedOccurredAt {
  const explicit = validDate(tx.occurredAt);
  if (explicit) return { occurredAt: explicit.toISOString(), source: "wise_explicit" };

  const received = validDate(tx.receivedAt);
  if (received) return { occurredAt: received.toISOString(), source: "gmail_internal_date" };

  return { occurredAt: fallback.toISOString(), source: "sync_fallback" };
}

/**
 * The calendar day an instant falls on, IN A GIVEN ZONE.
 *
 * `toISOString().slice(0, 10)` -- what this used to do -- is the UTC day, which
 * silently moves a late-evening purchase in a negative-offset zone onto the
 * NEXT day: 23:40 in America/Bogota is 04:40 UTC tomorrow. Intl is used rather
 * than manual offset arithmetic because it knows the zone's DST history; the
 * "en-CA" locale is chosen because it formats as YYYY-MM-DD natively.
 *
 * Falls back to the UTC day if the zone is unknown, so a typo in a household's
 * configuration degrades to the old behaviour instead of failing an import.
 */
export function calendarDayIn(instant: Date | string, timezone: string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * YYYY-MM-DD for the app's `spent_on` column, in the household's zone.
 *
 * `timezone` is optional so every pre-existing caller keeps working unchanged
 * and keeps getting the UTC day.
 */
export function spentOn(
  tx: NormalizedTransaction,
  fallback: Date,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  return calendarDayIn(resolveOccurredAt(tx, fallback).occurredAt, timezone);
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
  categoryOverride?: CategoryOverride,
): { row: ExpenseRow; category: { category: AppCategory; source: string; matched: string | null } } {
  const rate = perEur(tx.amount.currency, ctx.rates);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("missing_household_rate");

  const category = categoryOverride ?? resolveCategory(tx.categoryInput, ctx.allowed);
  const occurred = resolveOccurredAt(tx, ctx.now);

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
      // Resolved once, so the stored instant and the calendar day derived
      // from it can never disagree.
      spent_on: calendarDayIn(occurred.occurredAt, ctx.timezone ?? DEFAULT_TIMEZONE),
      created_by: ctx.userId,
      merchant_amount: hadConversion ? tx.merchantAmount!.value : null,
      merchant_currency: hadConversion ? tx.merchantAmount!.currency : null,
      had_currency_conversion: hadConversion,
      amount_authority: "deducted_balance_amount",
      occurred_at: occurred.occurredAt,
      occurred_at_source: occurred.source,
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
  categoryOverride?: CategoryOverride,
): Promise<ImportOutcome> {
  try {
    const { row, category } = buildExpenseRow(ctx, tx, provenance, categoryOverride);
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
