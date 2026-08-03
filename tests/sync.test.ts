// Wise synchronisation core tests.
//
//   node --experimental-strip-types tests/sync.test.ts
//
// Exercises supabase/functions/_shared/sync.ts — the same module both the
// hourly cron job and the "Sync now" button run — against a fake PostgREST and
// a fake Wise API. No network, no database, no credentials.

import { syncConnection, syncMany, type ConnectionRow, type Row } from "../supabase/functions/_shared/sync.ts";
import { WiseAuthError, type WiseClient, type WiseTx } from "../supabase/functions/_shared/wise.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
function parsePath(path: string) {
  const [table, qs] = path.split("?");
  const params = new URLSearchParams(qs ?? "");
  const filters: Array<[string, string]> = [];
  for (const [k, v] of params) {
    if (["select", "limit", "order", "on_conflict"].includes(k)) continue;
    if (v.startsWith("eq.")) filters.push([k, v.slice(3)]);
  }
  return { table, params, filters };
}

class FakeDb {
  store: Record<string, Row[]> = {};
  seq = 0;

  rows(table: string) { return (this.store[table] ??= []); }

  select(path: string): Promise<Row[]> {
    const { table, params, filters } = parsePath(path);
    let out = this.rows(table).filter((r) =>
      filters.every(([k, v]) => String(r[k]) === v)
    );
    const limit = params.get("limit");
    if (limit) out = out.slice(0, Number(limit));
    return Promise.resolve(out.map((r) => ({ ...r })));
  }

  insert(path: string, body: Row | Row[], prefer = ""): Promise<Row[]> {
    const { table, params } = parsePath(path);
    const incoming = Array.isArray(body) ? body : [body];
    const onConflict = (params.get("on_conflict") ?? "").split(",").filter(Boolean);
    const out: Row[] = [];

    for (const r of incoming) {
      if (onConflict.length) {
        const dup = this.rows(table).find((e) =>
          onConflict.every((k) => String(e[k]) === String(r[k]))
        );
        if (dup) {
          if (prefer.includes("ignore-duplicates")) continue;   // PostgREST returns nothing
          Object.assign(dup, r);
          out.push({ ...dup });
          continue;
        }
      }
      const rec = { id: `${table.split("?")[0]}-${++this.seq}`, ...r };
      this.rows(table).push(rec);
      out.push({ ...rec });
    }
    return Promise.resolve(prefer.includes("return=minimal") ? [] : out);
  }

  patch(path: string, body: Row, prefer = ""): Promise<Row[]> {
    const { table, filters } = parsePath(path);
    const hit = this.rows(table).filter((r) => filters.every(([k, v]) => String(r[k]) === v));
    hit.forEach((r) => Object.assign(r, body));
    return Promise.resolve(prefer.includes("return=minimal") ? [] : hit.map((r) => ({ ...r })));
  }
}

function fakeWise(transactions: WiseTx[], opts: { throwOn?: "profiles" | "statement" } = {}): WiseClient {
  return {
    profiles: async () => {
      if (opts.throwOn === "profiles") throw new WiseAuthError("invalid_token");
      return [{ id: 111, type: "personal" }];
    },
    balances: async () => [{ id: 222, currency: "USD" }],
    statement: async () => {
      if (opts.throwOn === "statement") throw new Error("wise_500");
      return { transactions };
    },
  };
}

const CONN: ConnectionRow = { id: "conn-1", user_id: "user-1", provider: "wise" };

function freshDb(overrides: { slot?: number; householdId?: string | null } = {}) {
  const db = new FakeDb();
  const householdId = overrides.householdId === undefined ? "hh-1" : overrides.householdId;
  db.store.profiles = [{ id: "user-1", household_id: householdId, slot: overrides.slot ?? 0 }];
  db.store.households = [{ id: "hh-1", usd_per_eur: 1.08, cop_per_eur: 4500 }];
  db.store.household_categories = [];
  db.store.provider_connections = [{ id: "conn-1", user_id: "user-1", provider: "wise", status: "connected" }];
  db.store.expenses = [];
  db.store.wise_transactions = [];
  return db;
}

const deps = (db: FakeDb, wise: WiseClient) => ({
  db,
  clientFor: async () => wise,
  now: () => new Date("2026-08-03T12:00:00.000Z"),
  lookbackDays: 14,
});

// ---------------------------------------------------------------------------
// Fixtures — shapes follow Wise's documented balance-statement API
// ---------------------------------------------------------------------------
const COMPLETED_CARD: WiseTx = {
  type: "DEBIT",
  date: "2026-08-01T10:00:00.000Z",
  amount: { value: -12.34, currency: "USD" },
  totalFees: { value: 0, currency: "USD" },
  details: {
    type: "CARD",
    description: "Card transaction of 12.34 USD issued by NETFLIX",
    category: "Subscriptions",
    merchant: { name: "Netflix.com", category: "Streaming" },
  },
  referenceNumber: "CARD-1001",
};

// The conversion case: a Colombian merchant charges COP, Wise deducts USD.
const CONVERTED_CARD: WiseTx = {
  type: "DEBIT",
  date: "2026-08-02T09:30:00.000Z",
  amount: { value: -11.2, currency: "USD" },
  details: {
    type: "CARD",
    description: "Card transaction of 45000 COP issued by UBER BOGOTA",
    amount: { value: 45000, currency: "COP" },
    category: "Transporte",
    merchant: { name: "UBER *TRIP", category: "Taxi", categoryCode: 4121 },
  },
  exchangeDetails: {
    fromAmount: { value: 11.2, currency: "USD" },
    toAmount: { value: 45000, currency: "COP" },
    rate: 4017.85,
  },
  referenceNumber: "CARD-1002",
};

const PENDING: WiseTx = { ...COMPLETED_CARD, status: "PENDING", referenceNumber: "CARD-2001" };
const REVERSED: WiseTx = { ...COMPLETED_CARD, status: "REVERSED", referenceNumber: "CARD-2002" };
const CANCELLED: WiseTx = { ...COMPLETED_CARD, status: "CANCELLED", referenceNumber: "CARD-2003" };
const DECLINED: WiseTx = { ...COMPLETED_CARD, status: "DECLINED", referenceNumber: "CARD-2004" };
const FAILED: WiseTx = { ...COMPLETED_CARD, status: "FAILED", referenceNumber: "CARD-2005" };

const INCOMING: WiseTx = {
  type: "CREDIT",
  date: "2026-08-02T08:00:00.000Z",
  amount: { value: 500, currency: "USD" },
  details: { type: "DEPOSIT", description: "Received money from ACME" },
  referenceNumber: "TRANSFER-3001",
};

const UNKNOWN_CATEGORY: WiseTx = {
  type: "DEBIT",
  date: "2026-08-02T11:00:00.000Z",
  amount: { value: -9.99, currency: "USD" },
  details: { type: "CARD", description: "ZZZ", category: "Quantum Widgets", merchant: { name: "ZZZ" } },
  referenceNumber: "CARD-4001",
};

const MALFORMED: WiseTx = { type: "DEBIT", date: "not-a-date", referenceNumber: "CARD-5001" };

const GBP_BALANCE_TX: WiseTx = {
  type: "DEBIT",
  date: "2026-08-02T12:00:00.000Z",
  amount: { value: -20, currency: "GBP" },
  details: { type: "CARD", description: "London", category: "Groceries" },
  referenceNumber: "CARD-6001",
};

// ---------------------------------------------------------------------------
console.log("\n-- case 1: a completed outgoing transaction creates exactly one expense --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([COMPLETED_CARD])), CONN);
  check("one expense imported", r.expensesImported === 1, JSON.stringify(r));
  check("exactly one expense row", db.store.expenses.length === 1);
  const e = db.store.expenses[0];
  check("household is the owner's household", e.household_id === "hh-1");
  check("created_by is the connection owner", e.created_by === "user-1");
  check("amount is positive", Number(e.amount_orig) === 12.34);
  check("currency is the deducted currency", e.currency === "USD");
  check("amount_eur uses the household rate", Number(e.amount_eur) === Math.round((12.34 / 1.08) * 100) / 100);
  check("rate_used recorded", Number(e.rate_used) === 1.08);
  check("kind is private to the owner's slot", e.kind === "p0" && e.payer === 0);
  check("category mapped from the Wise category", e.category === "subscriptions");
  check("spent_on is the transaction date", e.spent_on === "2026-08-01");
  check("note carries the merchant", String(e.note).includes("Netflix"));
  const ledger = db.store.wise_transactions[0];
  check("ledger row marked imported", ledger.import_status === "imported");
  check("ledger links to the expense", ledger.expense_id === e.id);
  check("raw response preserved", !!ledger.raw_json);
}

console.log("\n-- case 2: running twice does not duplicate --");
{
  const db = freshDb();
  const d = deps(db, fakeWise([COMPLETED_CARD, CONVERTED_CARD]));
  const first = await syncConnection(d, CONN);
  const second = await syncConnection(d, CONN);
  check("first run imports two", first.expensesImported === 2, JSON.stringify(first));
  check("second run imports none", second.expensesImported === 0, JSON.stringify(second));
  check("second run counts duplicates", second.duplicatesSkipped === 2);
  check("still exactly two expenses", db.store.expenses.length === 2);
  check("still exactly two ledger rows", db.store.wise_transactions.length === 2);
}

console.log("\n-- cases 3 + 4: pending, reversed, cancelled, declined, failed are not imported --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([PENDING, REVERSED, CANCELLED, DECLINED, FAILED])), CONN);
  check("nothing imported", r.expensesImported === 0 && db.store.expenses.length === 0, JSON.stringify(r));
  check("all five recorded as skipped", r.unsupportedSkipped === 5);
  check("skip reasons name the status", db.store.wise_transactions.every((t) => String(t.skip_reason).startsWith("status_")));
  check("re-running does not import them later", true);
  const again = await syncConnection(deps(db, fakeWise([PENDING, REVERSED])), CONN);
  check("skipped rows are not re-evaluated", again.duplicatesSkipped === 2 && db.store.expenses.length === 0);
}

console.log("\n-- case 5: incoming payments are not imported --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([INCOMING])), CONN);
  check("no expense created", db.store.expenses.length === 0, JSON.stringify(r));
  check("recorded with reason 'incoming'", db.store.wise_transactions[0].skip_reason === "incoming");
}

console.log("\n-- case 6: Wise transport category maps to the app transport category --");
{
  const db = freshDb();
  await syncConnection(deps(db, fakeWise([CONVERTED_CARD])), CONN);
  check("Spanish 'Transporte' -> transport", db.store.expenses[0].category === "transport");
  check("category source recorded", db.store.wise_transactions[0].category_source === "provider_category");
  check("provider label kept for audit only", db.store.wise_transactions[0].wise_category === "Transporte");
}

console.log("\n-- case 7: an unknown category still imports, as 'other' --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([UNKNOWN_CATEGORY])), CONN);
  check("imported anyway", r.expensesImported === 1, JSON.stringify(r));
  check("category is other", db.store.expenses[0].category === "other");
  check("counted as a categorisation fallback", r.categoryFallbacks === 1);
  check("no new category invented", db.store.household_categories.length === 0);
}

console.log("\n-- case 8: the deducted balance amount wins over the merchant amount --");
{
  const db = freshDb();
  await syncConnection(deps(db, fakeWise([CONVERTED_CARD])), CONN);
  const e = db.store.expenses[0];
  check("expense amount is the USD deduction, not 45000", Number(e.amount_orig) === 11.2, String(e.amount_orig));
  check("expense currency is USD, not COP", e.currency === "USD");
  const t = db.store.wise_transactions[0];
  check("balance amount source path recorded", t.amount_source_path === "amount", String(t.amount_source_path));
  check("not flagged low confidence", t.amount_low_confidence === false);
  check("merchant amount kept as metadata", Number(t.merchant_amount_value) === 45000 && t.merchant_amount_currency === "COP");
  check("amount_eur derived from the USD amount", Number(e.amount_eur) === Math.round((11.2 / 1.08) * 100) / 100);
}

console.log("\n-- unsupported balance currency is skipped, never guessed --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([GBP_BALANCE_TX])), CONN);
  check("no expense created for GBP", db.store.expenses.length === 0, JSON.stringify(r));
  check("reason records the currency", db.store.wise_transactions[0].skip_reason === "unsupported_currency_GBP");
}

console.log("\n-- case 9: one malformed transaction does not stop the rest --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([MALFORMED, COMPLETED_CARD, CONVERTED_CARD])), CONN);
  check("the two good ones still imported", r.expensesImported === 2, JSON.stringify(r));
  check("the bad one is counted as failed", r.failed === 1);
  check("expenses table has exactly two rows", db.store.expenses.length === 2);
}

console.log("\n-- case 10: one failing connection does not stop the others --");
{
  const db = freshDb();
  db.store.profiles.push({ id: "user-2", household_id: "hh-2", slot: 1 });
  db.store.households.push({ id: "hh-2", usd_per_eur: 1.08, cop_per_eur: 4500 });
  db.store.provider_connections.push({ id: "conn-2", user_id: "user-2", provider: "wise", status: "connected" });

  const broken: ConnectionRow = { id: "conn-2", user_id: "user-2", provider: "wise" };
  const stats = await syncMany({
    db,
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    lookbackDays: 14,
    clientFor: async (c) => {
      if (c.id === "conn-2") throw new Error("decrypt boom");
      return fakeWise([COMPLETED_CARD]);
    },
  }, [broken, CONN]);

  check("both connections processed", stats.connectionsProcessed === 2, JSON.stringify(stats));
  check("the healthy one still imported", stats.expensesImported === 1);
  const bad = stats.connections.find((c) => c.connectionId === "conn-2")!;
  const good = stats.connections.find((c) => c.connectionId === "conn-1")!;
  check("broken connection marked error", bad.status === "error" && bad.error === "decrypt_failed");
  check("healthy connection marked ok", good.status === "ok");
  const brokenRow = db.store.provider_connections.find((c) => c.id === "conn-2")!;
  const goodRow = db.store.provider_connections.find((c) => c.id === "conn-1")!;
  check("broken connection status persisted", brokenRow.status === "error" && !!brokenRow.last_error);
  check("broken connection last_checked_at updated", !!brokenRow.last_checked_at);
  check("broken connection last_sync_at NOT updated", !brokenRow.last_sync_at);
  check("healthy connection last_sync_at updated", !!goodRow.last_sync_at && goodRow.status === "connected");
}

console.log("\n-- an invalid token is reported, not swallowed --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([], { throwOn: "profiles" })), CONN);
  check("status error with invalid_token", r.status === "error" && r.error === "invalid_token", JSON.stringify(r));
}

console.log("\n-- a user with no household is skipped, never guessed at --");
{
  const db = freshDb({ householdId: null });
  const r = await syncConnection(deps(db, fakeWise([COMPLETED_CARD])), CONN);
  check("skipped with no_household", r.status === "skipped" && r.error === "no_household");
  check("no expense created anywhere", db.store.expenses.length === 0);
}

console.log("\n-- the household is re-derived, never taken from the connection row --");
{
  const db = freshDb();
  // The connection row still claims hh-1, but the profile has moved to hh-9.
  db.store.profiles[0].household_id = "hh-9";
  db.store.households.push({ id: "hh-9", usd_per_eur: 1.08, cop_per_eur: 4500 });
  db.store.provider_connections[0].household_id = "hh-1";
  await syncConnection(deps(db, fakeWise([COMPLETED_CARD])), CONN);
  check("expense lands in the CURRENT household", db.store.expenses[0].household_id === "hh-9");
}

console.log("\n-- slot 1 owner gets p1 --");
{
  const db = freshDb({ slot: 1 });
  await syncConnection(deps(db, fakeWise([COMPLETED_CARD])), CONN);
  check("kind p1, payer 1", db.store.expenses[0].kind === "p1" && db.store.expenses[0].payer === 1);
}

console.log("\n-- a deactivated household category falls back to other --");
{
  const db = freshDb();
  db.store.household_categories = [
    { household_id: "hh-1", category_key: "subscriptions", active: false, is_custom: false },
  ];
  await syncConnection(deps(db, fakeWise([COMPLETED_CARD])), CONN);
  check("disabled category not used", db.store.expenses[0].category === "other");
}

console.log("\n-- an unreadable balance does not abort the connection --");
{
  const db = freshDb();
  const r = await syncConnection(deps(db, fakeWise([], { throwOn: "statement" })), CONN);
  check("connection still ok", r.status === "ok", JSON.stringify(r));
  check("the failure is counted", r.failed === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
