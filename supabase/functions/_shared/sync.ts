// The single synchronisation implementation.
//
// Both entry points use this: the hourly cron job (wise-sync) and the manual
// "Sync now" button (provider-connect). There is deliberately no second copy.
//
// Everything the Edge runtime provides — decryption, the Wise HTTP client, the
// clock — arrives through `deps`, so this module has no Deno globals and can be
// unit-tested directly.

import {
  categoryInputFrom, classifyTransaction, describeTransaction, resolveAmounts,
  transactionDate, transactionReference, WiseAuthError, type WiseClient, type WiseTx,
} from "./wise.ts";
import { APP_CATEGORIES, resolveCategory } from "./categories.ts";

export type Row = Record<string, unknown>;

/** The narrow PostgREST surface the core needs. rest.ts satisfies this. */
export interface Db {
  select(path: string): Promise<Row[]>;
  insert(table: string, body: Row | Row[], prefer?: string): Promise<Row[]>;
  patch(path: string, body: Row, prefer?: string): Promise<Row[]>;
}

export type ConnectionRow = { id: string; user_id: string; provider: string };

export type SyncDeps = {
  db: Db;
  /** Builds an authenticated Wise client for one connection (decrypts the token). */
  clientFor: (conn: ConnectionRow) => Promise<WiseClient>;
  now: () => Date;
  lookbackDays?: number;
};

export type ConnectionResult = {
  connectionId: string;
  status: "ok" | "error" | "skipped";
  /** Safe, enum-like reason. Never a raw provider message. */
  error: string | null;
  transactionsFetched: number;
  expensesImported: number;
  duplicatesSkipped: number;
  unsupportedSkipped: number;
  failed: number;
  /** Transactions dropped because Wise supplied no stable identifier. */
  missingStableId: number;
  categoryFallbacks: number;
};

export type SyncStats = {
  connectionsProcessed: number;
  transactionsFetched: number;
  expensesImported: number;
  duplicatesSkipped: number;
  unsupportedSkipped: number;
  failed: number;
  missingStableId: number;
  categoryFallbacks: number;
  connections: ConnectionResult[];
};

// The app's expense.currency values. A Wise balance in any other currency
// cannot be converted without a rate the app does not hold, so it is skipped
// rather than guessed at.
const SUPPORTED_CURRENCIES = new Set(["EUR", "USD", "COP"]);
const DEFAULT_LOOKBACK_DAYS = 14;

const q = (v: string) => encodeURIComponent(v);

const emptyResult = (connectionId: string): ConnectionResult => ({
  connectionId, status: "ok", error: null,
  transactionsFetched: 0, expensesImported: 0, duplicatesSkipped: 0,
  unsupportedSkipped: 0, failed: 0, missingStableId: 0, categoryFallbacks: 0,
});

/** Mirrors perEur() in app.js, so imported rows convert exactly like typed ones. */
function perEur(currency: string, rates: { usd: number; cop: number }): number {
  if (currency === "EUR") return 1;
  if (currency === "USD") return rates.usd;
  if (currency === "COP") return rates.cop;
  throw new Error("unsupported_currency");
}

/**
 * The categories this household actually has switched on. The override model
 * is sparse: no rows means every built-in is active, and only rows with
 * active=false hide one. Mapping never resurrects a category the household
 * chose to disable.
 */
async function allowedCategories(db: Db, householdId: string): Promise<Set<string>> {
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
 * Lists every balance across every profile the token can see. Falls back to
 * the older borderless-accounts shape when the modern endpoint yields nothing.
 */
async function listBalances(
  wise: WiseClient,
): Promise<Array<{ profileId: string; balanceId: string; currency: string }>> {
  const out: Array<{ profileId: string; balanceId: string; currency: string }> = [];
  const profiles = await wise.profiles();

  for (const p of profiles ?? []) {
    const profileId = String((p as Row).id ?? "");
    if (!profileId) continue;
    let balances: Row[] = [];
    try {
      balances = (await wise.balances(profileId)) as Row[];
    } catch {
      continue; // A profile with no balance access must not fail the others.
    }
    for (const b of balances ?? []) {
      const balanceId = String(b.id ?? "");
      // v4 balances expose `currency`; the older borderless shape nests it
      // under `amount`.
      const nested = b.amount && typeof b.amount === "object"
        ? (b.amount as Row).currency
        : undefined;
      const currency = String(b.currency ?? nested ?? "");
      if (balanceId && currency) {
        out.push({ profileId, balanceId, currency: currency.toUpperCase() });
      }
    }
  }
  return out;
}

/**
 * Synchronise one connection. Never throws for a single bad transaction: each
 * one is isolated so the rest of the statement still imports.
 */
export async function syncConnection(
  deps: SyncDeps,
  conn: ConnectionRow,
): Promise<ConnectionResult> {
  const result = emptyResult(conn.id);
  const db = deps.db;
  const now = deps.now();

  // The household is re-derived from the owner's CURRENT profile on every run,
  // never taken from the connection row, so a membership change can never
  // route transactions into a household the user has left.
  const profiles = await db.select(
    `profiles?id=eq.${q(conn.user_id)}&select=household_id,slot&limit=1`,
  );
  const householdId = profiles[0]?.household_id ? String(profiles[0].household_id) : null;
  const slotRaw = profiles[0]?.slot;
  if (!householdId) {
    return { ...result, status: "skipped", error: "no_household" };
  }

  // An imported expense is SHARED, so `payer` decides who the household owes.
  // Getting it wrong would misattribute money between the two members, so the
  // slot is resolved from the owner's own profile and never defaulted: an
  // unresolvable slot skips the connection rather than guessing p0.
  const slot = slotRaw === 0 || slotRaw === 1 ? Number(slotRaw) : null;
  if (slot === null) {
    return { ...result, status: "skipped", error: "unresolved_slot" };
  }

  const households = await db.select(
    `households?id=eq.${q(householdId)}&select=usd_per_eur,cop_per_eur&limit=1`,
  );
  const rates = {
    usd: Number(households[0]?.usd_per_eur ?? 0),
    cop: Number(households[0]?.cop_per_eur ?? 0),
  };

  const allowed = await allowedCategories(db, householdId);

  let wise: WiseClient;
  try {
    wise = await deps.clientFor(conn);
  } catch {
    return { ...result, status: "error", error: "decrypt_failed" };
  }

  let balances: Array<{ profileId: string; balanceId: string; currency: string }>;
  try {
    balances = await listBalances(wise);
  } catch (e) {
    // invalid_token / insufficient_permissions / wise_rate_limited come from
    // WiseAuthError.code (see _shared/wise.ts); anything else -- a 5xx or a
    // network failure -- is Wise's own availability, not the token's fault.
    return {
      ...result,
      status: "error",
      error: e instanceof WiseAuthError ? e.code : "provider_unreachable",
    };
  }

  const from = new Date(now.getTime() - (deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86400000);

  for (const bal of balances) {
    let transactions: WiseTx[] = [];
    try {
      const statement = await wise.statement(bal.profileId, bal.balanceId, bal.currency, from, now);
      transactions = Array.isArray(statement?.transactions) ? statement.transactions : [];
    } catch (e) {
      if (e instanceof WiseAuthError) {
        return { ...result, status: "error", error: e.code };
      }
      result.failed++;
      continue; // One unreadable balance must not stop the others.
    }

    result.transactionsFetched += transactions.length;

    for (const tx of transactions) {
      try {
        await processTransaction(
          { db, now, conn, householdId, slot, rates, allowed, bal },
          tx,
          result,
        );
      } catch (e) {
        // One malformed transaction never stops the rest of the statement.
        result.failed++;
        console.error("wise-sync: transaction failed:", safeError(e));
      }
    }
  }

  return result;
}

type Ctx = {
  db: Db;
  now: Date;
  conn: ConnectionRow;
  householdId: string;
  slot: number;
  rates: { usd: number; cop: number };
  allowed: Set<string>;
  bal: { profileId: string; balanceId: string; currency: string };
};

async function processTransaction(ctx: Ctx, tx: WiseTx, result: ConnectionResult) {
  const { db, conn } = ctx;
  const classification = classifyTransaction(tx);

  // No stable provider identifier means no safe idempotency key, and without
  // one a re-run could import the same spend twice. Record the anomaly, count
  // it, and move on to the next transaction — never import, never abort.
  const reference = transactionReference(tx);
  if (!reference) {
    console.error(
      "wise-sync: missing_stable_id on connection", conn.id,
      "balance", ctx.bal.balanceId,
      "detailType", classification.detailType ?? "unknown",
    );
    result.failed++;
    result.missingStableId++;
    return;
  }

  const baseRow: Row = {
    connection_id: conn.id,
    user_id: conn.user_id,
    household_id: ctx.householdId,
    wise_reference: reference,
    wise_profile_id: ctx.bal.profileId,
    wise_balance_id: ctx.bal.balanceId,
    occurred_at: readIso(tx),
    direction: classification.direction,
    wise_status: classification.status,
    detail_type: classification.detailType,
    raw_json: tx,
  };

  // ---- not an expense: record it so it is never re-evaluated, and move on ----
  if (classification.action === "skip") {
    const inserted = await insertIgnoringDuplicates(db, {
      ...baseRow,
      import_status: "skipped",
      skip_reason: classification.reason,
    });
    if (inserted) result.unsupportedSkipped++;
    else result.duplicatesSkipped++;
    return;
  }

  const amounts = resolveAmounts(tx);
  if (!SUPPORTED_CURRENCIES.has(amounts.balance.currency)) {
    const inserted = await insertIgnoringDuplicates(db, {
      ...baseRow,
      import_status: "skipped",
      skip_reason: `unsupported_currency_${amounts.balance.currency}`,
      amount_value: amounts.balance.value,
      amount_currency: amounts.balance.currency,
      amount_source_path: amounts.balance.path,
    });
    if (inserted) result.unsupportedSkipped++;
    else result.duplicatesSkipped++;
    return;
  }

  const category = resolveCategory(categoryInputFrom(tx), ctx.allowed);

  const row: Row = {
    ...baseRow,
    import_status: "pending_import",
    amount_value: amounts.balance.value,
    amount_currency: amounts.balance.currency,
    amount_source_path: amounts.balance.path,
    amount_low_confidence: amounts.lowConfidence,
    merchant_amount_value: amounts.source?.value ?? null,
    merchant_amount_currency: amounts.source?.currency ?? null,
    merchant_amount_source_path: amounts.source?.path ?? null,
    wise_category: firstString(tx, ["details.category", "details.merchant.category"]),
    mapped_category: category.category,
    category_source: category.source,
  };

  const inserted = await insertIgnoringDuplicates(db, row);
  let txRowId: string;

  if (inserted) {
    txRowId = String(inserted.id);
  } else {
    // Already seen. The one case worth retrying is a row that was written but
    // whose expense never landed (a crash between the two writes).
    const existing = await db.select(
      `wise_transactions?connection_id=eq.${q(conn.id)}` +
        `&wise_profile_id=eq.${q(ctx.bal.profileId)}` +
        `&wise_balance_id=eq.${q(ctx.bal.balanceId)}` +
        `&wise_reference=eq.${q(reference)}&select=id,import_status,expense_id&limit=1`,
    );
    const e = existing[0];
    if (!e || e.import_status !== "pending_import" || e.expense_id) {
      result.duplicatesSkipped++;
      return;
    }
    txRowId = String(e.id);
  }

  if (category.source === "fallback") result.categoryFallbacks++;

  try {
    const rate = perEur(amounts.balance.currency, ctx.rates);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("missing_household_rate");

    const expense = await db.insert("expenses", {
      household_id: ctx.householdId,
      amount_orig: amounts.balance.value,
      currency: amounts.balance.currency,
      amount_eur: Math.round((amounts.balance.value / rate) * 100) / 100,
      rate_used: rate,
      // Imported spend is a SHARED household expense, using the app's own
      // convention: kind "shared" means the household splits it, and `payer`
      // records which member actually paid. The slot is the connection
      // owner's, resolved from their profile above — never hardcoded. The
      // expense stays fully editable in the normal expense interface.
      kind: "shared",
      payer: ctx.slot,
      category: category.category,
      note: describeTransaction(tx),
      spent_on: transactionDate(tx, ctx.now),
      created_by: conn.user_id,
    });

    await ctx.db.patch(`wise_transactions?id=eq.${q(txRowId)}`, {
      import_status: "imported",
      expense_id: expense[0]?.id ?? null,
      error_summary: null,
    }, "return=minimal");

    result.expensesImported++;
  } catch (e) {
    await ctx.db.patch(`wise_transactions?id=eq.${q(txRowId)}`, {
      import_status: "failed",
      error_summary: safeError(e),
    }, "return=minimal").catch(() => {});
    result.failed++;
  }
}

/**
 * Returns the inserted row, or null when the unique key already existed.
 *
 * The key spans profile and balance as well as the reference, because a Wise
 * reference is only documented to be unique within a balance statement — the
 * same reference appearing under a different profile or balance is a different
 * movement, not a duplicate.
 */
async function insertIgnoringDuplicates(db: Db, row: Row): Promise<Row | null> {
  const rows = await db.insert(
    "wise_transactions?on_conflict=connection_id,wise_profile_id,wise_balance_id,wise_reference",
    row,
    "resolution=ignore-duplicates,return=representation",
  );
  return rows.length ? rows[0] : null;
}

function readIso(tx: WiseTx): string | null {
  const raw = (tx as Row).date;
  if (!raw) return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function firstString(tx: WiseTx, paths: string[]): string | null {
  for (const p of paths) {
    let cur: unknown = tx;
    for (const part of p.split(".")) {
      if (cur == null || typeof cur !== "object") { cur = undefined; break; }
      cur = (cur as Row)[part];
    }
    if (cur != null && String(cur).trim()) return String(cur).trim();
  }
  return null;
}

/** Short, non-sensitive error label. Never a provider body or a token. */
export function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/[^a-zA-Z0-9_ .:-]/g, "").slice(0, 120);
}

/**
 * Synchronise many connections. One failing connection never stops the others:
 * every connection is isolated, and its outcome is recorded on its own row.
 */
export async function syncMany(
  deps: SyncDeps,
  connections: ConnectionRow[],
): Promise<SyncStats> {
  const stats: SyncStats = {
    connectionsProcessed: 0, transactionsFetched: 0, expensesImported: 0,
    duplicatesSkipped: 0, unsupportedSkipped: 0, failed: 0,
    missingStableId: 0, categoryFallbacks: 0, connections: [],
  };

  for (const conn of connections) {
    let r: ConnectionResult;
    try {
      r = await syncConnection(deps, conn);
    } catch (e) {
      r = { ...emptyResult(conn.id), status: "error", error: safeError(e) };
    }

    stats.connectionsProcessed++;
    stats.transactionsFetched += r.transactionsFetched;
    stats.expensesImported += r.expensesImported;
    stats.duplicatesSkipped += r.duplicatesSkipped;
    stats.unsupportedSkipped += r.unsupportedSkipped;
    stats.failed += r.failed;
    stats.missingStableId += r.missingStableId;
    stats.categoryFallbacks += r.categoryFallbacks;
    stats.connections.push(r);

    // Connection metadata is refreshed whatever happened, so a broken token
    // becomes visible in Settings instead of failing silently.
    const nowIso = deps.now().toISOString();
    const patch: Row = { last_checked_at: nowIso };
    if (r.status === "error") {
      patch.status = "error";
      patch.last_error = r.error;
    } else {
      patch.status = "connected";
      patch.last_error = null;
      patch.last_sync_at = nowIso;
    }
    await deps.db
      .patch(`provider_connections?id=eq.${q(conn.id)}`, patch, "return=minimal")
      .catch(() => {});
  }

  return stats;
}

/** Persists one run's counters. Contains no token and no transaction detail. */
export async function recordRun(
  db: Db,
  trigger: "cron" | "manual",
  startedAt: Date,
  stats: SyncStats,
  errorSummary: string | null = null,
): Promise<void> {
  try {
    await db.insert("provider_sync_runs", {
      trigger_source: trigger,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      connections_processed: stats.connectionsProcessed,
      transactions_fetched: stats.transactionsFetched,
      expenses_imported: stats.expensesImported,
      duplicates_skipped: stats.duplicatesSkipped,
      unsupported_skipped: stats.unsupportedSkipped,
      failed: stats.failed,
      missing_stable_id: stats.missingStableId,
      category_fallbacks: stats.categoryFallbacks,
      error_summary: errorSummary,
    }, "return=minimal");
  } catch (e) {
    console.error("wise-sync: could not record run:", safeError(e));
  }
}
