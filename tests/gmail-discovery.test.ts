// Gmail discovery-layer tests.
//
//   node --experimental-strip-types tests/gmail-discovery.test.ts
//
// Regression coverage for the third and final act of a real incident. After
// the ledger-claim fix and the retry fix, a manual sync STILL reported
//
//   { messagesSeen: 39, expensesImported: 0, duplicatesSkipped: 39 }
//
// on a day with real purchases, while ledger_status.sql showed nothing stuck.
// Nothing was failing, because nothing was being found: the discovery query
// asked Gmail for the single literal address `from:noreply@wise.com`, while
// the sender-authenticity gate that runs afterwards (isWiseSender) has always
// accepted ANY address at wise.com or transferwise.com, subdomains included.
//
// Discovery was therefore strictly narrower than the trust boundary the rest
// of the pipeline enforces. A card-payment notice from any other Wise address
// -- a different local part, a sending subdomain, a regional domain -- would
// have passed every check in the importer, but was never listed, so it could
// not be imported and left no ledger row, no failure and no counter. It was
// simply absent, which is the one outcome none of the existing diagnostics
// could report.
//
// These tests pin: the query covers the domains isWiseSender trusts and no
// more, non-Wise mail is still rejected, Wise mail that is not a card payment
// is still rejected, the lookback window still bounds discovery, and the
// duplicate/retry guarantees are untouched by any of it.

import {
  buildWiseQuery,
} from "../supabase/functions/_shared/gmail.ts";
import {
  WISE_SENDER_DOMAINS, isWiseSender, wiseEmailParser,
} from "../supabase/functions/_shared/parse-wise-email.ts";
import {
  syncGmailConnections, type GmailSyncDeps,
} from "../supabase/functions/_shared/gmail-sync.ts";
import { gmailToInboundMessage, type GmailMessage } from "../supabase/functions/_shared/gmail-message.ts";
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
const ID_D = "1993a8046b21ca37";

/**
 * A Wise card-payment notification. `from` is parameterised because the whole
 * point of this file is which sender addresses are and are not discoverable.
 */
const cardPayment = (
  id: string,
  from = "Wise <noreply@wise.com>",
  eur = 19.76,
): GmailMessage => {
  const cop = Math.round(eur * 3610);
  const text = `Hi Alex,\n\nYou spent ${cop.toLocaleString("en-US")} COP at Éxito Express.\n\n` +
    `This used ${eur.toFixed(2)} EUR from your account.\n\nThanks for using Wise.`;
  return {
    id,
    internalDate: "1785769440000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "alex@example.com" },
        { name: "Subject", value: `${cop.toLocaleString("en-US")} COP spent at Éxito Express` },
        { name: "Message-ID", value: `<${id}@wise.com>` },
        { name: "Date", value: "Mon, 03 Aug 2026 15:04:00 +0000" },
      ],
      body: { data: b64url(text) },
    },
  } as GmailMessage;
};

/** Genuine Wise mail that is NOT a transaction: marketing / statements. */
const wiseMarketing = (id: string, from = "Wise <noreply@wise.com>"): GmailMessage => ({
  id,
  internalDate: "1785769440000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: from },
      { name: "To", value: "alex@example.com" },
      { name: "Subject", value: "Your monthly Wise statement is ready" },
      { name: "Message-ID", value: `<${id}@wise.com>` },
      { name: "Date", value: "Mon, 03 Aug 2026 15:04:00 +0000" },
    ],
    body: {
      data: b64url("Hi Alex,\n\nYour statement is ready to download in the app.\n\n" +
        "Explore Wise Interest and start earning.\n\nThe Wise team"),
    },
  },
} as GmailMessage);

/** Mail from somewhere else entirely, e.g. a lookalike or an unrelated bank. */
const nonWise = (id: string, from: string): GmailMessage => ({
  id,
  internalDate: "1785769440000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: from },
      { name: "To", value: "alex@example.com" },
      { name: "Subject", value: "71,362 COP spent at Éxito Express" },
      { name: "Message-ID", value: `<${id}@example.net>` },
      { name: "Date", value: "Mon, 03 Aug 2026 15:04:00 +0000" },
    ],
    body: {
      data: b64url("Hi Alex,\n\nYou spent 71,362 COP at Éxito Express.\n\n" +
        "This used 19.76 EUR from your account."),
    },
  },
} as GmailMessage);

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
      if (v === "is.true") filters.push([k, "true"]);
    }
    return Promise.resolve(
      this.rows(table).filter((r) => filters.every(([k, v]) => String(r[k]) === v)).map((r) => ({ ...r })),
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

/**
 * A fake Gmail that actually HONOURS the `q` parameter's `from:` term, so a
 * message the query does not cover is genuinely never listed -- exactly how
 * the real incident presented. `capturedQuery` records what was asked.
 */
function gmailFetch(messages: GmailMessage[]) {
  const captured: { query: string | null } = { query: null };
  const senderOf = (m: GmailMessage): string => {
    const h = (m.payload?.headers ?? []).find((x) => x.name.toLowerCase() === "from");
    const raw = h?.value ?? "";
    const angled = raw.match(/<([^>]+)>/);
    return (angled ? angled[1] : raw).trim().toLowerCase();
  };
  const matchesQuery = (m: GmailMessage, q: string): boolean => {
    const term = q.match(/from:\(([^)]*)\)/) ?? q.match(/from:(\S+)/);
    if (!term) return true;
    const terms = term[1].split(/\s+OR\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const addr = senderOf(m);
    // Gmail's from: matches the From HEADER; a bare domain term matches any
    // address at that domain, an address term matches that address.
    return terms.some((t) => (t.includes("@") ? addr === t : addr.endsWith("@" + t) || addr.endsWith("." + t)));
  };
  const impl = (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "at-fresh", expires_in: 3600, scope: GMAIL_SCOPE,
      }), { status: 200 }));
    }
    if (url.includes("/messages?")) {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      captured.query = q;
      const visible = messages.filter((m) => matchesQuery(m, q));
      return Promise.resolve(new Response(JSON.stringify({
        messages: visible.map((m) => ({ id: m.id })), nextPageToken: null,
      }), { status: 200 }));
    }
    const id = decodeURIComponent(url.split("/messages/")[1]?.split("?")[0] ?? "");
    const found = messages.find((m) => m.id === id);
    return Promise.resolve(new Response(JSON.stringify(found ?? {}), { status: 200 }));
  };
  return { impl, captured };
}

const depsFor = (db: FakeDb, fetchImpl: GmailSyncDeps["fetchImpl"], extra: Partial<GmailSyncDeps> = {}): GmailSyncDeps => ({
  db: db as unknown as GmailSyncDeps["db"],
  now: () => new Date("2026-08-03T16:00:00.000Z"),
  fetchImpl,
  clientId: "cid",
  clientSecret: "secret",
  ...fakeCrypto({ plaintext: JSON.stringify({ refresh_token: "rt-1" }) }),
  lookbackDays: 8,
  label: null,
  ...extra,
});

const CONNS = [{ id: "conn-1", user_id: "user-1" }];

// ---------------------------------------------------------------------------
console.log("\n-- the query covers exactly the senders the importer trusts --");
// ---------------------------------------------------------------------------
{
  const q = buildWiseQuery();
  check("default query is the documented one",
    q === "from:(wise.com OR transferwise.com) newer_than:8d", q);

  // The core invariant: discovery must not be narrower than validation.
  for (const domain of WISE_SENDER_DOMAINS) {
    check(`discovery covers the trusted domain "${domain}"`, q.includes(domain), q);
  }
  check("no trusted domain is missing from the query",
    WISE_SENDER_DOMAINS.every((d) => q.includes(d)));

  check("still sender-scoped -- not a whole-mailbox search", q.startsWith("from:"));
  check("still time-bounded", q.includes("newer_than:8d"));
  check("uses OR inside one from: term, not two ANDed from: terms",
    (q.match(/from:/g) ?? []).length === 1 && q.includes(" OR "), q);
  check("does NOT reach into Spam or Trash", !q.includes("in:anywhere") && !q.includes("in:spam"));

  const labelled = buildWiseQuery({ label: "Wise Import" });
  check("an optional label still narrows it further", labelled.includes('label:"Wise Import"'), labelled);
  check("lookback still configurable", buildWiseQuery({ lookbackDays: 30 }).includes("newer_than:30d"));
  check("a nonsense lookback still falls back to 8 days",
    buildWiseQuery({ lookbackDays: 0 }).includes("newer_than:8d"));

  // Escape hatch, in case Wise ever sends from a domain not yet listed.
  check("senders can be overridden with a CSV string",
    buildWiseQuery({ senders: "wise.com, e.wise.com" }) ===
      "from:(wise.com OR e.wise.com) newer_than:8d");
  check("a single override collapses to a bare from: term",
    buildWiseQuery({ senders: "noreply@wise.com" }) === "from:noreply@wise.com newer_than:8d");
  check("an empty override falls back to the trusted domains",
    buildWiseQuery({ senders: [] }) === "from:(wise.com OR transferwise.com) newer_than:8d");
}

// ---------------------------------------------------------------------------
console.log("\n-- isWiseSender: the trust boundary discovery must match --");
// ---------------------------------------------------------------------------
{
  for (const addr of [
    "noreply@wise.com",
    "no-reply@wise.com",
    "notifications@wise.com",
    "noreply@e.wise.com",
    "alerts@mail.wise.com",
    "noreply@transferwise.com",
  ]) {
    check(`accepts a Wise address: ${addr}`, isWiseSender(addr) === true);
  }
  for (const addr of [
    "noreply@wise.com.evil.net",
    "noreply@notwise.com",
    "noreply@wise.co",
    "noreply@example.com",
    "",
    "not-an-address",
  ]) {
    check(`rejects: "${addr}"`, isWiseSender(addr) === false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- 1. existing noreply@wise.com notifications still import --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const { impl, captured } = gmailFetch([cardPayment(ID_A, "Wise <noreply@wise.com>")]);
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);

  check("imported", stats.expensesImported === 1, JSON.stringify(stats));
  check("one expense", db.store.expenses.length === 1);
  check("the query is reported back", stats.queryUsed === captured.query, String(stats.queryUsed));
  check("gmailMessagesListed reflects what Gmail returned", stats.gmailMessagesListed === 1);
  check("nothing rejected", stats.rejectedSender === 0 && stats.rejectedTemplate === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. a Wise notice from ANOTHER Wise address is now found --");
// ---------------------------------------------------------------------------
// This is the case the old `from:noreply@wise.com` query could never see.
{
  for (const from of [
    "Wise <no-reply@wise.com>",
    "Wise <notifications@wise.com>",
    "Wise <noreply@e.wise.com>",
    "Wise <noreply@transferwise.com>",
  ]) {
    const db = seedDb();
    const { impl } = gmailFetch([cardPayment(ID_A, from)]);
    const stats = await syncGmailConnections(depsFor(db, impl), CONNS);
    check(`discovered and imported from ${from}`,
      stats.expensesImported === 1 && db.store.expenses.length === 1, JSON.stringify(stats));
  }

  // And prove the OLD query genuinely could not: same message, old sender term.
  const db = seedDb();
  const { impl } = gmailFetch([cardPayment(ID_A, "Wise <no-reply@wise.com>")]);
  const stats = await syncGmailConnections(
    depsFor(db, impl, { senders: "noreply@wise.com" }), CONNS,
  );
  check("REGRESSION PROOF: the old narrow query lists nothing",
    stats.gmailMessagesListed === 0, JSON.stringify(stats));
  check("...so it imports nothing", stats.expensesImported === 0);
  check("...and reports zero failures, zero skips -- the message is simply absent",
    stats.failed === 0 && stats.skipped === 0 && stats.unparsed === 0 &&
    stats.duplicatesSkipped === 0, JSON.stringify(stats));
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. unrelated Wise marketing mail is rejected --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const { impl } = gmailFetch([wiseMarketing(ID_A)]);
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);

  check("it IS discovered (it is genuinely from Wise)", stats.gmailMessagesListed === 1);
  check("but no expense is created", stats.expensesImported === 0 && db.store.expenses.length === 0);
  check("rejected at the template gate, not the sender gate",
    stats.rejectedTemplate === 1 && stats.rejectedSender === 0, JSON.stringify(stats));
  const led = db.store.email_import_messages[0];
  check("and it leaves a ledger row rather than vanishing", !!led);
  check("marked unparsed or skipped, never imported",
    led.status === "unparsed" || led.status === "skipped", String(led.status));
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. unrelated / lookalike mail is rejected --");
// ---------------------------------------------------------------------------
{
  // A lookalike domain that Gmail's from: would NOT match, so it is never
  // even listed.
  const db = seedDb();
  const { impl } = gmailFetch([nonWise(ID_A, "Wise <noreply@wise.com.evil.net>")]);
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);
  check("a lookalike domain is never even listed", stats.gmailMessagesListed === 0, JSON.stringify(stats));
  check("no expense", db.store.expenses.length === 0);

  // Belt and braces: even if something non-Wise DID get listed (a stray label
  // rule, a future query change), the sender gate still refuses it.
  const msg = nonWise(ID_B, "Not Wise <noreply@example.com>");
  const inbound = gmailToInboundMessage(msg);
  check("the sender gate independently refuses non-Wise mail",
    wiseEmailParser.recognises(inbound) === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. a message that arrived today is found immediately --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  // One already-imported message from earlier, plus a brand-new one.
  const older = cardPayment(ID_A, "Wise <noreply@wise.com>", 19.76);
  const { impl } = gmailFetch([older]);
  const first = await syncGmailConnections(depsFor(db, impl), CONNS);
  check("the earlier message imports", first.expensesImported === 1);

  // Now today's purchase lands, from a different Wise address.
  const todays = cardPayment(ID_B, "Wise <no-reply@wise.com>", 6.45);
  const second = gmailFetch([older, todays]);
  const stats = await syncGmailConnections(depsFor(db, second.impl), CONNS);

  check("both are listed", stats.gmailMessagesListed === 2, JSON.stringify(stats));
  check("today's message imports on the very next sync", stats.expensesImported === 1);
  check("the older one is still a duplicate", stats.duplicatesAlreadyImported === 1);
  check("two expenses in total", db.store.expenses.length === 2);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. a message older than the lookback is excluded --");
// ---------------------------------------------------------------------------
{
  // The lookback is enforced by Gmail via newer_than:, so the contract to pin
  // is that the term is present and carries the configured value.
  check("default query bounds discovery to 8 days",
    buildWiseQuery().includes("newer_than:8d"));
  check("a 1-day window is honoured", buildWiseQuery({ lookbackDays: 1 }).includes("newer_than:1d"));
  check("a widened window is honoured for replay",
    buildWiseQuery({ lookbackDays: 30 }).includes("newer_than:30d"));

  // A fake Gmail that drops anything outside the window, as the real one does.
  const db = seedDb();
  const old = cardPayment(ID_C, "Wise <noreply@wise.com>", 44.0);
  const impl = (url: string): Promise<Response> => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(new Response(JSON.stringify({
        access_token: "at", expires_in: 3600, scope: GMAIL_SCOPE,
      }), { status: 200 }));
    }
    if (url.includes("/messages?")) {
      // Outside newer_than: -> Gmail returns nothing.
      return Promise.resolve(new Response(JSON.stringify({ messages: [], nextPageToken: null }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(old), { status: 200 }));
  };
  const stats = await syncGmailConnections(depsFor(db, impl), CONNS);
  check("a message outside the window is never listed", stats.gmailMessagesListed === 0);
  check("and creates no expense", db.store.expenses.length === 0);
  check("the query is still reported for diagnosis", !!stats.queryUsed);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. duplicate safety is untouched by the wider query --");
// ---------------------------------------------------------------------------
{
  const db = seedDb();
  const msg = cardPayment(ID_A, "Wise <noreply@wise.com>");
  const { impl } = gmailFetch([msg]);
  await syncGmailConnections(depsFor(db, impl), CONNS);
  const second = await syncGmailConnections(depsFor(db, impl), CONNS);

  check("a repeat sync imports nothing", second.expensesImported === 0, JSON.stringify(second));
  check("counted as an already-imported duplicate", second.duplicatesAlreadyImported === 1);
  check("still exactly one expense", db.store.expenses.length === 1);
  check("still exactly one ledger row", db.store.email_import_messages.length === 1);

  // The SAME transaction arriving from a second Wise address must not become a
  // second expense: dedupe layers 2-4 (Message-ID, reference, fingerprint)
  // still apply to everything the wider query now finds.
  const dupFromOtherSender = cardPayment(ID_D, "Wise <no-reply@wise.com>", 19.76);
  const third = gmailFetch([msg, dupFromOtherSender]);
  const stats = await syncGmailConnections(depsFor(db, third.impl), CONNS);
  check("both are listed now", stats.gmailMessagesListed === 2, JSON.stringify(stats));
  check("but the same transaction does not import twice",
    db.store.expenses.length === 1, `${db.store.expenses.length} expenses`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
