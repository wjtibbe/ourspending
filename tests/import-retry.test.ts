// Ledger retry / idempotency tests.
//
//   node --experimental-strip-types tests/import-retry.test.ts
//
// Regression coverage for a real production incident: a manual sync reported
//
//   { messagesSeen: 39, duplicatesSkipped: 39, expensesImported: 0 }
//
// while the user had definitely made new purchases that day. claimMessage()
// treated ANY existing (connection_id, provider_message_id) row as a
// duplicate without reading that row's status, so a row left behind at
// `received` (a run that died mid-batch), `failed`, or `unparsed` blocked its
// message from ever being imported -- permanently, on every later sync.
//
// These tests pin the rule that replaced it: a message is skipped as a
// duplicate ONLY when a previous run either genuinely imported it or
// deliberately and terminally skipped it. Everything else is retried.
//
// Gmail message ids here are production-shaped (16 lowercase hex characters,
// e.g. "1993a7c2f4e8b1a0"), not "gm-1", so nothing accidentally depends on a
// short synthetic id.

import {
  claimMessage, isRetryableLedgerRow,
} from "../supabase/functions/_shared/email-import-core.ts";
import {
  syncGmailConnections, type GmailSyncDeps,
} from "../supabase/functions/_shared/gmail-sync.ts";
import type { GmailMessage } from "../supabase/functions/_shared/gmail-message.ts";
import type { Row } from "../supabase/functions/_shared/import-core.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const b64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Production-shaped Gmail ids.
const ID_A = "1993a7c2f4e8b1a0";
const ID_B = "1993a7d1c05fe294";
const ID_C = "1993a7e93b7710ff";

// Each message must be a genuinely DIFFERENT transaction. The importer's
// dedupe layer 4 fingerprints merchant+amount+currency+minute, so reusing one
// amount across several messages would (correctly) collapse them into one
// import and would test the fingerprint layer rather than the retry layer.
// `eur` therefore varies per message, exactly as separate real purchases do.
const wiseMessage = (id: string, eur = 19.76): GmailMessage => {
  const cop = Math.round(eur * 3610);
  const text = `Hi Alex,\n\nYou spent ${cop.toLocaleString("en-US")} COP at Éxito Express.\n\n` +
    `This used ${eur.toFixed(2)} EUR from your account.\n\nThanks for using Wise.`;
  return {
    id,
    internalDate: "1785769440000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Wise <noreply@wise.com>" },
        { name: "To", value: "alex@example.com" },
        { name: "Subject", value: `${cop.toLocaleString("en-US")} COP spent at Éxito Express` },
        { name: "Message-ID", value: `<${id}@wise.com>` },
        { name: "Date", value: "Mon, 03 Aug 2026 15:04:00 +0000" },
      ],
      body: { data: b64url(text) },
    },
  } as GmailMessage;
};

class FakeDb {
  store: Record<string, Row[]> = {};
  seq = 0;
  /** Set a column name to make every select naming it fail, as PostgREST does. */
  unknownColumns = new Set<string>();
  rows(t: string) { return (this.store[t] ??= []); }
  select(path: string): Promise<Row[]> {
    const [table, qs] = path.split("?");
    const params = new URLSearchParams(qs ?? "");
    const sel = params.get("select") ?? "";
    for (const c of this.unknownColumns) {
      if (sel.split(",").includes(c)) {
        return Promise.reject(new Error(`column ${table}.${c} does not exist`));
      }
    }
    const filters: Array<[string, string]> = [];
    for (const [k, v] of params) {
      if (["select", "limit", "order", "on_conflict"].includes(k)) continue;
      if (v.startsWith("eq.")) filters.push([k, decodeURIComponent(v.slice(3))]);
      if (v === "is.true") filters.push([k, "true"]);
    }
    return Promise.resolve(
      this.rows(table)
        .filter((r) => filters.every(([k, v]) => String(r[k]) === v))
        .map((r) => ({ ...r })),
    );
  }
  insert(table: string, body: Row | Row[], prefer = ""): Promise<Row[]> {
    const name = table.split("?")[0];
    const rows = Array.isArray(body) ? body : [body];
    const onConflict = new URLSearchParams(table.split("?")[1] ?? "").get("on_conflict");
    const out: Row[] = [];
    for (const r of rows) {
      if (onConflict) {
        const keys = onConflict.split(",");
        const clash = this.rows(name).find((e) => keys.every((k) => e[k] === r[k]));
        if (clash) {
          if (prefer.includes("merge-duplicates")) { Object.assign(clash, r); out.push({ ...clash }); }
          continue;
        }
      }
      const rec = { id: `${name}-${++this.seq}`, ...r };
      this.rows(name).push(rec);
      out.push({ ...rec });
    }
    return Promise.resolve(out);
  }
  patch(path: string, body: Row): Promise<Row[]> {
    const [table, qs] = path.split("?");
    const params = new URLSearchParams(qs ?? "");
    const filters: Array<[string, string]> = [];
    for (const [k, v] of params) {
      if (v.startsWith("eq.")) filters.push([k, decodeURIComponent(v.slice(3))]);
    }
    for (const r of this.rows(table)) {
      if (filters.every(([k, v]) => String(r[k]) === v)) Object.assign(r, body);
    }
    return Promise.resolve([]);
  }
}

function seedDb(): FakeDb {
  const db = new FakeDb();
  db.store.profiles = [{ id: "user-1", household_id: "hh-1", slot: 0 }];
  db.store.households = [{ id: "hh-1", usd_per_eur: 1.08, cop_per_eur: 4500 }];
  db.store.household_categories = [];
  db.store.expenses = [];
  db.store.email_import_messages = [];
  db.store.email_import_connections = [
    { id: "conn-1", user_id: "user-1", provider: "gmail", enabled: true },
  ];
  db.store.email_import_credentials = [
    { connection_id: "conn-1", user_id: "user-1", ciphertext: "CT", iv: "IV" },
  ];
  return db;
}

const fakeCrypto = (state: { plaintext: string }) => ({
  encrypt: (p: string) => { state.plaintext = p; return Promise.resolve({ ciphertext: "CT", iv: "IV" }); },
  decrypt: () => Promise.resolve(state.plaintext),
});

function gmailFetch(messages: GmailMessage[], opts: { failMessageIds?: Set<string> } = {}) {
  const impl = (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "at-fresh", expires_in: 3600, scope: GMAIL_SCOPE,
      }), { status: 200 }));
    }
    if (url.includes("/messages?")) {
      return Promise.resolve(new Response(JSON.stringify({
        messages: messages.map((m) => ({ id: m.id })), nextPageToken: null,
      }), { status: 200 }));
    }
    const id = decodeURIComponent(url.split("/messages/")[1]?.split("?")[0] ?? "");
    if (opts.failMessageIds?.has(id)) {
      return Promise.resolve(new Response("boom", { status: 400 }));
    }
    const found = messages.find((m) => m.id === id);
    return Promise.resolve(new Response(JSON.stringify(found ?? {}), { status: 200 }));
  };
  return { impl };
}

const depsFor = (db: FakeDb, fetchImpl: GmailSyncDeps["fetchImpl"], state = { plaintext: "" }): GmailSyncDeps => ({
  db: db as unknown as GmailSyncDeps["db"],
  now: () => new Date("2026-08-03T16:00:00.000Z"),
  fetchImpl,
  clientId: "cid",
  clientSecret: "secret",
  ...fakeCrypto(state),
  lookbackDays: 8,
  label: null,
});

const CONNS = [{ id: "conn-1", user_id: "user-1" }];
const cred = () => ({ plaintext: JSON.stringify({ refresh_token: "rt-1" }) });

/** Puts a ledger row into the store in a chosen state, as production would have. */
function seedLedgerRow(db: FakeDb, gmailId: string, patch: Row): void {
  db.rows("email_import_messages").push({
    id: `email_import_messages-seed-${gmailId}`,
    connection_id: "conn-1",
    user_id: "user-1",
    source: "gmail",
    provider_message_id: gmailId,
    received_at: "2026-08-03T15:04:00.000Z",
    ...patch,
  });
}

// ---------------------------------------------------------------------------
console.log("\n-- isRetryableLedgerRow: the state machine, stated directly --");
// ---------------------------------------------------------------------------
{
  const retryable: Array<[string, Row]> = [
    ["received (claimed, run died before finishing)", { status: "received" }],
    ["failed", { status: "failed", error_summary: "missing_household_rate" }],
    ["unparsed (parser did not support it yet)", { status: "unparsed" }],
    ["skipped/no_household (transient config)", { status: "skipped", skip_reason: "no_household" }],
    ["skipped/unresolved_slot (transient config)", { status: "skipped", skip_reason: "unresolved_slot" }],
  ];
  for (const [label, row] of retryable) {
    check(`RETRY  ${label}`, isRetryableLedgerRow(row) === true, JSON.stringify(row));
  }

  const terminal: Array<[string, Row]> = [
    ["imported (with expense)", { status: "imported", expense_id: "expenses-1" }],
    ["imported (expense_id null -- insert returned no representation)", { status: "imported", expense_id: null }],
    ["duplicate (layers 2-4 matched an imported transaction)", { status: "duplicate", skip_reason: "rfc_message_id" }],
    ["skipped/incoming", { status: "skipped", skip_reason: "incoming" }],
    ["skipped/status_declined", { status: "skipped", skip_reason: "status_declined" }],
    ["skipped/status_reversed", { status: "skipped", skip_reason: "status_reversed" }],
    ["skipped/unsupported_currency_GBP", { status: "skipped", skip_reason: "unsupported_currency_GBP" }],
    ["skipped/non_positive_amount", { status: "skipped", skip_reason: "non_positive_amount" }],
    ["skipped/sender_not_recognised", { status: "skipped", skip_reason: "sender_not_recognised" }],
    ["skipped/not_a_transaction", { status: "skipped", skip_reason: "not_a_transaction" }],
  ];
  for (const [label, row] of terminal) {
    check(`TERMINAL  ${label}`, isRetryableLedgerRow(row) === false, JSON.stringify(row));
  }

  // An unknown / future status must not silently start causing re-imports.
  check("an unrecognised status is treated as terminal, not retryable",
    isRetryableLedgerRow({ status: "some_future_state" }) === false);
  check("a skipped row with an unrecognised reason is terminal",
    isRetryableLedgerRow({ status: "skipped", skip_reason: "brand_new_reason" }) === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- 1. first successful import --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const { impl } = gmailFetch([wiseMessage(ID_A)]);
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("one expense imported", stats.expensesImported === 1, JSON.stringify(stats));
  check("exactly one expense row", db.store.expenses.length === 1);
  check("exactly one ledger row", db.store.email_import_messages.length === 1);
  const led = db.store.email_import_messages[0];
  check("ledger status is imported", led.status === "imported", String(led.status));
  check("ledger keeps the production-shaped Gmail id",
    led.provider_message_id === ID_A, String(led.provider_message_id));
  check("ledger links to the created expense", !!led.expense_id);
  check("nothing was counted as retried", stats.retriedRows === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. repeated successful import -> duplicate, no second expense --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const { impl } = gmailFetch([wiseMessage(ID_A)]);
  await syncGmailConnections(depsFor(db, impl, cred()), CONNS);
  const second = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("second run imports nothing", second.expensesImported === 0, JSON.stringify(second));
  check("counted as a duplicate", second.duplicatesSkipped === 1);
  check("and attributed to a genuine prior import",
    second.duplicatesAlreadyImported === 1 && second.terminalSkipped === 0);
  check("still exactly one expense", db.store.expenses.length === 1);
  check("still exactly one ledger row", db.store.email_import_messages.length === 1);
  check("not counted as a retry", second.retriedRows === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. failure BEFORE expense creation leaves a retryable row --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  // The Gmail fetch itself fails, so the run never reaches expense creation.
  const { impl } = gmailFetch([wiseMessage(ID_A)], { failMessageIds: new Set([ID_A]) });
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("nothing imported", stats.expensesImported === 0, JSON.stringify(stats));
  check("counted as failed", stats.failed === 1);
  check("no expense row was created", db.store.expenses.length === 0);
  const led = db.store.email_import_messages[0];
  check("a durable ledger row exists", !!led);
  check("its status is failed", led.status === "failed", String(led.status));
  check("it has no expense_id", !led.expense_id);
  check("and it is classified retryable", isRetryableLedgerRow(led) === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. retry after failure -> expense IS created (the actual bug) --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const failing = gmailFetch([wiseMessage(ID_A)], { failMessageIds: new Set([ID_A]) });
  const first = await syncGmailConnections(depsFor(db, failing.impl, cred()), CONNS);
  check("run 1 fails and imports nothing", first.expensesImported === 0 && first.failed === 1);

  // Gmail is healthy on the next sync. Under the old logic this reported
  // duplicatesSkipped=1 forever and the purchase never appeared.
  const healthy = gmailFetch([wiseMessage(ID_A)]);
  const second = await syncGmailConnections(depsFor(db, healthy.impl, cred()), CONNS);

  check("run 2 IMPORTS it rather than skipping it as a duplicate",
    second.expensesImported === 1, JSON.stringify(second));
  check("run 2 does not count it as a duplicate", second.duplicatesSkipped === 0);
  check("run 2 reports it as a retried row", second.retriedRows === 1);
  check("exactly one expense exists", db.store.expenses.length === 1);
  check("still exactly one ledger row -- reclaimed, not duplicated",
    db.store.email_import_messages.length === 1);
  const led = db.store.email_import_messages[0];
  check("ledger status is now imported", led.status === "imported", String(led.status));
  check("the stale error_summary was cleared on reclaim", !led.error_summary);
  check("the retry was counted", Number(led.attempt_count) >= 1, String(led.attempt_count));
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. retry again after success -> duplicate, still one expense --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const failing = gmailFetch([wiseMessage(ID_A)], { failMessageIds: new Set([ID_A]) });
  await syncGmailConnections(depsFor(db, failing.impl, cred()), CONNS);
  const healthy = gmailFetch([wiseMessage(ID_A)]);
  await syncGmailConnections(depsFor(db, healthy.impl, cred()), CONNS);
  const third = await syncGmailConnections(depsFor(db, healthy.impl, cred()), CONNS);

  check("third run imports nothing", third.expensesImported === 0, JSON.stringify(third));
  check("third run counts a duplicate", third.duplicatesSkipped === 1);
  check("attributed to a genuine prior import", third.duplicatesAlreadyImported === 1);
  check("third run retries nothing", third.retriedRows === 0);
  check("STILL exactly one expense -- no double import", db.store.expenses.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. a row stuck at `received` is retried, not skipped forever --");
// ---------------------------------------------------------------------------
// This is the shape the 39-duplicate incident actually left behind: claimed,
// then the run died before the import finished.
{
  const db = seedDb();
  seedLedgerRow(db, ID_A, { status: "received" });
  const { impl } = gmailFetch([wiseMessage(ID_A)]);
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("the stuck row is retried and imported", stats.expensesImported === 1, JSON.stringify(stats));
  check("reported as a retry", stats.retriedRows === 1);
  check("not reported as a duplicate", stats.duplicatesSkipped === 0);
  check("no second ledger row was created", db.store.email_import_messages.length === 1);
  check("exactly one expense", db.store.expenses.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. unparsed, then the parser supports it -> imported later --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  // A previous sync recorded this id as unparsed, when the template was
  // unrecognised. The parser has since learned it.
  seedLedgerRow(db, ID_A, { status: "unparsed", skip_reason: "parser_awaiting_samples" });
  const { impl } = gmailFetch([wiseMessage(ID_A)]);
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("the previously-unparsed message is imported", stats.expensesImported === 1, JSON.stringify(stats));
  check("counted as a retry", stats.retriedRows === 1);
  check("exactly one expense", db.store.expenses.length === 1);
  check("the ledger row is reused, not duplicated", db.store.email_import_messages.length === 1);
  check("its stale skip_reason was cleared",
    !db.store.email_import_messages[0].skip_reason);
}

// ---------------------------------------------------------------------------
console.log("\n-- 8. a deliberately terminal skip STAYS skipped --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  // A declined transaction: correctly skipped, and must never be resurrected.
  seedLedgerRow(db, ID_A, { status: "skipped", skip_reason: "status_declined" });
  const { impl } = gmailFetch([wiseMessage(ID_A)]);
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("nothing is imported", stats.expensesImported === 0, JSON.stringify(stats));
  check("no expense is created", db.store.expenses.length === 0);
  check("counted as a duplicate skip", stats.duplicatesSkipped === 1);
  check("and attributed to a TERMINAL skip, not a prior import",
    stats.terminalSkipped === 1 && stats.duplicatesAlreadyImported === 0);
  check("not retried", stats.retriedRows === 0);
  check("the ledger row keeps its original reason",
    db.store.email_import_messages[0].skip_reason === "status_declined");
}

// ---------------------------------------------------------------------------
console.log("\n-- 9. an already-imported row is never re-imported --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  seedLedgerRow(db, ID_A, { status: "imported", expense_id: "expenses-existing" });
  const { impl } = gmailFetch([wiseMessage(ID_A)]);
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("nothing imported", stats.expensesImported === 0, JSON.stringify(stats));
  check("no expense created", db.store.expenses.length === 0);
  check("counted as an already-imported duplicate", stats.duplicatesAlreadyImported === 1);

  // Same, but expense_id is null -- someone deleted the expense on purpose
  // (the FK is `on delete set null`). Re-importing would resurrect it.
  const db2 = seedDb();
  seedLedgerRow(db2, ID_B, { status: "imported", expense_id: null });
  const f2 = gmailFetch([wiseMessage(ID_B)]);
  const s2 = await syncGmailConnections(depsFor(db2, f2.impl, cred()), CONNS);
  check("imported-with-null-expense_id is still terminal", s2.expensesImported === 0, JSON.stringify(s2));
  check("a deliberately deleted expense is not resurrected", db2.store.expenses.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 10. one bad message does not block the ones after it --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const { impl } = gmailFetch(
    [wiseMessage(ID_A, 19.76), wiseMessage(ID_B, 24.10), wiseMessage(ID_C, 8.45)],
    { failMessageIds: new Set([ID_B]) },
  );
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("the two healthy messages still import", stats.expensesImported === 2, JSON.stringify(stats));
  check("the bad one is counted as failed", stats.failed === 1);
  check("two expenses exist", db.store.expenses.length === 2);
  check("all three have a ledger row", db.store.email_import_messages.length === 3);

  // And the failed one is picked up on the next healthy sync.
  const healthy = gmailFetch([wiseMessage(ID_A, 19.76), wiseMessage(ID_B, 24.10), wiseMessage(ID_C, 8.45)]);
  const second = await syncGmailConnections(depsFor(db, healthy.impl, cred()), CONNS);
  check("the previously-failed message imports on the next run",
    second.expensesImported === 1, JSON.stringify(second));
  check("the two already-imported ones stay duplicates",
    second.duplicatesAlreadyImported === 2);
  check("three expenses in total, no duplicates", db.store.expenses.length === 3);
}

// ---------------------------------------------------------------------------
console.log("\n-- 11. the incident, reproduced and fixed at scale --");
// ---------------------------------------------------------------------------
{
  // 39 messages that a previous broken run claimed but never imported.
  const ids = Array.from({ length: 39 }, (_, i) =>
    `1993a7${i.toString(16).padStart(2, "0")}f4e8b1a0`.slice(0, 16));
  const db = seedDb();
  for (const id of ids) seedLedgerRow(db, id, { status: "received" });

  // A distinct amount per message: 39 separate real purchases, not one
  // transaction seen 39 times.
  const { impl } = gmailFetch(ids.map((id, i) => wiseMessage(id, 10 + i * 0.37)));
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("all 39 messages are seen", stats.messagesSeen === 39, JSON.stringify(stats));
  check("all 39 are imported rather than skipped", stats.expensesImported === 39);
  check("zero are counted as duplicates", stats.duplicatesSkipped === 0);
  check("all 39 are reported as retries", stats.retriedRows === 39);
  check("39 expenses exist", db.store.expenses.length === 39);
  check("still exactly 39 ledger rows -- reclaimed, never duplicated",
    db.store.email_import_messages.length === 39);

  // Running again must now be a clean no-op.
  const again = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);
  check("a repeat run imports nothing", again.expensesImported === 0, JSON.stringify(again));
  check("and reports all 39 as already-imported duplicates",
    again.duplicatesAlreadyImported === 39);
  check("still exactly 39 expenses", db.store.expenses.length === 39);
}

// ---------------------------------------------------------------------------
console.log("\n-- 12. retry works even before the diagnostics migration runs --");
// ---------------------------------------------------------------------------
// attempt_count / last_attempt_at are added by a later migration. If the
// function is deployed before that migration is applied, PostgREST rejects any
// request naming those columns. Retrying must not depend on them.
{
  const db = seedDb();
  db.unknownColumns.add("attempt_count");
  seedLedgerRow(db, ID_A, { status: "failed", error_summary: "boom" });
  const { impl } = gmailFetch([wiseMessage(ID_A)]);
  const stats = await syncGmailConnections(depsFor(db, impl, cred()), CONNS);

  check("the retry still happens with the columns missing",
    stats.expensesImported === 1, JSON.stringify(stats));
  check("counted as a retry", stats.retriedRows === 1);
  check("the expense is created", db.store.expenses.length === 1);
  check("no duplicate ledger row", db.store.email_import_messages.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 13. claimMessage returns the right shape directly --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const base = {
    connectionId: "conn-1", userId: "user-1", source: "gmail",
    fromAddress: "noreply@wise.com", receivedAt: "2026-08-03T15:04:00.000Z",
  };

  const first = await claimMessage(db as never, { ...base, providerMessageId: ID_A });
  check("a brand-new message is claimed", first.claimed === true);
  check("and is not marked as a retry", first.claimed === true && first.retryOf === null);

  // Same id, still at `received`.
  const retry = await claimMessage(db as never, { ...base, providerMessageId: ID_A });
  check("re-claiming a `received` row is allowed", retry.claimed === true);
  check("and reports which state it came from",
    retry.claimed === true && retry.retryOf === "received", JSON.stringify(retry));
  check("the same row id is reused", retry.claimed === true && first.claimed === true
    && retry.rowId === first.rowId);
  check("no second ledger row", db.store.email_import_messages.length === 1);

  // Now mark it imported: it must become terminal.
  db.store.email_import_messages[0].status = "imported";
  const done = await claimMessage(db as never, { ...base, providerMessageId: ID_A });
  check("an imported row refuses the claim", done.claimed === false);
  check("with reason already_imported",
    done.claimed === false && done.reason === "already_imported", JSON.stringify(done));

  // A terminal skip reports its own distinct reason.
  db.store.email_import_messages[0].status = "skipped";
  db.store.email_import_messages[0].skip_reason = "incoming";
  const skipped = await claimMessage(db as never, { ...base, providerMessageId: ID_A });
  check("a terminal skip refuses the claim", skipped.claimed === false);
  check("with reason terminal_skip",
    skipped.claimed === false && skipped.reason === "terminal_skip", JSON.stringify(skipped));
}

// ---------------------------------------------------------------------------
console.log("\n-- 14. an unreadable ledger fails CLOSED, never double-imports --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  seedLedgerRow(db, ID_A, { status: "failed" });
  // Make the existence lookup itself fail.
  db.unknownColumns.add("status");
  const claim = await claimMessage(db as never, {
    connectionId: "conn-1", userId: "user-1", source: "gmail",
    providerMessageId: ID_A, fromAddress: null, receivedAt: "2026-08-03T15:04:00.000Z",
  });
  check("an unreadable existing row is skipped rather than re-imported",
    claim.claimed === false, JSON.stringify(claim));
  check("no expense could be created from it", db.store.expenses.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
