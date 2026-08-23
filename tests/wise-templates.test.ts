// Real Wise card-payment template variants, end to end.
//
//   node --experimental-strip-types tests/wise-templates.test.ts
//
// Regression coverage for the fourth and final act of a long incident. Gmail
// discovery was confirmed healthy -- 41 listed, 41 seen, 0 rejected by sender,
// 0 rejected by template -- and expenses still did not appear.
//
// Wise sends at least two wordings for the same kind of transaction, both seen
// on the same real account within days:
//
//   subject: "Card payment: 13,552 COP spent at Uber"
//   body:    "You spent 13,552 COP at Uber."
//            "Card payment"
//            "This used 3.79 EUR from your Wise account."
//
//   subject: "203,575 COP spent at Tiendas D1"
//   body:    "You spent 203,575 COP at Tiendas D1."
//            "This used 57.04 EUR from your account."
//
// The parser required the literal "from your account". Every message using the
// newer "from your Wise account" wording matched the "You spent ..." sentence
// perfectly and was then thrown away on the second one, landing as `unparsed`.
//
// Two further defects only became visible together with that one, and are
// pinned here as well:
//
//   * dedupe layers 2-4 did not exclude the row being processed, so a RETRY
//     matched the rfc_message_id its own previous attempt had stored and
//     marked itself a duplicate -- turning a retryable row terminal on its
//     first retry, the exact opposite of the retry path's purpose;
//   * a post-claim `duplicate` outcome was counted only in duplicatesSkipped,
//     so those retried rows vanished with no bucket explaining them. That is
//     how a run reported 31 retriedRows with imported/unparsed/skipped/failed
//     all at zero.

import { wiseEmailParser } from "../supabase/functions/_shared/parse-wise-email.ts";
import {
  syncGmailConnections, reconcileStats, type GmailSyncDeps, type SyncStats,
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

// ---------------------------------------------------------------------------
// The four real examples, transcribed verbatim from the reported mailbox.
// ---------------------------------------------------------------------------

type Fixture = {
  label: string;
  gmailId: string;
  subject: string;
  body: string;
  expect: { merchant: string; eur: number; cop: number };
};

const FIXTURES: Fixture[] = [
  {
    label: "VARIANT 1 — Uber (subject prefixed, 'your Wise account')",
    gmailId: "1993d0a1c4e8b100",
    subject: "Card payment: 13,552 COP spent at Uber",
    body: "You spent 13,552 COP at Uber.\n\nCard payment\n\n" +
      "This used 3.79 EUR from your Wise account.",
    expect: { merchant: "Uber", eur: 3.79, cop: 13552 },
  },
  {
    label: "VARIANT 2 — Tiendas D1 (bare subject, 'your account')",
    gmailId: "1993d0b2d5f9c211",
    subject: "203,575 COP spent at Tiendas D1",
    body: "You spent 203,575 COP at Tiendas D1.\n\n" +
      "This used 57.04 EUR from your account.",
    expect: { merchant: "Tiendas D1", eur: 57.04, cop: 203575 },
  },
  {
    label: "VARIANT 3 — Golden Padel - Bold (hyphenated merchant)",
    gmailId: "1993d0c3e60ad322",
    subject: "Card payment: 50,500 COP spent at Golden Padel - Bold",
    body: "You spent 50,500 COP at Golden Padel - Bold.\n\nCard payment\n\n" +
      "This used 14.30 EUR from your Wise account.",
    expect: { merchant: "Golden Padel - Bold", eur: 14.30, cop: 50500 },
  },
  {
    label: "VARIANT 4 — DiDi",
    gmailId: "1993d0d4f71be433",
    subject: "Card payment: 22,768 COP spent at DiDi",
    body: "You spent 22,768 COP at DiDi.\n\nCard payment\n\n" +
      "This used 6.45 EUR from your Wise account.",
    expect: { merchant: "DiDi", eur: 6.45, cop: 22768 },
  },
];

const inbound = (f: Fixture) => ({
  providerMessageId: f.gmailId,
  recipients: [],
  from: "Wise <noreply@wise.com>",
  subject: f.subject,
  text: f.body,
  html: null,
  headers: {},
  rfcMessageId: `<${f.gmailId}@wise.com>`,
  receivedAt: "2026-08-19T15:04:00.000Z",
});

const gmailMessage = (f: Fixture, asHtml = false): GmailMessage => ({
  id: f.gmailId,
  internalDate: "1787670240000",
  payload: {
    mimeType: asHtml ? "text/html" : "text/plain",
    headers: [
      { name: "From", value: "Wise <noreply@wise.com>" },
      { name: "To", value: "alex@example.com" },
      { name: "Subject", value: f.subject },
      { name: "Message-ID", value: `<${f.gmailId}@wise.com>` },
      { name: "Date", value: "Wed, 19 Aug 2026 15:04:00 +0000" },
    ],
    body: {
      data: b64url(asHtml
        ? "<html><body>" +
          f.body.split("\n\n").map((p) => `<p>${p}</p>`).join("") +
          "</body></html>"
        : f.body),
    },
  },
} as GmailMessage);

// ---------------------------------------------------------------------------
console.log("\n-- parsing each real variant, plain text --");
// ---------------------------------------------------------------------------
for (const f of FIXTURES) {
  const r = wiseEmailParser.parse(inbound(f) as never);
  if (!r.ok) {
    check(`${f.label}: parses`, false, `${r.reason}/${r.detail}`);
    continue;
  }
  const t = r.transaction;
  check(`${f.label}: parses`, true);
  check(`  merchant = "${f.expect.merchant}"`, t.merchant === f.expect.merchant, String(t.merchant));
  check(`  deducted = ${f.expect.eur} EUR (the authoritative amount)`,
    t.amount.value === f.expect.eur && t.amount.currency === "EUR", JSON.stringify(t.amount));
  check(`  merchant amount = ${f.expect.cop} COP (comma thousands parsed)`,
    t.merchantAmount?.value === f.expect.cop && t.merchantAmount?.currency === "COP",
    JSON.stringify(t.merchantAmount));
  check("  classified as a completed outgoing payment",
    t.direction === "out" && t.status === "completed");
}

// ---------------------------------------------------------------------------
console.log("\n-- the same variants as HTML-only mail --");
// ---------------------------------------------------------------------------
// messageText() reduces HTML to text before matching, so both MIME shapes of
// the same notification must behave identically.
for (const f of FIXTURES) {
  const html = "<html><body>" +
    f.body.split("\n\n").map((p) => `<p>${p}</p>`).join("") +
    "</body></html>";
  const r = wiseEmailParser.parse({ ...inbound(f), text: null, html } as never);
  check(`${f.label}: parses from HTML too`, r.ok, r.ok ? "" : `${r.reason}/${r.detail}`);
  if (r.ok) {
    check(`  HTML merchant matches plain text`, r.transaction.merchant === f.expect.merchant);
    check(`  HTML amount matches plain text`, r.transaction.amount.value === f.expect.eur);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- the subject is metadata, never the source of truth --");
// ---------------------------------------------------------------------------
{
  // Both subject shapes appear in real mail for the same kind of transaction,
  // so nothing may key off "Card payment:" being present.
  const withPrefix = FIXTURES[0];
  const withoutPrefix = FIXTURES[1];
  check("a subject WITH 'Card payment:' parses",
    wiseEmailParser.parse(inbound(withPrefix) as never).ok);
  check("a subject WITHOUT 'Card payment:' parses",
    wiseEmailParser.parse(inbound(withoutPrefix) as never).ok);

  // Strip the subject entirely: the body alone must still be enough.
  const noSubject = wiseEmailParser.parse({ ...inbound(FIXTURES[3]), subject: "" } as never);
  check("an empty subject still parses -- the body carries the facts", noSubject.ok,
    noSubject.ok ? "" : `${noSubject.reason}/${noSubject.detail}`);
  if (noSubject.ok) {
    check("  and yields the same merchant", noSubject.transaction.merchant === "DiDi");
  }

  // A misleading subject must not override the body.
  const misleading = wiseEmailParser.parse({
    ...inbound(FIXTURES[3]), subject: "Card payment: 999,999 COP spent at Somewhere Else",
  } as never);
  check("a misleading subject does not override the body", misleading.ok &&
    misleading.transaction.merchant === "DiDi" && misleading.transaction.amount.value === 6.45,
    misleading.ok ? JSON.stringify(misleading.transaction.merchant) : "did not parse");
}

// ---------------------------------------------------------------------------
console.log("\n-- the account phrasing is optional, not tied to 'Wise' --");
// ---------------------------------------------------------------------------
{
  const variants: Array<[string, boolean]> = [
    ["This used 6.45 EUR from your account.", true],
    ["This used 6.45 EUR from your Wise account.", true],
    ["This used 6.45 EUR from your Wise Business account.", true],
    ["This used 6.45 EUR from your account", true],
  ];
  for (const [line, shouldParse] of variants) {
    const r = wiseEmailParser.parse({
      ...inbound(FIXTURES[3]),
      text: `You spent 22,768 COP at DiDi.\n\n${line}`,
    } as never);
    check(`"${line}" -> ${shouldParse ? "parses" : "rejected"}`, r.ok === shouldParse,
      r.ok ? "" : `${r.reason}/${r.detail}`);
  }

  // It must still be a real "used ... from your ... account" sentence.
  for (const line of ["This used up your monthly allowance.", "Your account balance is 6.45 EUR."]) {
    const r = wiseEmailParser.parse({
      ...inbound(FIXTURES[3]), text: `You spent 22,768 COP at DiDi.\n\n${line}`,
    } as never);
    check(`"${line}" is NOT mistaken for a deduction`, !r.ok);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- the deducted EUR amount is required --");
// ---------------------------------------------------------------------------
{
  // Without the second sentence there is no authoritative account amount, and
  // guessing one from the merchant currency would invent a number.
  const r = wiseEmailParser.parse({
    ...inbound(FIXTURES[3]), text: "You spent 22,768 COP at DiDi.",
  } as never);
  check("a message with no 'This used ...' sentence is unparsed, never guessed", !r.ok,
    r.ok ? JSON.stringify(r.transaction.amount) : "");
  check("and is reported as unparsed rather than skipped",
    !r.ok && r.reason === "unparsed", !r.ok ? r.reason : "");
}

// ---------------------------------------------------------------------------
// End-to-end through the real sync
// ---------------------------------------------------------------------------

class FakeDb {
  store: Record<string, Row[]> = {};
  seq = 0;
  rows(t: string) { return (this.store[t] ??= []); }
  select(path: string): Promise<Row[]> {
    const [table, qs] = path.split("?");
    const params = new URLSearchParams(qs ?? "");
    const filters: Array<[string, string, string]> = [];
    for (const [k, v] of params) {
      if (["select", "limit", "order", "on_conflict"].includes(k)) continue;
      if (v.startsWith("eq.")) filters.push([k, decodeURIComponent(v.slice(3)), "eq"]);
      // PostgREST neq. The dedupe layers use it to exclude the row being
      // processed; a fake that ignored it would let the self-collision bug
      // pass unnoticed, which is exactly how it survived this long.
      if (v.startsWith("neq.")) filters.push([k, decodeURIComponent(v.slice(4)), "neq"]);
      if (v === "is.true") filters.push([k, "true", "eq"]);
    }
    return Promise.resolve(
      this.rows(table)
        .filter((r) => filters.every(([k, v, op]) => op === "neq" ? String(r[k]) !== v : String(r[k]) === v))
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
    const filters: Array<[string, string, string]> = [];
    for (const [k, v] of params) {
      if (v.startsWith("eq.")) filters.push([k, decodeURIComponent(v.slice(3)), "eq"]);
      if (v.startsWith("neq.")) filters.push([k, decodeURIComponent(v.slice(4)), "neq"]);
    }
    for (const r of this.rows(table)) {
      if (filters.every(([k, v, op]) => op === "neq" ? String(r[k]) !== v : String(r[k]) === v)) {
        Object.assign(r, body);
      }
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

function gmailFetch(messages: GmailMessage[]) {
  const impl = (url: string): Promise<Response> => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "at", expires_in: 3600, scope: GMAIL_SCOPE,
      }), { status: 200 }));
    }
    if (url.includes("/messages?")) {
      return Promise.resolve(new Response(JSON.stringify({
        messages: messages.map((m) => ({ id: m.id })),
        nextPageToken: null,
        resultSizeEstimate: messages.length,
      }), { status: 200 }));
    }
    const id = decodeURIComponent(url.split("/messages/")[1]?.split("?")[0] ?? "");
    return Promise.resolve(new Response(
      JSON.stringify(messages.find((m) => m.id === id) ?? {}), { status: 200 }));
  };
  return { impl };
}

const depsFor = (db: FakeDb, fetchImpl: GmailSyncDeps["fetchImpl"]): GmailSyncDeps => ({
  db: db as unknown as GmailSyncDeps["db"],
  now: () => new Date("2026-08-19T16:00:00.000Z"),
  fetchImpl,
  clientId: "cid",
  clientSecret: "secret",
  encrypt: () => Promise.resolve({ ciphertext: "CT", iv: "IV" }),
  decrypt: () => Promise.resolve(JSON.stringify({ refresh_token: "rt-1" })),
  lookbackDays: 8,
  label: null,
});

const CONNS = [{ id: "conn-1", user_id: "user-1" }];

/** Every message must land in exactly one bucket. */
function assertAccounted(stats: SyncStats, label: string) {
  check(`${label}: every message is accounted for`,
    stats.unaccountedFor === 0, JSON.stringify(stats));
}

// ---------------------------------------------------------------------------
console.log("\n-- all four variants import end to end --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const { impl } = gmailFetch(FIXTURES.map((f) => gmailMessage(f)));
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);

  check("all four are discovered", stats.gmailMessagesListed === 4, JSON.stringify(stats));
  check("all four import", stats.expensesImported === 4, JSON.stringify(stats));
  check("none is unparsed", stats.unparsed === 0);
  check("none is rejected by the template gate", stats.rejectedTemplate === 0);
  check("four expenses exist", db.store.expenses.length === 4);
  assertAccounted(stats, "first run");

  // Each expense carries the deducted EUR as the authoritative amount.
  for (const f of FIXTURES) {
    const exp = db.store.expenses.find((e) => e.note === f.expect.merchant);
    check(`  ${f.expect.merchant}: expense created`, !!exp);
    if (exp) {
      check(`  ${f.expect.merchant}: amount_orig is the deducted EUR`,
        exp.amount_orig === f.expect.eur && exp.currency === "EUR",
        `${exp.amount_orig} ${exp.currency}`);
      check(`  ${f.expect.merchant}: merchant COP kept as metadata`,
        exp.merchant_amount === f.expect.cop && exp.merchant_currency === "COP");
      check(`  ${f.expect.merchant}: flagged as a conversion`,
        exp.had_currency_conversion === true);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- a retried row is NOT deduped against itself --");
// ---------------------------------------------------------------------------
// The self-collision: a previous attempt stamps rfc_message_id on the row, and
// the retry then matches its own row unless the dedupe query excludes it.
{
  const db = seedDb();
  // A row left `unparsed` by an earlier run, already carrying its Message-ID
  // exactly as the pre-fix code would have written it.
  db.rows("email_import_messages").push({
    id: "email_import_messages-seed",
    connection_id: "conn-1",
    user_id: "user-1",
    source: "gmail",
    provider_message_id: FIXTURES[3].gmailId,
    rfc_message_id: `<${FIXTURES[3].gmailId}@wise.com>`,
    received_at: "2026-08-19T15:04:00.000Z",
    status: "unparsed",
    skip_reason: "parser_awaiting_samples",
  });

  const { impl } = gmailFetch([gmailMessage(FIXTURES[3])]);
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);

  check("the row is retried", stats.retriedRows === 1, JSON.stringify(stats));
  check("and IMPORTS rather than deduping against itself",
    stats.expensesImported === 1, JSON.stringify(stats));
  check("nothing is counted as a post-claim dedupe", stats.dedupedAfterClaim === 0);
  check("exactly one expense", db.store.expenses.length === 1);
  check("still exactly one ledger row", db.store.email_import_messages.length === 1);
  check("the row ends imported, not duplicate",
    db.store.email_import_messages[0].status === "imported",
    String(db.store.email_import_messages[0].status));
  assertAccounted(stats, "retry run");
}

// ---------------------------------------------------------------------------
console.log("\n-- a GENUINE cross-row duplicate is still caught --");
// ---------------------------------------------------------------------------
// Self-exclusion must not weaken real dedupe: a DIFFERENT row holding the same
// Message-ID still wins.
{
  const db = seedDb();
  db.rows("email_import_messages").push({
    id: "email_import_messages-other",
    connection_id: "conn-1",
    user_id: "user-1",
    source: "resend",
    provider_message_id: "resend-abc",           // a different delivery
    rfc_message_id: `<${FIXTURES[3].gmailId}@wise.com>`, // same underlying mail
    received_at: "2026-08-19T15:04:00.000Z",
    status: "imported",
    expense_id: "expenses-pre-existing",
  });

  const { impl } = gmailFetch([gmailMessage(FIXTURES[3])]);
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);

  check("no expense is created", stats.expensesImported === 0, JSON.stringify(stats));
  check("it is reported as a post-claim dedupe", stats.dedupedAfterClaim === 1);
  check("and counted in duplicatesSkipped as before", stats.duplicatesSkipped === 1);
  check("no expense row", db.store.expenses.length === 0);
  assertAccounted(stats, "cross-row duplicate run");
}

// ---------------------------------------------------------------------------
console.log("\n-- the accounting invariant --");
// ---------------------------------------------------------------------------
{
  // A mixed batch: an importable message, genuine Wise mail that is not a
  // transaction, and a message that dedupes against a different row.
  const db = seedDb();
  db.rows("email_import_messages").push({
    id: "email_import_messages-other",
    connection_id: "conn-1", user_id: "user-1", source: "resend",
    provider_message_id: "resend-xyz",
    rfc_message_id: `<${FIXTURES[1].gmailId}@wise.com>`,
    received_at: "2026-08-19T15:04:00.000Z",
    status: "imported", expense_id: "expenses-pre",
  });
  const statement: GmailMessage = {
    id: "1993d0e5081cf544",
    internalDate: "1787670240000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Wise <noreply@wise.com>" },
        { name: "Subject", value: "Your monthly Wise statement is ready" },
        { name: "Message-ID", value: "<1993d0e5081cf544@wise.com>" },
        { name: "Date", value: "Wed, 19 Aug 2026 15:04:00 +0000" },
      ],
      body: { data: b64url("Hi Alex,\n\nYour statement is ready to download.") },
    },
  } as GmailMessage;

  const { impl } = gmailFetch([
    gmailMessage(FIXTURES[0]), gmailMessage(FIXTURES[1]), statement,
  ]);
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);

  check("three messages seen", stats.messagesSeen === 3, JSON.stringify(stats));
  check("one imported", stats.expensesImported === 1);
  check("one deduped after claim", stats.dedupedAfterClaim === 1);
  check("one unparsed", stats.unparsed === 1);
  assertAccounted(stats, "mixed batch");

  const sum = stats.expensesImported + stats.duplicatesAlreadyImported +
    stats.terminalSkipped + stats.dedupedAfterClaim + stats.unparsed +
    stats.skipped + stats.failed;
  check("the buckets sum exactly to messagesSeen", sum === stats.messagesSeen,
    `${sum} vs ${stats.messagesSeen}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- reconcileStats detects an unreported outcome --");
// ---------------------------------------------------------------------------
{
  // The invariant must actually be able to FAIL, or it proves nothing.
  const rigged = {
    messagesSeen: 31, expensesImported: 0, duplicatesAlreadyImported: 0,
    terminalSkipped: 0, dedupedAfterClaim: 0, unparsed: 0, skipped: 0, failed: 0,
    unaccountedFor: 0,
  } as SyncStats;
  reconcileStats(rigged);
  check("31 messages with no recorded outcome is reported, not hidden",
    rigged.unaccountedFor === 31, JSON.stringify(rigged.unaccountedFor));

  const balanced = {
    messagesSeen: 3, expensesImported: 1, duplicatesAlreadyImported: 1,
    terminalSkipped: 0, dedupedAfterClaim: 0, unparsed: 1, skipped: 0, failed: 0,
    unaccountedFor: 99,
  } as SyncStats;
  reconcileStats(balanced);
  check("a balanced run reports zero unaccounted", balanced.unaccountedFor === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
