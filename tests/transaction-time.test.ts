// Transaction timestamp + timezone tests, and the hourly cron contract.
//
//   node --experimental-strip-types tests/transaction-time.test.ts
//
// `spent_on` used to be `new Date().toISOString().slice(0, 10)` taken from the
// SYNC clock, because the Wise parser never produced an occurredAt and Gmail's
// internalDate -- which the message adapter already carried -- was dropped
// before it reached the importer. Two separate errors compounded:
//
//   * the expense landed on the day the sync ran, not the day of the purchase.
//     Hourly syncing makes that worse, not better: the same message imported
//     at 00:30 lands a day later than at 23:30, and a RETRY moves an expense
//     that had already been filed correctly.
//   * the day was the UTC day. 23:40 in America/Bogota is 04:40 UTC the NEXT
//     day, so late-evening spending was systematically filed under tomorrow.
//
// These tests pin the precedence (explicit > Gmail internalDate > sync clock),
// that the calendar day is rendered in the household's zone, that a retry
// reproduces the original day, and that the cron expression is exactly hourly.

import {
  buildExpenseRow, calendarDayIn, resolveOccurredAt, spentOn,
  DEFAULT_TIMEZONE,
  type ImportContext, type NormalizedTransaction, type Row,
} from "../supabase/functions/_shared/import-core.ts";
import {
  syncGmailConnections, type GmailSyncDeps,
} from "../supabase/functions/_shared/gmail-sync.ts";
import type { GmailMessage } from "../supabase/functions/_shared/gmail-message.ts";

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

// The worked example: 2026-08-24 23:40 America/Bogota == 2026-08-25 04:40 UTC.
const BOGOTA_LATE_NIGHT_UTC = "2026-08-25T04:40:00.000Z";
const SYNC_CLOCK = new Date("2026-09-01T10:00:00.000Z");

const tx = (over: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
  externalRef: null,
  occurredAt: null,
  direction: "out",
  status: "completed",
  amount: { value: 6.45, currency: "EUR" },
  merchantAmount: { value: 22768, currency: "COP" },
  merchant: "DiDi",
  categoryInput: { description: "DiDi" },
  ...over,
});

// ---------------------------------------------------------------------------
console.log("\n-- timestamp precedence --");
// ---------------------------------------------------------------------------
{
  const explicit = resolveOccurredAt(
    tx({ occurredAt: "2026-08-24T20:00:00Z", receivedAt: BOGOTA_LATE_NIGHT_UTC }),
    SYNC_CLOCK,
  );
  check("an explicit Wise timestamp wins over Gmail internalDate",
    explicit.source === "wise_explicit" && explicit.occurredAt === "2026-08-24T20:00:00.000Z",
    JSON.stringify(explicit));

  const gmail = resolveOccurredAt(tx({ receivedAt: BOGOTA_LATE_NIGHT_UTC }), SYNC_CLOCK);
  check("Gmail internalDate is used when there is no explicit timestamp",
    gmail.source === "gmail_internal_date" && gmail.occurredAt === BOGOTA_LATE_NIGHT_UTC,
    JSON.stringify(gmail));

  const fallback = resolveOccurredAt(tx(), SYNC_CLOCK);
  check("the sync clock is used ONLY when neither exists",
    fallback.source === "sync_fallback" && fallback.occurredAt === SYNC_CLOCK.toISOString(),
    JSON.stringify(fallback));

  // Garbage must not be preferred over a good lower-precedence source.
  const junkExplicit = resolveOccurredAt(
    tx({ occurredAt: "not-a-date", receivedAt: BOGOTA_LATE_NIGHT_UTC }), SYNC_CLOCK);
  check("an unparseable explicit timestamp falls through to internalDate",
    junkExplicit.source === "gmail_internal_date", JSON.stringify(junkExplicit));

  const junkBoth = resolveOccurredAt(
    tx({ occurredAt: "not-a-date", receivedAt: "also-not-a-date" }), SYNC_CLOCK);
  check("unparseable everything falls through to the sync clock",
    junkBoth.source === "sync_fallback", JSON.stringify(junkBoth));
}

// ---------------------------------------------------------------------------
console.log("\n-- timezone: the calendar day is the household's, not UTC --");
// ---------------------------------------------------------------------------
{
  check("23:40 in America/Bogota stays on 2026-08-24",
    calendarDayIn(BOGOTA_LATE_NIGHT_UTC, "America/Bogota") === "2026-08-24",
    calendarDayIn(BOGOTA_LATE_NIGHT_UTC, "America/Bogota"));

  check("the SAME instant is 2026-08-25 in UTC -- which is the old, wrong answer",
    calendarDayIn(BOGOTA_LATE_NIGHT_UTC, "UTC") === "2026-08-25");

  check("and 2026-08-25 in Europe/Amsterdam",
    calendarDayIn(BOGOTA_LATE_NIGHT_UTC, "Europe/Amsterdam") === "2026-08-25");

  // The reverse direction: early morning in a positive-offset zone.
  const earlyAmsterdam = "2026-08-24T22:30:00.000Z"; // 00:30 on the 25th in NL
  check("00:30 in Europe/Amsterdam is 2026-08-25 there",
    calendarDayIn(earlyAmsterdam, "Europe/Amsterdam") === "2026-08-25");
  check("...while the same instant is still 2026-08-24 in UTC",
    calendarDayIn(earlyAmsterdam, "UTC") === "2026-08-24");

  // Robustness: an unknown zone degrades to UTC rather than failing an import.
  check("an unknown timezone falls back to the UTC day, never throws",
    calendarDayIn(BOGOTA_LATE_NIGHT_UTC, "Mars/Olympus_Mons") === "2026-08-25");
  check("an invalid instant does not throw",
    typeof calendarDayIn("not-a-date", "America/Bogota") === "string");

  check("the default zone is UTC, preserving the previous behaviour",
    DEFAULT_TIMEZONE === "UTC");
}

// ---------------------------------------------------------------------------
console.log("\n-- spentOn() end to end --");
// ---------------------------------------------------------------------------
{
  const t = tx({ receivedAt: BOGOTA_LATE_NIGHT_UTC });
  check("Gmail internalDate + Bogota -> 2026-08-24",
    spentOn(t, SYNC_CLOCK, "America/Bogota") === "2026-08-24",
    spentOn(t, SYNC_CLOCK, "America/Bogota"));
  check("the sync clock is NOT used when internalDate exists",
    spentOn(t, SYNC_CLOCK, "America/Bogota") !== "2026-09-01");
  check("omitting the timezone keeps the old UTC behaviour",
    spentOn(t, SYNC_CLOCK) === "2026-08-25");
}

// ---------------------------------------------------------------------------
console.log("\n-- buildExpenseRow stores the instant and its provenance --");
// ---------------------------------------------------------------------------
{
  const ctx: ImportContext = {
    userId: "user-1", householdId: "hh-1", slot: 0,
    rates: { usd: 1.08, cop: 4500 },
    allowed: new Set(["transport", "other"]),
    now: SYNC_CLOCK,
    timezone: "America/Bogota",
  };

  const { row } = buildExpenseRow(ctx, tx({ receivedAt: BOGOTA_LATE_NIGHT_UTC }));
  check("spent_on is the Colombian calendar day", row.spent_on === "2026-08-24", row.spent_on);
  check("occurred_at is the authoritative instant", row.occurred_at === BOGOTA_LATE_NIGHT_UTC,
    String(row.occurred_at));
  check("occurred_at_source records where it came from",
    row.occurred_at_source === "gmail_internal_date", String(row.occurred_at_source));
  check("UTC conversion did NOT shift spent_on forward a day",
    row.spent_on !== row.occurred_at.slice(0, 10));

  const explicitRow = buildExpenseRow(ctx, tx({
    occurredAt: "2026-08-20T15:00:00Z", receivedAt: BOGOTA_LATE_NIGHT_UTC,
  })).row;
  check("an explicit timestamp drives spent_on", explicitRow.spent_on === "2026-08-20",
    explicitRow.spent_on);
  check("and is recorded as wise_explicit",
    explicitRow.occurred_at_source === "wise_explicit");

  const fallbackRow = buildExpenseRow(ctx, tx()).row;
  check("with neither source, the sync day is used",
    fallbackRow.spent_on === "2026-09-01", fallbackRow.spent_on);
  check("and is honestly labelled sync_fallback",
    fallbackRow.occurred_at_source === "sync_fallback");

  // A household with no configured zone behaves exactly as before.
  const utcRow = buildExpenseRow(
    { ...ctx, timezone: "UTC" }, tx({ receivedAt: BOGOTA_LATE_NIGHT_UTC })).row;
  check("an unconfigured (UTC) household is unchanged from the old behaviour",
    utcRow.spent_on === "2026-08-25", utcRow.spent_on);
}

// ---------------------------------------------------------------------------
// End to end, including retries and hourly overlap
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

function seedDb(timezone: string | null = "America/Bogota"): FakeDb {
  const db = new FakeDb();
  db.store.profiles = [{ id: "user-1", household_id: "hh-1", slot: 0 }];
  db.store.households = [{ id: "hh-1", usd_per_eur: 1.08, cop_per_eur: 4500, timezone }];
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

/** A DiDi card payment whose Gmail internalDate is the Bogota late-night instant. */
const lateNightMessage = (id: string, internalDateMs: number): GmailMessage => ({
  id,
  internalDate: String(internalDateMs),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Wise <noreply@wise.com>" },
      { name: "To", value: "alex@example.com" },
      { name: "Subject", value: "Card payment: 22,768 COP spent at DiDi" },
      { name: "Message-ID", value: `<${id}@wise.com>` },
      { name: "Date", value: "Tue, 25 Aug 2026 04:40:00 +0000" },
    ],
    body: {
      data: b64url("You spent 22,768 COP at DiDi.\n\nCard payment\n\n" +
        "This used 6.45 EUR from your Wise account."),
    },
  },
} as GmailMessage);

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
        nextPageToken: null, resultSizeEstimate: messages.length,
      }), { status: 200 }));
    }
    const id = decodeURIComponent(url.split("/messages/")[1]?.split("?")[0] ?? "");
    return Promise.resolve(new Response(
      JSON.stringify(messages.find((m) => m.id === id) ?? {}), { status: 200 }));
  };
  return { impl };
}

const depsAt = (db: FakeDb, fetchImpl: GmailSyncDeps["fetchImpl"], now: string): GmailSyncDeps => ({
  db: db as unknown as GmailSyncDeps["db"],
  now: () => new Date(now),
  fetchImpl,
  clientId: "cid", clientSecret: "secret",
  encrypt: () => Promise.resolve({ ciphertext: "CT", iv: "IV" }),
  decrypt: () => Promise.resolve(JSON.stringify({ refresh_token: "rt-1" })),
  lookbackDays: 8, label: null,
});

const CONNS = [{ id: "conn-1", user_id: "user-1" }];
const MSG_ID = "1993e0a1c4e8b100";
const INTERNAL_MS = Date.parse(BOGOTA_LATE_NIGHT_UTC);

// ---------------------------------------------------------------------------
console.log("\n-- end to end: Gmail internalDate decides the day --");
// ---------------------------------------------------------------------------
{
  const db = seedDb("America/Bogota");
  const { impl } = gmailFetch([lateNightMessage(MSG_ID, INTERNAL_MS)]);
  // Sync runs a week later, deliberately.
  const stats = await syncGmailConnections(depsAt(db, impl, "2026-09-01T10:00:00Z"), CONNS);

  check("it imports", stats.expensesImported === 1, JSON.stringify(stats));
  const exp = db.store.expenses[0];
  check("spent_on is the Colombian day of the purchase, not the sync day",
    exp.spent_on === "2026-08-24", String(exp.spent_on));
  check("and definitely not the sync date", exp.spent_on !== "2026-09-01");
  check("occurred_at is the Gmail internalDate instant",
    exp.occurred_at === BOGOTA_LATE_NIGHT_UTC, String(exp.occurred_at));
  check("provenance is gmail_internal_date",
    exp.occurred_at_source === "gmail_internal_date", String(exp.occurred_at_source));
}

// ---------------------------------------------------------------------------
console.log("\n-- a household with no timezone keeps the old UTC behaviour --");
// ---------------------------------------------------------------------------
{
  const db = seedDb(null);
  const { impl } = gmailFetch([lateNightMessage(MSG_ID, INTERNAL_MS)]);
  await syncGmailConnections(depsAt(db, impl, "2026-09-01T10:00:00Z"), CONNS);
  const exp = db.store.expenses[0];
  check("unconfigured household -> UTC day", exp.spent_on === "2026-08-25", String(exp.spent_on));
  check("but the instant is still recorded correctly",
    exp.occurred_at === BOGOTA_LATE_NIGHT_UTC);
}

// ---------------------------------------------------------------------------
console.log("\n-- a retry does not move the transaction date --");
// ---------------------------------------------------------------------------
{
  const db = seedDb("America/Bogota");
  // The row was left unparsed by an earlier run; the retry must reproduce the
  // ORIGINAL day, not the day the retry happens to run on.
  db.rows("email_import_messages").push({
    id: "email_import_messages-seed",
    connection_id: "conn-1", user_id: "user-1", source: "gmail",
    provider_message_id: MSG_ID,
    rfc_message_id: `<${MSG_ID}@wise.com>`,
    received_at: BOGOTA_LATE_NIGHT_UTC,
    status: "unparsed", skip_reason: "parser_awaiting_samples",
  });

  const { impl } = gmailFetch([lateNightMessage(MSG_ID, INTERNAL_MS)]);
  const stats = await syncGmailConnections(depsAt(db, impl, "2026-09-15T03:00:00Z"), CONNS);

  check("the retry imports", stats.expensesImported === 1 && stats.retriedRows === 1,
    JSON.stringify(stats));
  const exp = db.store.expenses[0];
  check("spent_on is STILL the original Colombian day",
    exp.spent_on === "2026-08-24", String(exp.spent_on));
  check("not the retry's own date", exp.spent_on !== "2026-09-15");
  check("occurred_at is unchanged by the retry",
    exp.occurred_at === BOGOTA_LATE_NIGHT_UTC, String(exp.occurred_at));
  check("provenance is still gmail_internal_date, not sync_fallback",
    exp.occurred_at_source === "gmail_internal_date");
}

// ---------------------------------------------------------------------------
console.log("\n-- hourly overlap creates no duplicates --");
// ---------------------------------------------------------------------------
{
  // Twelve hourly runs over the same 8-day window, exactly what the cron does.
  const db = seedDb("America/Bogota");
  const { impl } = gmailFetch([lateNightMessage(MSG_ID, INTERNAL_MS)]);
  let firstStats;
  for (let hour = 0; hour < 12; hour++) {
    const at = new Date(Date.UTC(2026, 8, 1, hour, 0, 0)).toISOString();
    const s = await syncGmailConnections(depsAt(db, impl, at), CONNS);
    if (hour === 0) firstStats = s;
    check(`hour ${String(hour).padStart(2)}: every message accounted for`, s.unaccountedFor === 0,
      JSON.stringify(s));
  }
  check("the first run imported it", firstStats!.expensesImported === 1);
  check("after 12 hourly runs there is still exactly ONE expense",
    db.store.expenses.length === 1, `${db.store.expenses.length} expenses`);
  check("and exactly one ledger row", db.store.email_import_messages.length === 1);
  check("its date never drifted", db.store.expenses[0].spent_on === "2026-08-24",
    String(db.store.expenses[0].spent_on));
}

// ---------------------------------------------------------------------------
console.log("\n-- the hourly cron contract, read from the migration --");
// ---------------------------------------------------------------------------
{
  const fs = await import("node:fs/promises");
  const sql = await fs.readFile(
    new URL("../supabase/migrations/20260824100100_gmail_hourly_cron.sql", import.meta.url),
    "utf8",
  );

  check("the schedule is exactly '0 * * * *'", sql.includes("'0 * * * *'::text"),
    (sql.match(/'[\d*\/ ,-]+'::text/) ?? ["<none>"])[0]);
  check("there is exactly ONE cron expression in the file",
    (sql.match(/'0 \* \* \* \*'/g) ?? []).length === 1);

  // Idempotence is structural: unschedule before schedule, keyed by one name.
  check("the job has a single stable name", sql.includes("'gmail-hourly-sync'"));
  // Compare positions inside the FUNCTION BODY only: the header comment also
  // mentions cron.schedule(), and matching that would make this assertion
  // pass or fail for reasons unrelated to the code.
  const body = sql.split("create or replace function public.ensure_gmail_hourly_sync()")[1] ?? "";
  check("an existing job is unscheduled before rescheduling",
    body.includes("perform cron.unschedule") &&
    body.indexOf("perform cron.unschedule") < body.indexOf("perform cron.schedule"),
    `unschedule@${body.indexOf("perform cron.unschedule")} schedule@${body.indexOf("perform cron.schedule")}`);
  check("the unschedule is guarded by an existence lookup, not blind",
    body.includes("from cron.job where jobname"));
  check("the installer is re-run on every deploy",
    sql.includes("ensure_gmail_hourly_sync()"));

  // Safety properties.
  check("it no-ops rather than failing when pg_cron is absent",
    sql.includes("skipped_no_pg_cron"));
  check("it no-ops when the vault entries are unset",
    sql.includes("skipped_not_configured"));
  check("the cron caller sends x-sync-secret", sql.includes("'x-sync-secret'"));
  check("the cron body marks the run as cron",
    sql.includes("'trigger', 'cron'"));
  check("NO secret is committed in the migration",
    !/SYNC_CRON_SECRET\s*=\s*['"][A-Za-z0-9+/=]{8,}/.test(sql) &&
    sql.includes("vault.decrypted_secrets"));
  check("only service_role may reinstall the schedule",
    sql.includes("grant execute on function public.ensure_gmail_hourly_sync() to service_role"));
  check("the 8-day lookback is untouched by this change",
    !sql.includes("GMAIL_LOOKBACK_DAYS"));
}

// ---------------------------------------------------------------------------
console.log("\n-- gmail-sync config: verify_jwt stays false --");
// ---------------------------------------------------------------------------
{
  const fs = await import("node:fs/promises");
  const toml = await fs.readFile(
    new URL("../supabase/config.toml", import.meta.url), "utf8");
  const block = toml.split("[functions.gmail-sync]")[1]?.split("[functions.")[0] ?? "";
  check("gmail-sync keeps verify_jwt = false so the cron call reaches it",
    /verify_jwt\s*=\s*false/.test(block), block.trim().slice(0, 80));
  check("scan-receipt still requires a JWT (it has no internal auth)",
    /verify_jwt\s*=\s*true/.test(toml.split("[functions.scan-receipt]")[1]?.split("[functions.")[0] ?? ""));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
