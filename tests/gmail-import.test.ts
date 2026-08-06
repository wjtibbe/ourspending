// Gmail OAuth + polling import tests.
//
//   node --experimental-strip-types tests/gmail-import.test.ts
//
// Covers the Gmail-specific half of the import path: OAuth state handling,
// PKCE, the restrictive search query, MIME decoding, token refresh and the
// two isolation guarantees (one bad message, one bad connection). The Wise
// parsing and expense rules themselves are NOT re-tested here -- they are the
// same code as the Resend path and are covered by inbound-email.test.ts and
// import-core.test.ts. That is the point of the shared core.
//
// _shared modules read Deno.env at import time, so a stub is installed first.

(globalThis as Record<string, unknown>).Deno = {
  env: { get: () => undefined },
  serve: () => {},
};

import {
  base64UrlDecode, decodeEncodedWords, extractBodies, gmailToInboundMessage,
  headerValue, type GmailMessage,
} from "../supabase/functions/_shared/gmail-message.ts";
import {
  buildAuthUrl, buildWiseQuery, codeChallengeOf, exchangeCode, getMessage,
  GmailError, GMAIL_SCOPE, listMessageIds, needsReconnect, randomToken,
  refreshAccessToken,
} from "../supabase/functions/_shared/gmail.ts";
import {
  syncGmailConnections, type GmailSyncDeps,
} from "../supabase/functions/_shared/gmail-sync.ts";
import type { Row } from "../supabase/functions/_shared/import-core.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

// ---------------------------------------------------------------------------
// Fixtures — sanitised, built from the real Wise template already in the repo
// ---------------------------------------------------------------------------
const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const WISE_TEXT = "Hi Alex,\n\nYou spent 71,362 COP at Éxito Express.\n\n" +
  "This used 19.76 EUR from your account.\n\nThanks for using Wise.";
const WISE_HTML = "<html><body><p>Hi Alex,</p>" +
  "<p>You spent 71,362 COP at Éxito Express.</p>" +
  "<p>This used 19.76 EUR from your account.</p></body></html>";

const wiseHeaders = (msgId: string) => [
  { name: "From", value: "Wise <noreply@wise.com>" },
  { name: "To", value: "alex@example.com" },
  { name: "Subject", value: "71,362 COP spent at Éxito Express" },
  { name: "Message-ID", value: msgId },
  { name: "Date", value: "Mon, 03 Aug 2026 15:04:00 +0000" },
];

/** multipart/alternative: the ordinary Wise shape. */
const alternativeMessage = (id: string, msgId = `<${id}@wise.com>`): GmailMessage => ({
  id,
  internalDate: "1785769440000",
  payload: {
    mimeType: "multipart/alternative",
    headers: wiseHeaders(msgId),
    parts: [
      { mimeType: "text/plain", body: { data: b64url(WISE_TEXT) } },
      { mimeType: "text/html", body: { data: b64url(WISE_HTML) } },
    ],
  },
});

/** multipart/mixed wrapping multipart/alternative, plus an attachment. */
const nestedMessage = (id: string): GmailMessage => ({
  id,
  internalDate: "1785769440000",
  payload: {
    mimeType: "multipart/mixed",
    headers: wiseHeaders(`<${id}@wise.com>`),
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url(WISE_TEXT) } },
          { mimeType: "text/html", body: { data: b64url(WISE_HTML) } },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "receipt.pdf",
        body: { attachmentId: "att-1", size: 9999 },
      },
    ],
  },
});

console.log("\n-- base64url decoding --");
{
  check("decodes plain ASCII", base64UrlDecode(b64url("hello")) === "hello");
  check("decodes multi-byte UTF-8 intact (the Éxito trap)",
    base64UrlDecode(b64url("Éxito Express")) === "Éxito Express",
    base64UrlDecode(b64url("Éxito Express")));
  check("handles the URL alphabet (- and _)",
    base64UrlDecode(b64url("~~~??>>>ÿ")) === "~~~??>>>ÿ");
  check("handles missing padding", base64UrlDecode(b64url("abcde")) === "abcde");
  check("empty input -> empty string", base64UrlDecode("") === "");
  check("garbage does not throw", base64UrlDecode("!!!not base64!!!") === "");
  const amount = base64UrlDecode(b64url("71.362 COP"));
  check("an amount survives byte-for-byte", amount === "71.362 COP", amount);
}

console.log("\n-- MIME structure --");
{
  const flat: GmailMessage = {
    id: "m1",
    payload: {
      mimeType: "text/plain",
      headers: wiseHeaders("<m1@wise.com>"),
      body: { data: b64url(WISE_TEXT) },
    },
  };
  const single = extractBodies(flat.payload);
  check("top-level text/plain is found", single.text?.includes("71,362 COP") === true);
  check("no html when there is none", single.html === null);

  const alt = extractBodies(alternativeMessage("m2").payload);
  check("multipart/alternative: plain text found", alt.text?.includes("Éxito Express") === true);
  check("multipart/alternative: html found", alt.html?.includes("<p>") === true);

  const nested = extractBodies(nestedMessage("m3").payload);
  check("nested multipart/mixed > alternative: plain text found",
    nested.text?.includes("19.76 EUR") === true);
  check("nested multipart/mixed > alternative: html found",
    nested.html?.includes("Éxito Express") === true);

  const htmlOnly = extractBodies({
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/html", body: { data: b64url(WISE_HTML) } }],
  });
  check("html-only message still yields html", htmlOnly.html !== null);
  check("html-only message has no text part", htmlOnly.text === null);

  check("attachments are ignored", !JSON.stringify(nested).includes("receipt.pdf"));
  const attachmentOnly = extractBodies({
    mimeType: "multipart/mixed",
    parts: [{
      mimeType: "text/plain",
      filename: "notes.txt",
      body: { data: b64url("should not be read") },
    }],
  });
  check("a text/plain ATTACHMENT is not treated as the body",
    attachmentOnly.text === null);

  check("missing payload is handled", extractBodies(undefined).text === null);
  check("payload with no parts and no body is handled",
    extractBodies({ mimeType: "multipart/mixed" }).text === null);
}

console.log("\n-- headers --");
{
  const h = wiseHeaders("<x@wise.com>");
  check("lookup is case-insensitive", headerValue(h, "from") === "Wise <noreply@wise.com>");
  check("missing header -> null", headerValue(h, "X-Nope") === null);
  check("undefined headers -> null", headerValue(undefined, "From") === null);

  // btoa() is latin1, so the payload must be built from real UTF-8 bytes --
  // which is exactly what a genuine =?UTF-8?B?...?= header contains.
  const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
  check("decodes a base64 encoded-word",
    decodeEncodedWords("=?UTF-8?B?" + b64("Éxito") + "?=") === "Éxito",
    decodeEncodedWords("=?UTF-8?B?" + b64("Éxito") + "?="));
  check("decodes an encoded-word carrying an accented merchant name",
    decodeEncodedWords("=?UTF-8?B?" + b64("71,362 COP spent at Éxito Express") + "?=")
      === "71,362 COP spent at Éxito Express");
  check("decodes a quoted-printable encoded-word",
    decodeEncodedWords("=?UTF-8?Q?71=2C362_COP?=") === "71,362 COP",
    decodeEncodedWords("=?UTF-8?Q?71=2C362_COP?="));
  check("plain text passes through untouched",
    decodeEncodedWords("71,362 COP spent") === "71,362 COP spent");
  check("malformed encoded-word is not mangled",
    decodeEncodedWords("=?UTF-8?B?%%%?=").includes("=?UTF-8?"));
}

console.log("\n-- Gmail message -> InboundMessage --");
{
  const msg = gmailToInboundMessage(alternativeMessage("gm-1"))!;
  check("uses the Gmail id as the provider message id", msg.providerMessageId === "gm-1");
  check("captures the sender", msg.from === "Wise <noreply@wise.com>");
  check("captures the subject", msg.subject === "71,362 COP spent at Éxito Express");
  check("captures the RFC Message-ID", msg.rfcMessageId === "<gm-1@wise.com>");
  check("converts internalDate to ISO", msg.receivedAt === "2026-08-03T15:04:00.000Z", msg.receivedAt);
  check("carries the text body", msg.text?.includes("You spent 71,362 COP") === true);
  check("carries the html body", msg.html?.includes("Éxito Express") === true);
  check("a message with no id is refused", gmailToInboundMessage({ payload: {} }) === null);

  const noDate = gmailToInboundMessage({ id: "x", payload: { headers: [] } })!;
  check("missing internalDate falls back without throwing",
    typeof noDate.receivedAt === "string" && noDate.receivedAt.length > 0);
}

console.log("\n-- the Gmail search query stays narrow --");
{
  const q = buildWiseQuery();
  check("restricted to Wise's sender", q.includes("from:noreply@wise.com"));
  // 8 days, not 2: the job runs once daily, so the window must survive an
  // occasional missed run (a dead token, a transient failure) without losing
  // a transaction. Overlap is safe -- duplicate protection is four
  // independent dedupe keys, not a tight window (see the isolation/overlap
  // tests further down in this file).
  check("restricted to eight days by default", q.includes("newer_than:8d"), q);
  check("no label term unless configured", !q.includes("label:"));
  check("is exactly the documented default", q === "from:noreply@wise.com newer_than:8d", q);

  const labelled = buildWiseQuery({ label: "Wise Import" });
  check("an optional label narrows it further", labelled.includes('label:"Wise Import"'), labelled);
  check("a label with a space stays one term", labelled.includes('"Wise Import"'));

  check("lookback is configurable", buildWiseQuery({ lookbackDays: 5 }).includes("newer_than:5d"));
  check("a nonsense lookback falls back to 8 days",
    buildWiseQuery({ lookbackDays: 0 }).includes("newer_than:8d"));
  check("a blank label is ignored", !buildWiseQuery({ label: "  " }).includes("label:"));
}

console.log("\n-- OAuth: state, PKCE and the consent URL --");
{
  const a = randomToken(32), b = randomToken(32);
  check("state tokens are unguessable and unique", a !== b && a.length >= 40);
  check("state is URL-safe", /^[A-Za-z0-9_-]+$/.test(a), a);

  const verifier = "test-verifier-value";
  const challenge = await codeChallengeOf(verifier);
  check("PKCE challenge is S256 base64url", /^[A-Za-z0-9_-]{43}$/.test(challenge), challenge);
  check("the challenge is NOT the verifier", challenge !== verifier);
  check("the same verifier gives the same challenge",
    challenge === await codeChallengeOf(verifier));
  check("a different verifier gives a different challenge",
    challenge !== await codeChallengeOf("other-verifier"));

  const url = new URL(buildAuthUrl({
    clientId: "cid.apps.googleusercontent.com",
    redirectUri: "https://ref.supabase.co/functions/v1/gmail-oauth-callback",
    state: a,
    codeChallenge: challenge,
    forceConsent: true,
  }));
  check("requests ONLY gmail.readonly", url.searchParams.get("scope") === GMAIL_SCOPE);
  check("does not request send/modify/full scopes",
    !url.searchParams.get("scope")!.match(/send|modify|compose|full|https:\/\/mail\.google/));
  check("access_type=offline, so a refresh token is issued",
    url.searchParams.get("access_type") === "offline");
  check("carries the state", url.searchParams.get("state") === a);
  check("carries the PKCE challenge", url.searchParams.get("code_challenge") === challenge);
  check("uses S256, not plain", url.searchParams.get("code_challenge_method") === "S256");
  check("first connect forces consent", url.searchParams.get("prompt") === "consent");
  check("the verifier itself never appears in the URL", !url.toString().includes(verifier));

  const reconnect = new URL(buildAuthUrl({
    clientId: "cid", redirectUri: "https://x/cb", state: b,
    codeChallenge: challenge, forceConsent: false,
  }));
  check("a normal reconnect does NOT force the consent screen",
    reconnect.searchParams.get("prompt") === null);
}

console.log("\n-- OAuth: token exchange and refresh --");
{
  const okToken = (over: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({
      access_token: "at-1", refresh_token: "rt-1", expires_in: 3600,
      scope: GMAIL_SCOPE, ...over,
    }), { status: 200 });

  let seen: { url: string; body: string } | null = null;
  const capture = (url: string, init?: RequestInit) => {
    seen = { url, body: String(init?.body ?? "") };
    return Promise.resolve(okToken());
  };

  const tokens = await exchangeCode({
    code: "auth-code", clientId: "cid", clientSecret: "secret",
    redirectUri: "https://x/cb", codeVerifier: "verifier-1",
  }, capture);
  check("exchange posts to Google's token endpoint",
    seen!.url === "https://oauth2.googleapis.com/token");
  check("exchange sends the PKCE verifier", seen!.body.includes("code_verifier=verifier-1"));
  check("exchange sends the authorization_code grant",
    seen!.body.includes("grant_type=authorization_code"));
  check("returns the access token", tokens.accessToken === "at-1");
  check("returns the refresh token", tokens.refreshToken === "rt-1");
  check("computes an absolute expiry", !isNaN(Date.parse(tokens.expiresAt)));

  const refreshed = await refreshAccessToken(
    { refreshToken: "rt-1", clientId: "cid", clientSecret: "secret" },
    (u, i) => { seen = { url: u, body: String(i?.body ?? "") }; return Promise.resolve(okToken({ refresh_token: undefined })); },
  );
  check("refresh uses the refresh_token grant", seen!.body.includes("grant_type=refresh_token"));
  check("a refresh without a new refresh token returns null for it",
    refreshed.refreshToken === null);

  // The case that actually matters in Testing mode.
  const dead = () => Promise.resolve(
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  );
  let code = "";
  try {
    await refreshAccessToken({ refreshToken: "dead", clientId: "c", clientSecret: "s" }, dead);
  } catch (e) { code = (e as GmailError).code; }
  check("a revoked/expired refresh token maps to reconnect_required",
    code === "reconnect_required", code);
  check("needsReconnect() recognises it",
    needsReconnect(new GmailError("reconnect_required")));
  check("needsReconnect() does NOT fire on a transient failure",
    !needsReconnect(new GmailError("unreachable")));

  let scopeCode = "";
  try {
    await exchangeCode(
      { code: "c", clientId: "c", clientSecret: "s", redirectUri: "r", codeVerifier: "v" },
      () => Promise.resolve(okToken({ scope: "https://www.googleapis.com/auth/userinfo.email" })),
    );
  } catch (e) { scopeCode = (e as GmailError).code; }
  check("a downgraded scope fails loudly at connect time",
    scopeCode === "insufficient_scope", scopeCode);

  for (const [status, expected] of [[429, "rate_limited"], [500, "unreachable"], [400, "token_refused"]] as const) {
    let c = "";
    try {
      await refreshAccessToken(
        { refreshToken: "r", clientId: "c", clientSecret: "s" },
        () => Promise.resolve(new Response("{}", { status })),
      );
    } catch (e) { c = (e as GmailError).code; }
    check(`HTTP ${status} maps to ${expected}`, c === expected, c);
  }

  let netCode = "";
  try {
    await refreshAccessToken(
      { refreshToken: "r", clientId: "c", clientSecret: "s" },
      () => Promise.reject(new Error("ECONNRESET")),
    );
  } catch (e) { netCode = (e as GmailError).code; }
  check("a network failure maps to unreachable", netCode === "unreachable");
}

console.log("\n-- message listing and pagination --");
{
  const pages: Record<string, unknown> = {
    "": { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" },
    "p2": { messages: [{ id: "c" }], nextPageToken: null },
  };
  const urls: string[] = [];
  const fakeFetch = (url: string) => {
    urls.push(url);
    const token = new URL(url).searchParams.get("pageToken") ?? "";
    return Promise.resolve(new Response(JSON.stringify(pages[token]), { status: 200 }));
  };

  const first = await listMessageIds(
    { accessToken: "at", query: "from:noreply@wise.com newer_than:2d" }, fakeFetch);
  check("returns the ids on the first page", first.ids.join(",") === "a,b");
  check("surfaces the next page token", first.nextPageToken === "p2");
  check("sends the restrictive query to Gmail",
    new URL(urls[0]).searchParams.get("q") === "from:noreply@wise.com newer_than:2d",
    String(new URL(urls[0]).searchParams.get("q")));
  check("lists ids only -- no format=full on the list call", !urls[0].includes("format=full"));

  const second = await listMessageIds(
    { accessToken: "at", query: "q", pageToken: "p2" }, fakeFetch);
  check("follows the page token", second.ids.join(",") === "c");
  check("stops when there is no next page", second.nextPageToken === null);

  const empty = await listMessageIds({ accessToken: "at", query: "q" },
    () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
  check("an empty mailbox is not an error", empty.ids.length === 0);

  let getUrl = "";
  await getMessage({ accessToken: "at", id: "gm-1" }, (u) => {
    getUrl = u;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  check("fetching one message asks for the full payload", getUrl.includes("format=full"));
  check("fetching one message targets that id", getUrl.includes("/messages/gm-1"));
}

// ---------------------------------------------------------------------------
// End-to-end sync, against a fake PostgREST and a fake Gmail
// ---------------------------------------------------------------------------
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
          // ignore-duplicates returns nothing; merge-duplicates updates.
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

/** Encryption is stubbed so tests never need the real key. */
const fakeCrypto = (state: { plaintext: string }) => ({
  encrypt: (p: string) => { state.plaintext = p; return Promise.resolve({ ciphertext: "CT", iv: "IV" }); },
  decrypt: () => Promise.resolve(state.plaintext),
});

function gmailFetch(messages: GmailMessage[], opts: {
  failMessageIds?: Set<string>;
  onRefresh?: () => Response;
} = {}) {
  const calls: string[] = [];
  const impl = (url: string, _init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(opts.onRefresh
        ? opts.onRefresh()
        : new Response(JSON.stringify({
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
  return { impl, calls };
}

const depsFor = (db: FakeDb, fetchImpl: GmailSyncDeps["fetchImpl"], state = { plaintext: "" }): GmailSyncDeps => ({
  db: db as unknown as GmailSyncDeps["db"],
  now: () => new Date("2026-08-03T16:00:00.000Z"),
  fetchImpl,
  clientId: "cid",
  clientSecret: "secret",
  ...fakeCrypto(state),
  lookbackDays: 2,
  label: null,
});

console.log("\n-- a completed Wise email becomes exactly one shared expense --");
{
  const db = seedDb();
  const state = { plaintext: JSON.stringify({ refresh_token: "rt-1" }) };
  const { impl } = gmailFetch([alternativeMessage("gm-1")]);
  const stats = await syncGmailConnections(
    depsFor(db, impl, state),
    [{ id: "conn-1", user_id: "user-1" }],
  );

  check("one expense imported", stats.expensesImported === 1, JSON.stringify(stats));
  check("exactly one expense row exists", db.store.expenses.length === 1);
  const exp = db.store.expenses[0];
  check("it is a SHARED expense", exp.kind === "shared");
  check("the connected user is the payer", exp.payer === 0 && exp.created_by === "user-1");
  check("the deducted amount is authoritative", exp.amount_orig === 19.76 && exp.currency === "EUR");
  check("the merchant amount is kept as metadata",
    exp.merchant_amount === 71362 && exp.merchant_currency === "COP");
  check("it lands in the user's household", exp.household_id === "hh-1");
  check("the merchant becomes the note", exp.note === "Éxito Express");
  check("provenance records the Wise email path",
    exp.source_provider === "wise" && exp.conversion_source === "wise_email");

  const ledger = db.store.email_import_messages;
  check("the ledger records it once", ledger.length === 1);
  check("ledger row is marked imported", ledger[0].status === "imported");
  check("ledger keeps the Gmail id as dedupe key #1", ledger[0].provider_message_id === "gm-1");
  check("ledger records the source as gmail", ledger[0].source === "gmail");
  check("retained body is purged on success", ledger[0].raw_text === null);
  check("connection is marked synced",
    db.store.email_import_connections[0].last_synced_at === "2026-08-03T16:00:00.000Z");
}

console.log("\n-- the daily overlap creates no duplicate --");
{
  const db = seedDb();
  const state = { plaintext: JSON.stringify({ refresh_token: "rt-1" }) };
  const { impl } = gmailFetch([alternativeMessage("gm-1")]);
  const conns = [{ id: "conn-1", user_id: "user-1" }];

  await syncGmailConnections(depsFor(db, impl, state), conns);
  const second = await syncGmailConnections(depsFor(db, impl, state), conns);

  check("the second run imports nothing", second.expensesImported === 0);
  check("and counts it as a duplicate", second.duplicatesSkipped === 1);
  check("still exactly one expense", db.store.expenses.length === 1);
  check("still exactly one ledger row", db.store.email_import_messages.length === 1);
}

console.log("\n-- the same mail under a different Gmail id still dedupes --");
{
  // Gmail ids differ but the RFC Message-ID is the same: dedupe layer 2.
  const db = seedDb();
  const state = { plaintext: JSON.stringify({ refresh_token: "rt-1" }) };
  const shared = "<same-mail@wise.com>";
  const { impl } = gmailFetch([
    alternativeMessage("gm-A", shared),
    alternativeMessage("gm-B", shared),
  ]);

  const stats = await syncGmailConnections(
    depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);

  check("only one becomes an expense", db.store.expenses.length === 1, JSON.stringify(stats));
  check("the second is recorded as a duplicate", stats.duplicatesSkipped === 1);
  check("both are still recorded in the ledger", db.store.email_import_messages.length === 2);
  check("the duplicate names the RFC Message-ID as the reason",
    db.store.email_import_messages[1].skip_reason === "rfc_message_id");
}

console.log("\n-- an unparsed Wise email creates no expense --");
{
  const db = seedDb();
  const state = { plaintext: JSON.stringify({ refresh_token: "rt-1" }) };
  const marketing: GmailMessage = {
    id: "gm-mkt",
    internalDate: "1785769440000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Wise <noreply@wise.com>" },
        { name: "Subject", value: "Your December summary is ready" },
        { name: "Message-ID", value: "<mkt@wise.com>" },
      ],
      body: { data: b64url("See how much you saved this year with Wise.") },
    },
  };
  const { impl } = gmailFetch([marketing]);
  const stats = await syncGmailConnections(
    depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);

  check("NO expense is created", db.store.expenses.length === 0);
  check("counted as unparsed", stats.unparsed === 1, JSON.stringify(stats));
  check("the message is recorded, not dropped", db.store.email_import_messages.length === 1);
  check("marked unparsed", db.store.email_import_messages[0].status === "unparsed");
  check("its body is retained for diagnosis",
    typeof db.store.email_import_messages[0].raw_text === "string");
}

console.log("\n-- a non-Wise sender is refused even inside the mailbox --");
{
  const db = seedDb();
  const state = { plaintext: JSON.stringify({ refresh_token: "rt-1" }) };
  const spoof: GmailMessage = {
    id: "gm-spoof",
    internalDate: "1785769440000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Wise <noreply@wise.com.evil.net>" },
        { name: "Subject", value: "71,362 COP spent at Éxito Express" },
      ],
      body: { data: b64url(WISE_TEXT) },
    },
  };
  const { impl } = gmailFetch([spoof]);
  await syncGmailConnections(depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);
  check("a lookalike sender creates no expense", db.store.expenses.length === 0);
  check("and is recorded as sender_not_recognised",
    db.store.email_import_messages[0].skip_reason === "sender_not_recognised");
}

console.log("\n-- isolation: one malformed message does not stop the rest --");
{
  const db = seedDb();
  const state = { plaintext: JSON.stringify({ refresh_token: "rt-1" }) };
  const { impl } = gmailFetch(
    [alternativeMessage("gm-bad"), alternativeMessage("gm-good")],
    { failMessageIds: new Set(["gm-bad"]) },
  );
  const stats = await syncGmailConnections(
    depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);

  check("the later message still imported", stats.expensesImported === 1, JSON.stringify(stats));
  check("the failure is counted, not thrown", stats.failed === 1);
  check("exactly one expense exists", db.store.expenses.length === 1);
  check("the connection is still marked healthy",
    db.store.email_import_connections[0].status === "active");
}

console.log("\n-- isolation: one failing connection does not stop other users --");
{
  const db = seedDb();
  db.store.profiles.push({ id: "user-2", household_id: "hh-2", slot: 1 });
  db.store.households.push({ id: "hh-2", usd_per_eur: 1.08, cop_per_eur: 4500 });
  db.store.email_import_connections.push(
    { id: "conn-2", user_id: "user-2", provider: "gmail", enabled: true });
  db.store.email_import_credentials.push(
    { connection_id: "conn-2", user_id: "user-2", ciphertext: "CT", iv: "IV" });

  const state = { plaintext: JSON.stringify({ refresh_token: "rt-1" }) };
  // conn-1's refresh fails with invalid_grant; conn-2's succeeds.
  let refreshes = 0;
  const { impl } = gmailFetch([alternativeMessage("gm-1")], {
    onRefresh: () => {
      refreshes++;
      return refreshes === 1
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
        : new Response(JSON.stringify({
          access_token: "at", expires_in: 3600, scope: GMAIL_SCOPE,
        }), { status: 200 });
    },
  });

  const stats = await syncGmailConnections(depsFor(db, impl, state), [
    { id: "conn-1", user_id: "user-1" },
    { id: "conn-2", user_id: "user-2" },
  ]);

  check("the healthy connection still imported", stats.expensesImported === 1, JSON.stringify(stats));
  check("one connection is reported failed", stats.connectionsFailed === 1);
  check("one connection is reported processed", stats.connectionsProcessed === 1);
  check("the broken one is flagged for reconnect",
    db.store.email_import_connections[0].last_error === "reconnect_required");
  check("the broken one is marked error", db.store.email_import_connections[0].status === "error");
  check("the healthy one is untouched by the failure",
    db.store.email_import_connections[1].status === "active");
  check("the second user's expense landed in THEIR household",
    db.store.expenses.length === 1 && db.store.expenses[0].household_id === "hh-2");
  check("and names THEM as payer", db.store.expenses[0].payer === 1);
}

console.log("\n-- an expired access token is refreshed, and rotation is honoured --");
{
  const db = seedDb();
  // Stored token already expired.
  const state = {
    plaintext: JSON.stringify({
      refresh_token: "rt-old",
      access_token: "at-stale",
      expires_at: "2026-08-03T15:00:00.000Z",
    }),
  };
  let refreshed = false;
  const { impl } = gmailFetch([alternativeMessage("gm-1")], {
    onRefresh: () => {
      refreshed = true;
      return new Response(JSON.stringify({
        access_token: "at-new", refresh_token: "rt-new",
        expires_in: 3600, scope: GMAIL_SCOPE,
      }), { status: 200 });
    },
  });

  await syncGmailConnections(depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);
  check("the expired token triggered a refresh", refreshed);
  const stored = JSON.parse(state.plaintext);
  check("a rotated refresh token replaces the old one", stored.refresh_token === "rt-new");
  check("the new access token is stored", stored.access_token === "at-new");
  check("the credential is re-encrypted, never stored bare",
    db.store.email_import_credentials[0].ciphertext === "CT");
  check("the import still happened", db.store.expenses.length === 1);
}
{
  // A refresh that omits the refresh token must KEEP the existing one.
  const db = seedDb();
  const state = {
    plaintext: JSON.stringify({
      refresh_token: "rt-keep", access_token: "at", expires_at: "2026-08-03T15:00:00.000Z",
    }),
  };
  const { impl } = gmailFetch([alternativeMessage("gm-1")]);
  await syncGmailConnections(depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);
  check("a refresh without rotation keeps the stored refresh token",
    JSON.parse(state.plaintext).refresh_token === "rt-keep");
}
{
  // A still-valid access token must NOT cause a pointless refresh.
  const db = seedDb();
  const state = {
    plaintext: JSON.stringify({
      refresh_token: "rt", access_token: "at-live", expires_at: "2026-08-03T17:00:00.000Z",
    }),
  };
  let refreshes = 0;
  const { impl } = gmailFetch([alternativeMessage("gm-1")], {
    onRefresh: () => { refreshes++; return new Response("{}", { status: 200 }); },
  });
  await syncGmailConnections(depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);
  check("a valid access token is reused rather than refreshed", refreshes === 0);
}

console.log("\n-- a missing or unreadable credential asks for a reconnect --");
{
  const db = seedDb();
  db.store.email_import_credentials = [];
  const { impl } = gmailFetch([alternativeMessage("gm-1")]);
  const stats = await syncGmailConnections(
    depsFor(db, impl, { plaintext: "" }), [{ id: "conn-1", user_id: "user-1" }]);
  check("no credential -> connection failed", stats.connectionsFailed === 1);
  check("and flagged reconnect_required",
    db.store.email_import_connections[0].last_error === "reconnect_required");
  check("no expense is created", db.store.expenses.length === 0);
}
{
  const db = seedDb();
  const { impl } = gmailFetch([alternativeMessage("gm-1")]);
  // Decrypts to something that is not the expected JSON document.
  const stats = await syncGmailConnections(
    depsFor(db, impl, { plaintext: "not json" }), [{ id: "conn-1", user_id: "user-1" }]);
  check("an unreadable credential -> reconnect_required",
    db.store.email_import_connections[0].last_error === "reconnect_required");
  check("it is counted as a connection failure", stats.connectionsFailed === 1);
}

console.log("\n-- nothing secret is ever written to the ledger --");
{
  const db = seedDb();
  const state = { plaintext: JSON.stringify({ refresh_token: "SECRET-RT", access_token: "SECRET-AT" }) };
  const { impl } = gmailFetch([alternativeMessage("gm-1")]);
  await syncGmailConnections(depsFor(db, impl, state), [{ id: "conn-1", user_id: "user-1" }]);

  const dump = JSON.stringify({
    ledger: db.store.email_import_messages,
    connections: db.store.email_import_connections,
    expenses: db.store.expenses,
  });
  check("the refresh token appears nowhere outside the credential row",
    !dump.includes("SECRET-RT"));
  check("the access token appears nowhere outside the credential row",
    !dump.includes("SECRET-AT"));
  check("the credential row holds only ciphertext",
    db.store.email_import_credentials[0].ciphertext === "CT" &&
    !JSON.stringify(db.store.email_import_credentials).includes("SECRET-RT"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
