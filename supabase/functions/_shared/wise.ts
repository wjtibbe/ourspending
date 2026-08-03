// Wise statement reading: pure classification + a thin API client.
//
// IMPORTANT — provenance of the field names below.
// These follow Wise's *documented* balance-statement API
// (GET /v1/profiles/{profileId}/balance-statements/{balanceId}/statement.json).
// They were NOT observed against this account's real data, because this
// codebase has no Wise credentials available to it. Two things make that safe
// rather than a guess:
//
//   1. resolveAmounts() tries documented paths in a defined order and records
//      WHICH path it used in wise_transactions.amount_source_path, so after
//      the first real run you can see, per row, exactly which field was taken.
//   2. The `inspect` action on the wise-sync function returns a structural,
//      value-redacted view of one real transaction, so the shape can be
//      confirmed in one call without exposing amounts, names or the token.
//
// If the real response differs, only this file changes.
//
// Nothing here touches Deno globals at module scope, so the pure functions are
// unit-testable outside the Edge runtime.

import type { CategoryInput } from "./categories.ts";

export const WISE_API_BASE_DEFAULT = "https://api.transferwise.com";

export type WiseTx = Record<string, unknown>;

export type Amount = { value: number; currency: string; path: string };

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------
const get = (obj: unknown, path: string): unknown => {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
};

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

function readAmount(root: unknown, path: string): Amount | null {
  const node = get(root, path);
  if (!node || typeof node !== "object") return null;
  const raw = (node as Record<string, unknown>).value;
  const cur = str((node as Record<string, unknown>).currency);
  const value = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  if (!Number.isFinite(value) || !cur) return null;
  return { value, currency: cur.toUpperCase(), path };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// A statement contains settled movements, so most transactions carry no status
// field at all. When one IS present it must say "completed" — anything else is
// skipped rather than optimistically imported.
const COMPLETED_STATUSES = new Set([
  "completed", "complete", "settled", "posted", "done",
  "success", "successful", "outgoing_payment_sent", "sent",
]);

// Movements that are not spending: shuffling money between your own balances,
// topping up, or receiving. Skipped with an explicit reason.
const NON_EXPENSE_DETAIL_TYPES = new Set([
  "conversion", "money_added", "deposit", "balance_deposit", "balance_withdrawal",
  "balance_cashback", "interest", "unknown_deposit", "moneyadded",
]);

export type Classification = {
  action: "import" | "skip";
  reason: string | null;
  direction: "out" | "in" | "unknown";
  detailType: string | null;
  status: string | null;
  /** "field" when the provider supplied a status, "absent" when settled by statement semantics. */
  statusSource: "field" | "absent";
};

export function classifyTransaction(tx: WiseTx): Classification {
  const detailType = str(get(tx, "details.type"))?.toLowerCase() ?? null;
  const rawStatus =
    str(get(tx, "status")) ?? str(get(tx, "state")) ?? str(get(tx, "details.status"));
  const status = rawStatus ? rawStatus.toLowerCase().replace(/[\s-]+/g, "_") : null;
  const statusSource: "field" | "absent" = status ? "field" : "absent";

  const type = str(get(tx, "type"))?.toUpperCase() ?? null;
  const topAmount = readAmount(tx, "amount");
  const direction: Classification["direction"] = type === "DEBIT"
    ? "out"
    : type === "CREDIT"
    ? "in"
    : topAmount
    ? (topAmount.value < 0 ? "out" : "in")
    : "unknown";

  const base = { direction, detailType, status, statusSource };

  if (status && !COMPLETED_STATUSES.has(status)) {
    return { action: "skip", reason: `status_${status}`, ...base };
  }
  if (direction === "in") {
    return { action: "skip", reason: "incoming", ...base };
  }
  if (direction === "unknown") {
    return { action: "skip", reason: "direction_unknown", ...base };
  }
  if (detailType && NON_EXPENSE_DETAIL_TYPES.has(detailType)) {
    return { action: "skip", reason: `detail_type_${detailType}`, ...base };
  }
  return { action: "import", reason: null, ...base };
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Which amount actually left the user's Wise balance, and (when a conversion
 * happened) what the merchant charged in their own currency.
 *
 * Order for the balance movement:
 *   1. `amount`                     — the statement's balance movement, in the
 *                                     balance currency. This is the deduction.
 *   2. `exchangeDetails.fromAmount` — the "from" side of a conversion is what
 *                                     left the balance.
 *   3. `details.amount`             — last resort. On a card transaction this
 *                                     is usually the MERCHANT amount, so it is
 *                                     recorded as a low-confidence path.
 *
 * Returns the balance value as a positive number: this app stores expenses as
 * positive amounts (AddExpense rejects <= 0), while Wise reports debits as
 * negative.
 */
export function resolveAmounts(tx: WiseTx): {
  balance: Amount;
  source: Amount | null;
  lowConfidence: boolean;
} {
  const candidates = ["amount", "exchangeDetails.fromAmount", "details.amount"];
  let balance: Amount | null = null;
  for (const path of candidates) {
    const a = readAmount(tx, path);
    if (a && a.value !== 0) { balance = a; break; }
  }
  if (!balance) throw new Error("no_balance_amount");

  const lowConfidence = balance.path === "details.amount";
  const positive: Amount = { ...balance, value: Math.abs(balance.value) };

  // The merchant's own amount, only when it is genuinely a different currency.
  let source: Amount | null = null;
  for (const path of ["details.amount", "exchangeDetails.toAmount"]) {
    const a = readAmount(tx, path);
    if (a && a.currency !== positive.currency && a.value !== 0) {
      source = { ...a, value: Math.abs(a.value) };
      break;
    }
  }

  return { balance: positive, source, lowConfidence };
}

// ---------------------------------------------------------------------------
// Identity, date, description
// ---------------------------------------------------------------------------

/**
 * The stable idempotency key, or null when the provider supplied none.
 *
 * Order: referenceNumber (what Wise's statement gives every movement, e.g.
 * "CARD-123456789"), then the transaction id.
 *
 * There is deliberately NO synthesised fallback. A key derived from date +
 * amount + description is not stable: Wise can settle a transaction with a
 * slightly different description or a corrected amount, and the "same"
 * transaction would then hash differently and import a second time. Returning
 * null instead means the caller records the anomaly and imports nothing, which
 * is recoverable — a duplicate expense is not.
 */
export function transactionReference(tx: WiseTx): string | null {
  return str(get(tx, "referenceNumber")) ??
    str(get(tx, "id")) ??
    null;
}

/** YYYY-MM-DD, matching the app's `spent_on` date column. */
export function transactionDate(tx: WiseTx, fallback: Date): string {
  const raw = str(get(tx, "date")) ?? str(get(tx, "details.paymentDate"));
  const d = raw ? new Date(raw) : null;
  const use = d && !isNaN(d.getTime()) ? d : fallback;
  return use.toISOString().slice(0, 10);
}

/** Human-readable note for the expense row. */
export function describeTransaction(tx: WiseTx): string {
  const merchant = str(get(tx, "details.merchant.name"));
  const description = str(get(tx, "details.description"));
  const recipient = str(get(tx, "details.recipient.name"));
  return (merchant ?? recipient ?? description ?? "Wise transaction").slice(0, 60);
}

export function categoryInputFrom(tx: WiseTx): CategoryInput {
  return {
    providerCategory: get(tx, "details.category"),
    merchantCategory: get(tx, "details.merchant.category"),
    mcc: get(tx, "details.merchant.categoryCode") ?? get(tx, "details.merchant.mcc"),
    description: [
      str(get(tx, "details.merchant.name")),
      str(get(tx, "details.description")),
    ].filter(Boolean).join(" "),
  };
}

// ---------------------------------------------------------------------------
// Redaction — for confirming the real response shape without leaking data
// ---------------------------------------------------------------------------

// Enum-like keys whose values are safe to show: they identify structure, not
// the user or the purchase.
const SAFE_VALUE_KEYS = new Set([
  "type", "status", "state", "currency", "category", "categoryCode", "mcc",
]);

/**
 * A structural view of a transaction: key paths and value *types*, with only
 * enum-ish fields shown literally. Amounts become "number", names and
 * descriptions become "string", digits in references are masked. Safe to log
 * and safe to paste into a chat.
 */
export function redactTransaction(tx: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (tx == null || typeof tx !== "object") return out;

  for (const [key, value] of Object.entries(tx as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null) { out[path] = "null"; continue; }
    if (Array.isArray(value)) {
      out[path] = `array[${value.length}]`;
      if (value.length && typeof value[0] === "object") {
        Object.assign(out, redactTransaction(value[0], `${path}[0]`));
      }
      continue;
    }
    if (typeof value === "object") {
      Object.assign(out, redactTransaction(value, path));
      continue;
    }
    if (SAFE_VALUE_KEYS.has(key)) { out[path] = `${typeof value}: ${String(value)}`; continue; }
    if (key === "referenceNumber") {
      out[path] = "string: " + String(value).replace(/[0-9]/g, "#");
      continue;
    }
    out[path] = typeof value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export interface WiseClient {
  profiles(): Promise<Array<Record<string, unknown>>>;
  balances(profileId: string): Promise<Array<Record<string, unknown>>>;
  statement(
    profileId: string,
    balanceId: string,
    currency: string,
    from: Date,
    to: Date,
  ): Promise<{ transactions: WiseTx[] }>;
}

export class WiseAuthError extends Error {}

export function createWiseClient(token: string, base = WISE_API_BASE_DEFAULT): WiseClient {
  const call = async (path: string) => {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) throw new WiseAuthError("invalid_token");
    if (!res.ok) throw new Error(`wise_${res.status}`);
    return await res.json();
  };

  return {
    profiles: () => call("/v1/profiles"),
    // Multi-currency balances. Older tokens may only expose borderless
    // accounts; that call is tried by the sync core if this returns nothing.
    balances: (profileId) => call(`/v4/profiles/${profileId}/balances?types=STANDARD`),
    statement: (profileId, balanceId, currency, from, to) =>
      call(
        `/v1/profiles/${profileId}/balance-statements/${balanceId}/statement.json` +
          `?currency=${encodeURIComponent(currency)}` +
          `&intervalStart=${from.toISOString()}` +
          `&intervalEnd=${to.toISOString()}` +
          `&type=COMPACT`,
      ),
  };
}
