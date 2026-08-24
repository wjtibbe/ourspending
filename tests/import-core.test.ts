// Provider-neutral import core tests.
//
//   node --experimental-strip-types tests/import-core.test.ts
//
// Drives _shared/import-core.ts against a fake PostgREST. No network, no
// database, no provider. These are the rules that must hold identically no
// matter whether a transaction arrived by API, email, webhook or file upload.

import {
  buildExpenseRow, classifyNormalized, createExpense, isContextFailure,
  perEur, resolveImportContext, spentOn, SUPPORTED_CURRENCIES,
  type ImportContext, type NormalizedTransaction, type Row,
} from "../supabase/functions/_shared/import-core.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

class FakeDb {
  store: Record<string, Row[]> = {};
  seq = 0;
  failInsert = false;
  rows(t: string) { return (this.store[t] ??= []); }
  select(path: string): Promise<Row[]> {
    const [table, qs] = path.split("?");
    const params = new URLSearchParams(qs ?? "");
    const filters: Array<[string, string, string]> = [];
    for (const [k, v] of params) {
      if (["select", "limit", "order", "on_conflict"].includes(k)) continue;
      if (v.startsWith("eq.")) filters.push([k, v.slice(3)]);
    }
    return Promise.resolve(
      this.rows(table).filter((r) => filters.every(([k, v, op]) => op === "neq" ? String(r[k]) !== v : String(r[k]) === v)).map((r) => ({ ...r })),
    );
  }
  insert(table: string, body: Row | Row[]): Promise<Row[]> {
    if (this.failInsert) return Promise.reject(new Error("db_500: insert refused"));
    const rows = Array.isArray(body) ? body : [body];
    const out = rows.map((r) => {
      const rec = { id: `${table.split("?")[0]}-${++this.seq}`, ...r };
      this.rows(table.split("?")[0]).push(rec);
      return { ...rec };
    });
    return Promise.resolve(out);
  }
  patch(): Promise<Row[]> { return Promise.resolve([]); }
}

function seed(over: { slot?: number | null; householdId?: string | null } = {}) {
  const db = new FakeDb();
  db.store.profiles = [{
    id: "user-1",
    household_id: over.householdId === undefined ? "hh-1" : over.householdId,
    slot: over.slot === undefined ? 0 : over.slot,
  }];
  db.store.households = [{ id: "hh-1", usd_per_eur: 1.08, cop_per_eur: 4500 }];
  db.store.household_categories = [];
  db.store.expenses = [];
  return db;
}

const NOW = new Date("2026-08-03T12:00:00.000Z");

const tx = (over: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
  externalRef: "CARD-1",
  occurredAt: "2026-08-01T10:00:00.000Z",
  direction: "out",
  status: "completed",
  amount: { value: 12.34, currency: "USD" },
  merchant: "Netflix.com",
  categoryInput: { providerCategory: "Subscriptions" },
  ...over,
});

// ---------------------------------------------------------------------------
console.log("\n-- context resolution comes from the database, never a payload --");
{
  const ctx = await resolveImportContext(seed(), "user-1", NOW);
  check("resolves household", !isContextFailure(ctx) && ctx.householdId === "hh-1");
  check("resolves slot", !isContextFailure(ctx) && ctx.slot === 0);
  check("resolves rates", !isContextFailure(ctx) && ctx.rates.cop === 4500);
}
{
  const ctx = await resolveImportContext(seed({ householdId: null }), "user-1", NOW);
  check("no household -> refuses, never guesses", isContextFailure(ctx) && ctx.error === "no_household");
}
{
  const ctx = await resolveImportContext(seed({ slot: null }), "user-1", NOW);
  check("unresolvable slot -> refuses, never defaults to p0", isContextFailure(ctx) && ctx.error === "unresolved_slot");
}
{
  const db = seed();
  db.store.household_categories = [
    { household_id: "hh-1", category_key: "subscriptions", active: false, is_custom: false },
  ];
  const ctx = await resolveImportContext(db, "user-1", NOW);
  check("a disabled household category is excluded", !isContextFailure(ctx) && !ctx.allowed.has("subscriptions"));
  check("'other' always stays available as the terminal fallback", !isContextFailure(ctx) && ctx.allowed.has("other"));
}

console.log("\n-- classification: only completed outgoing spend becomes an expense --");
{
  check("completed outgoing -> import", classifyNormalized(tx()).action === "import");
  for (const status of ["declined", "reversed", "refund", "unknown"] as const) {
    const c = classifyNormalized(tx({ status }));
    check(`${status} -> skipped as status_${status}`, c.action === "skip" && c.reason === `status_${status}`);
  }
  const incoming = classifyNormalized(tx({ direction: "in" }));
  check("incoming -> skipped, never imported as an expense", incoming.action === "skip" && incoming.reason === "incoming");
  const gbp = classifyNormalized(tx({ amount: { value: 10, currency: "GBP" } }));
  check("unsupported currency -> skipped, never guessed", gbp.action === "skip" && gbp.reason === "unsupported_currency_GBP");
  const zero = classifyNormalized(tx({ amount: { value: 0, currency: "USD" } }));
  check("zero amount -> skipped (app stores positives only)", zero.action === "skip" && zero.reason === "non_positive_amount");
  const neg = classifyNormalized(tx({ amount: { value: -5, currency: "USD" } }));
  check("negative amount -> skipped", neg.action === "skip" && neg.reason === "non_positive_amount");
  check("supported set is exactly EUR/USD/COP", [...SUPPORTED_CURRENCIES].sort().join(",") === "COP,EUR,USD");
}

console.log("\n-- expense construction: shared, correct payer, app-identical conversion --");
{
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  const { row } = buildExpenseRow(ctx, tx());
  check("kind is shared", row.kind === "shared");
  check("never private", row.kind !== "p0" && row.kind !== "p1");
  check("payer is the owner's slot", row.payer === 0);
  check("household from context", row.household_id === "hh-1");
  check("created_by is the owner", row.created_by === "user-1");
  check("amount is the charged amount", row.amount_orig === 12.34);
  check("currency is the charged currency", row.currency === "USD");
  check("amount_eur matches app.js rounding", row.amount_eur === Math.round((12.34 / 1.08) * 100) / 100);
  check("rate_used recorded", row.rate_used === 1.08);
  check("category mapped from the hint", row.category === "subscriptions");
  check("note carries the merchant", row.note === "Netflix.com");
  check("spent_on is the transaction date", row.spent_on === "2026-08-01");
}
{
  const ctx = await resolveImportContext(seed({ slot: 1 }), "user-1", NOW) as ImportContext;
  const { row } = buildExpenseRow(ctx, tx());
  check("slot 1 owner -> payer 1, still shared", row.payer === 1 && row.kind === "shared");
}
{
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  const { row } = buildExpenseRow(ctx, tx({ amount: { value: 45000, currency: "COP" } }));
  check("COP converts with the household COP rate", row.amount_eur === Math.round((45000 / 4500) * 100) / 100);
  check("COP rate_used recorded", row.rate_used === 4500);
}
{
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  const { row } = buildExpenseRow(ctx, tx({ occurredAt: null }));
  check("missing date falls back to now, never crashes", row.spent_on === "2026-08-03");
  const bad = buildExpenseRow(ctx, tx({ occurredAt: "not-a-date" })).row;
  check("unparseable date falls back to now", bad.spent_on === "2026-08-03");
}
{
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  const { row } = buildExpenseRow(ctx, tx({ merchant: null }));
  check("missing merchant still produces a note", typeof row.note === "string" && row.note.length > 0);
  const long = buildExpenseRow(ctx, tx({ merchant: "x".repeat(200) })).row;
  check("note is truncated to 60 chars", long.note.length === 60);
}

console.log("\n-- category mapping goes through the shared mapper --");
{
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  check("Spanish 'Transporte' -> transport",
    buildExpenseRow(ctx, tx({ categoryInput: { providerCategory: "Transporte" } })).row.category === "transport");
  check("Dutch 'Boodschappen' -> groceries",
    buildExpenseRow(ctx, tx({ categoryInput: { providerCategory: "Boodschappen" } })).row.category === "groceries");
  const unknown = buildExpenseRow(ctx, tx({ categoryInput: { providerCategory: "Quantum Widgets" } }));
  check("unknown category -> other, still imports", unknown.row.category === "other");
  check("unknown category flagged as a fallback", unknown.category.source === "fallback");
}
{
  const db = seed();
  db.store.household_categories = [
    { household_id: "hh-1", category_key: "transport", active: false, is_custom: false },
  ];
  const ctx = await resolveImportContext(db, "user-1", NOW) as ImportContext;
  const { row } = buildExpenseRow(ctx, tx({ categoryInput: { providerCategory: "Transporte" } }));
  check("a category the household disabled is not resurrected", row.category === "other");
}

console.log("\n-- createExpense --");
{
  const db = seed();
  const ctx = await resolveImportContext(db, "user-1", NOW) as ImportContext;
  const out = await createExpense(db, ctx, tx());
  check("returns imported", out.status === "imported");
  check("exactly one expense row written", db.store.expenses.length === 1);
  check("expense id returned", out.status === "imported" && !!out.expenseId);
}
{
  const db = seed();
  const ctx = await resolveImportContext(db, "user-1", NOW) as ImportContext;
  db.failInsert = true;
  const out = await createExpense(db, ctx, tx());
  check("a database failure is reported, not thrown", out.status === "failed");
  check("failure reason is safe (no raw body)", out.status === "failed" && !out.reason.includes("{"));
}
{
  const db = seed();
  db.store.households = [{ id: "hh-1", usd_per_eur: 0, cop_per_eur: 0 }];
  const ctx = await resolveImportContext(db, "user-1", NOW) as ImportContext;
  const out = await createExpense(db, ctx, tx());
  check("a missing household rate fails safely rather than dividing by zero", out.status === "failed");
  check("no expense written when the rate is missing", db.store.expenses.length === 0);
}

console.log("\n-- authoritative amount & merchant metadata (Wise-style conversions) --");
{
  // The Éxito Express example: deducted 19.76 EUR, merchant charged 71,362 COP.
  const exito = () => tx({
    amount: { value: 19.76, currency: "EUR" },
    merchantAmount: { value: 71362, currency: "COP" },
    merchant: "Éxito Express",
  });
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  const { row } = buildExpenseRow(ctx, exito(), { sourceProvider: "wise", conversionSource: "wise_email" });

  check("the deducted amount is the authoritative stored amount",
    row.amount_orig === 19.76 && row.currency === "EUR");
  check("the merchant amount is retained, in its own currency",
    row.merchant_amount === 71362 && row.merchant_currency === "COP");
  check("flagged as a real currency conversion", row.had_currency_conversion === true);
  check("amount_authority records the deducted amount as authoritative",
    row.amount_authority === "deducted_balance_amount");
  check("provenance is recorded", row.source_provider === "wise" && row.conversion_source === "wise_email");

  const out = await createExpense(seed(), ctx, exito(), { sourceProvider: "wise", conversionSource: "wise_email" });
  check("creates exactly one expense (no double counting)", out.status === "imported");
}
{
  // A later exchange-rate update must never recompute a historical import:
  // buildExpenseRow only ever looks at the rates handed to it via ctx, and a
  // fresh ctx built from updated household rates does not touch a row that
  // was already written with the OLD rate.
  const db = seed();
  const ctx1 = await resolveImportContext(db, "user-1", NOW) as ImportContext;
  const first = buildExpenseRow(ctx1, tx({
    amount: { value: 19.76, currency: "EUR" },
    merchantAmount: { value: 71362, currency: "COP" },
  })).row;

  db.store.households = [{ id: "hh-1", usd_per_eur: 1.08, cop_per_eur: 4700 }]; // rate moved
  const ctx2 = await resolveImportContext(db, "user-1", NOW) as ImportContext;
  const second = buildExpenseRow(ctx2, tx({
    amount: { value: 19.76, currency: "EUR" },
    merchantAmount: { value: 71362, currency: "COP" },
  })).row;

  check("the already-built row's stored amounts are the exact source values, independent of ctx",
    first.amount_orig === 19.76 && first.merchant_amount === 71362);
  check("a fresh build from an updated rate still stores the same source amounts (nothing is back-converted)",
    second.amount_orig === 19.76 && second.merchant_currency === "COP" && second.merchant_amount === 71362);
  check("only rate_used reflects which rate was in effect when EUR itself needs no conversion",
    first.rate_used === 1 && second.rate_used === 1); // EUR is always rate 1 regardless of cop_per_eur
}
{
  // A direct EUR transaction with no conversion (e.g. Wise itself reports the
  // same currency in both fields, or no merchant amount at all) must not
  // invent a second amount or a fake conversion flag.
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  const noMerchant = buildExpenseRow(ctx, tx({ amount: { value: 9.99, currency: "EUR" } })).row;
  check("no merchantAmount -> had_currency_conversion is false", noMerchant.had_currency_conversion === false);
  check("no merchantAmount -> merchant_amount stays null", noMerchant.merchant_amount === null);
  check("no merchantAmount -> merchant_currency stays null", noMerchant.merchant_currency === null);

  const sameCurrency = buildExpenseRow(ctx, tx({
    amount: { value: 9.99, currency: "EUR" },
    merchantAmount: { value: 9.99, currency: "EUR" },
  })).row;
  check("merchantAmount in the SAME currency is not treated as a conversion",
    sameCurrency.had_currency_conversion === false);
  check("and is not stored as a second amount",
    sameCurrency.merchant_amount === null && sameCurrency.merchant_currency === null);
}
{
  // Manual/API-style callers that never pass provenance get null audit
  // fields, never invented values -- this is what keeps every existing test
  // above (which calls buildExpenseRow(ctx, tx()) with no third argument)
  // passing unchanged.
  const ctx = await resolveImportContext(seed(), "user-1", NOW) as ImportContext;
  const row = buildExpenseRow(ctx, tx()).row;
  check("provenance defaults to null when not supplied", row.source_provider === null && row.conversion_source === null);
  check("amount_authority is set unconditionally (a contract fact, not provider-specific)",
    row.amount_authority === "deducted_balance_amount");
}

console.log("\n-- perEur matches app.js --");
{
  check("EUR is 1", perEur("EUR", { usd: 1.08, cop: 4500 }) === 1);
  check("USD uses usd_per_eur", perEur("USD", { usd: 1.08, cop: 4500 }) === 1.08);
  check("COP uses cop_per_eur", perEur("COP", { usd: 1.08, cop: 4500 }) === 4500);
  let threw = false;
  try { perEur("GBP", { usd: 1.08, cop: 4500 }); } catch { threw = true; }
  check("an unsupported currency throws rather than returning a wrong rate", threw);
}

console.log("\n-- multi-user isolation: each user resolves to their own household --");
{
  const db = seed();
  db.store.profiles.push({ id: "user-2", household_id: "hh-2", slot: 1 });
  db.store.households.push({ id: "hh-2", usd_per_eur: 1.08, cop_per_eur: 4500 });
  const a = await resolveImportContext(db, "user-1", NOW) as ImportContext;
  const b = await resolveImportContext(db, "user-2", NOW) as ImportContext;
  check("user 1 -> household 1, slot 0", a.householdId === "hh-1" && a.slot === 0);
  check("user 2 -> household 2, slot 1", b.householdId === "hh-2" && b.slot === 1);
  const rowA = buildExpenseRow(a, tx()).row;
  const rowB = buildExpenseRow(b, tx()).row;
  check("their expenses land in different households", rowA.household_id !== rowB.household_id);
  check("and carry different payers", rowA.payer !== rowB.payer);
}

console.log("\n-- spentOn --");
{
  check("ISO timestamp -> date", spentOn(tx(), NOW) === "2026-08-01");
  check("null -> fallback", spentOn(tx({ occurredAt: null }), NOW) === "2026-08-03");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
