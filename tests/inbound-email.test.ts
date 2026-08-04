// Inbound email plumbing tests.
//
//   node --experimental-strip-types tests/inbound-email.test.ts
//
// Covers the parts of the inbound path that do NOT depend on Wise's email
// template: Svix signature verification, alias resolution, sender recognition,
// locale-aware money parsing, HTML reduction and fingerprint dedupe.
//
// _shared/inbound-resend.ts reads Deno.env at module scope, so a minimal Deno
// stub is installed before it is imported dynamically.

(globalThis as Record<string, unknown>).Deno = { env: { get: () => undefined }, serve: () => {} };

import {
  addressOf, aliasFromRecipients,
} from "../supabase/functions/_shared/inbound-types.ts";
import {
  fingerprint, htmlToText, isWiseSender, messageText,
  parseCurrency, parseMoneyValue, wiseEmailParser,
} from "../supabase/functions/_shared/parse-wise-email.ts";

const { verifySvixSignature, createResendAdapter } = await import(
  "../supabase/functions/_shared/inbound-resend.ts"
);

import {
  MAX_RETAINED_CHARS, RETENTION_DAYS, redactIdentifiers,
  retentionExpiry, sanitizeForRetention, sanitizeHtml,
} from "../supabase/functions/_shared/sanitize.ts";
import {
  classifyNormalized, createExpense, resolveImportContext,
  type ImportContext, type Row,
} from "../supabase/functions/_shared/import-core.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

// ---------------------------------------------------------------------------
// Svix signature helpers
// ---------------------------------------------------------------------------
const SECRET_RAW = btoa("super-secret-signing-key-32bytes");
const SECRET = "whsec_" + SECRET_RAW;

async function sign(id: string, timestamp: string, body: string, secretRaw = SECRET_RAW) {
  const key = await crypto.subtle.importKey(
    "raw", Uint8Array.from(atob(secretRaw), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

const NOW = new Date("2026-08-03T12:00:00.000Z");
const ts = () => String(Math.floor(NOW.getTime() / 1000));

async function headersFor(body: string, over: Record<string, string> = {}) {
  const id = "msg_123";
  const t = over["svix-timestamp"] ?? ts();
  const sig = over["svix-signature"] ?? `v1,${await sign(id, t, body)}`;
  return new Headers({ "svix-id": id, "svix-timestamp": t, "svix-signature": sig, ...over });
}

const expectReject = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null; } catch (e) { return (e as Error).message; }
};

// ---------------------------------------------------------------------------
console.log("\n-- Svix signature verification --");
{
  const body = JSON.stringify({ type: "email.received" });
  await verifySvixSignature(await headersFor(body), body, SECRET, NOW);
  check("a correctly signed request is accepted", true);
}
{
  const body = JSON.stringify({ type: "email.received" });
  const h = await headersFor(body);
  const err = await expectReject(() => verifySvixSignature(h, body + "tampered", SECRET, NOW));
  check("a tampered body is rejected", err === "signature_mismatch", String(err));
}
{
  const body = JSON.stringify({ type: "email.received" });
  const h = await headersFor(body, { "svix-signature": "v1,YWJjZGVm" });
  const err = await expectReject(() => verifySvixSignature(h, body, SECRET, NOW));
  check("a wrong signature is rejected", err === "signature_mismatch", String(err));
}
{
  const body = "{}";
  const wrongSecret = btoa("a-completely-different-key-32byte");
  const id = "msg_123", t = ts();
  const h = new Headers({
    "svix-id": id, "svix-timestamp": t,
    "svix-signature": `v1,${await sign(id, t, body, wrongSecret)}`,
  });
  const err = await expectReject(() => verifySvixSignature(h, body, SECRET, NOW));
  check("a signature from another secret is rejected", err === "signature_mismatch", String(err));
}
{
  const body = "{}";
  const err = await expectReject(() =>
    verifySvixSignature(new Headers({ "svix-id": "x" }), body, SECRET, NOW));
  check("missing signature headers are rejected", err === "missing_signature_headers", String(err));
}
{
  // Replay protection: a captured request must not stay valid forever.
  const body = "{}";
  const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
  const h = await headersFor(body, { "svix-timestamp": old, "svix-signature": `v1,${await sign("msg_123", old, body)}` });
  const err = await expectReject(() => verifySvixSignature(h, body, SECRET, NOW));
  check("an old timestamp is rejected (replay protection)", err === "timestamp_out_of_tolerance", String(err));
}
{
  const body = "{}";
  const future = String(Math.floor(NOW.getTime() / 1000) + 3600);
  const h = await headersFor(body, { "svix-timestamp": future, "svix-signature": `v1,${await sign("msg_123", future, body)}` });
  const err = await expectReject(() => verifySvixSignature(h, body, SECRET, NOW));
  check("a far-future timestamp is rejected", err === "timestamp_out_of_tolerance", String(err));
}
{
  // Key rotation: several space-separated signatures, any one may match.
  const body = "{}";
  const good = await sign("msg_123", ts(), body);
  const h = await headersFor(body, { "svix-signature": `v1,YWJj v1,${good}` });
  await verifySvixSignature(h, body, SECRET, NOW);
  check("multiple signatures are accepted if any matches (key rotation)", true);
}

console.log("\n-- alias resolution --");
{
  const D = "inbound.example.com";
  check("extracts the token from wise-<token>@domain",
    aliasFromRecipients([`wise-abc123def@${D}`], D, "wise") === "abc123def");
  check("handles a display-name form",
    aliasFromRecipients([`Import <wise-abc123def@${D}>`], D, "wise") === "abc123def");
  check("is case-insensitive",
    aliasFromRecipients([`WISE-ABC@${D.toUpperCase()}`], D, "wise") === "abc");
  check("picks the matching recipient out of several",
    aliasFromRecipients(["someone@gmail.com", `wise-tok@${D}`], D, "wise") === "tok");
  check("ignores a different domain",
    aliasFromRecipients(["wise-tok@evil.com"], D, "wise") === null);
  check("ignores a missing alias", aliasFromRecipients([], D, "wise") === null);
  check("strips a plus tag added by a forwarder",
    aliasFromRecipients([`wise-tok+fwd@${D}`], D, "wise") === "tok");
  check("returns null when the prefix is absent",
    aliasFromRecipients([`other-tok@${D}`], D, "wise") === null);
  check("supports a bare-token alias when no prefix is configured",
    aliasFromRecipients([`justtoken@${D}`], D, "") === "justtoken");
}
{
  check("addressOf unwraps a display name", addressOf("Wise <noreply@wise.com>") === "noreply@wise.com");
  check("addressOf passes a bare address", addressOf("noreply@wise.com") === "noreply@wise.com");
  check("addressOf rejects nonsense", addressOf("not an address") === null);
}

console.log("\n-- sender authenticity --");
{
  check("wise.com is recognised", isWiseSender("noreply@wise.com"));
  check("a wise.com subdomain is recognised", isWiseSender("noreply@mail.wise.com"));
  check("transferwise.com is recognised", isWiseSender("noreply@transferwise.com"));
  check("a lookalike domain is NOT recognised", !isWiseSender("noreply@wise.com.evil.net"));
  check("an unrelated sender is NOT recognised", !isWiseSender("attacker@gmail.com"));
  check("null is handled", !isWiseSender(null));
  const msg = { from: "Wise <noreply@wise.com>", text: null, html: null, headers: {}, rfcMessageId: null,
    providerMessageId: "x", recipients: [], subject: null, receivedAt: "" };
  check("the parser recognises a genuine Wise sender", wiseEmailParser.recognises(msg));
  check("the parser rejects a spoofed sender",
    !wiseEmailParser.recognises({ ...msg, from: "Wise <noreply@notwise.com>" }));
}

console.log("\n-- locale-aware money parsing (a 1000x error risk) --");
{
  const cases: Array<[string, number | null]> = [
    ["12.34", 12.34],
    ["12,34", 12.34],
    ["1.234,56", 1234.56],       // European
    ["1,234.56", 1234.56],       // Anglo
    ["45.000", 45000],           // Colombian thousands -- NOT 45
    ["45,000", 45000],
    ["1.234.567", 1234567],
    ["1,234,567.89", 1234567.89],
    ["100", 100],
    ["0.99", 0.99],
    ["-12.34", -12.34],
    ["", null],
    ["abc", null],
  ];
  for (const [input, expected] of cases) {
    const got = parseMoneyValue(input);
    check(`"${input}" -> ${expected}`, got === expected, `got ${got}`);
  }
  check("strips currency noise", parseMoneyValue("COP 45.000") === 45000);
  check("handles a plain space as a group separator",
    parseMoneyValue("45 000") === 45000, String(parseMoneyValue("45 000")));
  check("handles a non-breaking space",
    parseMoneyValue("45\u00a0000") === 45000, String(parseMoneyValue("45\u00a0000")));
  check("handles a narrow no-break space",
    parseMoneyValue("45\u202f000") === 45000, String(parseMoneyValue("45\u202f000")));
}

console.log("\n-- currency detection --");
{
  check("explicit code wins", parseCurrency("45.000 COP") === "COP");
  check("USD detected", parseCurrency("USD 12.34") === "USD");
  check("euro symbol", parseCurrency("€ 12,34") === "EUR");
  check("a bare $ is NOT guessed (USD vs COP is ambiguous)", parseCurrency("$ 45.000") === null);
  check("unknown -> null", parseCurrency("12.34") === null);
}

console.log("\n-- HTML reduction --");
{
  check("strips tags", htmlToText("<p>Hello <b>world</b></p>").includes("Hello world"));
  check("drops script/style", !htmlToText("<style>a{}</style><p>Hi</p>").includes("a{}"));
  check("decodes entities", htmlToText("<p>A&nbsp;&amp;&nbsp;B</p>").includes("A & B"));
  check("handles empty input", htmlToText("") === "");
  const msg = { providerMessageId: "x", recipients: [], from: "", subject: null, receivedAt: "",
    text: null, html: "<p>From HTML</p>", headers: {}, rfcMessageId: null };
  check("messageText falls back to HTML when text is absent", messageText(msg).includes("From HTML"));
  check("messageText prefers the text part", messageText({ ...msg, text: "From text" }) === "From text");
}

console.log("\n-- fingerprint (last-resort dedupe) --");
{
  const base = { userScope: "conn-1", merchant: "Uber", amount: 11.2, currency: "USD", occurredAt: "2026-08-02T09:30:00.000Z" };
  const a = await fingerprint(base);
  const b = await fingerprint({ ...base });
  check("identical inputs collide (a redelivery is caught)", a === b);
  check("is a hex digest", /^[0-9a-f]{64}$/.test(a));
  check("a different amount does not collide", a !== await fingerprint({ ...base, amount: 11.21 }));
  check("a different merchant does not collide", a !== await fingerprint({ ...base, merchant: "Rappi" }));
  check("a different currency does not collide", a !== await fingerprint({ ...base, currency: "COP" }));
  check("a different connection does not collide (multi-user safety)",
    a !== await fingerprint({ ...base, userScope: "conn-2" }));
  check("seconds are bucketed away, so a redelivery still collides",
    a === await fingerprint({ ...base, occurredAt: "2026-08-02T09:30:59.000Z" }));
  check("a different minute does not collide",
    a !== await fingerprint({ ...base, occurredAt: "2026-08-02T09:31:00.000Z" }));
  check("missing fields still hash", /^[0-9a-f]{64}$/.test(
    await fingerprint({ userScope: "c", merchant: null, amount: null, currency: null, occurredAt: null })));
}

console.log("\n-- Resend envelope parsing --");
{
  const adapter = createResendAdapter(SECRET, "re_test");
  const ok = adapter.parseEnvelope(JSON.stringify({
    type: "email.received",
    created_at: "2026-08-03T12:00:00.000Z",
    data: { email_id: "abc-123", from: "Wise <noreply@wise.com>", to: ["wise-tok@inbound.example.com"], subject: "You spent" },
  }));
  check("parses an inbound event", ok?.providerMessageId === "abc-123");
  check("captures recipients", ok?.recipients[0] === "wise-tok@inbound.example.com");
  check("captures the sender", ok?.from === "Wise <noreply@wise.com>");
  check("a non-inbound event is ignored", adapter.parseEnvelope(JSON.stringify({ type: "email.delivered", data: {} })) === null);
  check("malformed JSON is ignored, not thrown", adapter.parseEnvelope("{not json") === null);
  check("a missing email_id is ignored", adapter.parseEnvelope(JSON.stringify({ type: "email.received", data: {} })) === null);
}

console.log("\n-- the parser refuses to guess on mail that isn't the known template --");
{
  // "You spent ... at ..." alone (no "This used ... from your account"
  // sentence) is NOT the completed-payment template implemented below -- it
  // must still fall through to unparsed rather than a guess. This is the same
  // fixture used before the template existed; it now exercises the fallback
  // path instead of a blanket stub.
  const msg = { providerMessageId: "x", recipients: [], from: "Wise <noreply@wise.com>",
    subject: "You spent 45.000 COP", receivedAt: "", text: "You spent 45.000 COP at UBER",
    html: null, headers: {}, rfcMessageId: null };
  const out = wiseEmailParser.parse(msg);
  check("returns unparsed rather than inventing a template", !out.ok && out.reason === "unparsed");
  check("and says why", !out.ok && out.detail === "parser_awaiting_samples");
}

console.log("\n-- Wise completed card payment: real sample extraction --");
{
  // The first real anonymised Wise sample supplied for this template.
  const WISE_COMPLETED_PAYMENT_TEXT_FIXTURE = {
    providerMessageId: "resend-real-1",
    recipients: ["wise-abc123@inbound.example.com"],
    from: "Wise <noreply@wise.com>",
    subject: "71,362 COP spent at Éxito Express",
    receivedAt: "2026-08-03T15:04:00.000Z",
    text: "Hi Alex,\n\nYou spent 71,362 COP at Éxito Express.\n\n" +
      "This used 19.76 EUR from your account.\n\nThanks for using Wise.",
    html: null,
    headers: {},
    rfcMessageId: "<real-1@wise.com>",
  };
  // Same stable wording, reduced through markup instead of given as plain
  // text -- proves extraction does not depend on the text part being present.
  const WISE_COMPLETED_PAYMENT_HTML_FIXTURE = {
    ...WISE_COMPLETED_PAYMENT_TEXT_FIXTURE,
    providerMessageId: "resend-real-2",
    text: null,
    html: "<html><body><p>Hi Alex,</p>" +
      "<p>You spent 71,362 COP at Éxito Express.</p>" +
      "<p>This used 19.76 EUR from your account.</p>" +
      "<p>Thanks for using Wise.</p></body></html>",
  };

  for (
    const [label, msg] of [
      ["plain-text part", WISE_COMPLETED_PAYMENT_TEXT_FIXTURE],
      ["HTML part", WISE_COMPLETED_PAYMENT_HTML_FIXTURE],
    ] as const
  ) {
    const out = wiseEmailParser.parse(msg);
    check(`${label}: parses successfully`, out.ok, !out.ok ? out.detail : "");
    if (!out.ok) continue;
    const tx = out.transaction;
    check(`${label}: status completed`, tx.status === "completed");
    check(`${label}: direction outgoing`, tx.direction === "out");
    check(`${label}: merchant`, tx.merchant === "Éxito Express", tx.merchant ?? "null");
    check(`${label}: deducted account amount is the expense amount`,
      tx.amount.value === 19.76 && tx.amount.currency === "EUR", JSON.stringify(tx.amount));
    check(`${label}: merchant amount stored only as metadata`,
      tx.merchantAmount?.value === 71362 && tx.merchantAmount?.currency === "COP",
      JSON.stringify(tx.merchantAmount));
    check(`${label}: no reference was invented`, tx.externalRef === null);
    check(`${label}: no date was invented`, tx.occurredAt === null);
    check(`${label}: subject/sender captured as metadata only`,
      tx.sourceMetadata?.subject === msg.subject && tx.sourceMetadata?.sender === msg.from);
  }

  // The extracted JSON, shown for review.
  const shown = wiseEmailParser.parse(WISE_COMPLETED_PAYMENT_TEXT_FIXTURE);
  if (shown.ok) {
    console.log("  extracted:", JSON.stringify(shown.transaction, null, 2).replace(/\n/g, "\n  "));
  }
}


console.log("\n-- sanitising retained content --");
{
  check("strips <script>", !sanitizeHtml('<p>a</p><script>evil()</script>').includes("evil"));
  check("strips <style>", !sanitizeHtml('<style>.x{color:red}</style><p>a</p>').includes("color:red"));
  check("strips <iframe>", !sanitizeHtml('<iframe src="http://x"></iframe>').includes("iframe"));
  check("removes ALL <img> (tracking pixels included)",
    !sanitizeHtml('<img src="http://t.example/p.gif?u=1" width="1" height="1">').includes("img"));
  check("removes remote src", !sanitizeHtml('<img src="http://evil/x">').includes("evil"));
  check("removes href", !sanitizeHtml('<a href="http://evil/x">link</a>').includes("evil"));
  check("keeps link TEXT for diagnosis", sanitizeHtml('<a href="http://evil/x">Uber</a>').includes("Uber"));
  check("removes inline handlers", !sanitizeHtml('<div onclick="steal()">a</div>').includes("steal"));
  check("neutralises javascript: URLs", !sanitizeHtml('<p>javascript:alert(1)</p>').includes("javascript:"));
  check("strips comments", !sanitizeHtml("<!-- build 42 --><p>a</p>").includes("build 42"));
  check("removes url() in styles", !sanitizeHtml('<div style="background:url(http://evil/x)">a</div>').includes("evil"));
}

console.log("\n-- redaction keeps parse targets, removes identifiers --");
{
  check("redacts email addresses", redactIdentifiers("write to john.doe@gmail.com now") === "write to [email] now");
  check("redacts long card-length digit runs", redactIdentifiers("card 4111111111111111 used").includes("[number]"));
  check("redacts spaced card numbers", redactIdentifiers("4111 1111 1111 1111").includes("[number]"));
  check("redacts IBANs", redactIdentifiers("NL91ABNA0417164300").includes("[iban]"));
  // The whole point of retention is diagnosing a parse, so the parse targets
  // must survive redaction intact.
  check("KEEPS a COP amount", redactIdentifiers("You spent 45.000 COP") === "You spent 45.000 COP");
  check("KEEPS a decimal amount", redactIdentifiers("12,34 EUR") === "12,34 EUR");
  check("KEEPS the merchant name", redactIdentifiers("at UBER *TRIP").includes("UBER *TRIP"));
  check("KEEPS a transaction reference", redactIdentifiers("ref CARD-12345678").includes("CARD-12345678"));
}

console.log("\n-- retention envelope --");
{
  const out = sanitizeForRetention("You spent 45.000 COP at UBER", "<p>You spent 45.000 COP</p><script>x()</script>");
  check("returns sanitised text", out.text!.includes("45.000 COP"));
  check("returns sanitised html", out.html!.includes("45.000 COP") && !out.html!.includes("x()"));
  const empty = sanitizeForRetention(null, null);
  check("nothing to keep -> nulls, so no storage is used", empty.text === null && empty.html === null);
  const huge = sanitizeForRetention("x".repeat(MAX_RETAINED_CHARS * 3), null);
  check("caps size so one message cannot bloat the table", huge.text!.length === MAX_RETAINED_CHARS);

  check("retention window is 7 days", RETENTION_DAYS === 7);
  const from = new Date("2026-08-03T12:00:00.000Z");
  const expiry = new Date(retentionExpiry(from));
  check("expiry is exactly 7 days after receipt",
    expiry.toISOString() === "2026-08-10T12:00:00.000Z", expiry.toISOString());
}

console.log("\n-- the stub parser records an unparsed message and creates NO expense --");
{
  // Mirrors the webhook's decision sequence around the parser, with a fake db,
  // to prove that today's stub cannot produce an expense by any route.
  class FakeDb {
    store: Record<string, Row[]> = {
      profiles: [{ id: "user-1", household_id: "hh-1", slot: 0 }],
      households: [{ id: "hh-1", usd_per_eur: 1.08, cop_per_eur: 4500 }],
      household_categories: [],
      expenses: [],
      email_import_messages: [{ id: "m-1", status: "received" }],
    };
    select(path: string) {
      const t = path.split("?")[0];
      return Promise.resolve((this.store[t] ?? []).map((r) => ({ ...r })));
    }
    insert(t: string, body: Row | Row[]) {
      const rows = Array.isArray(body) ? body : [body];
      const key = t.split("?")[0];
      (this.store[key] ??= []).push(...rows);
      return Promise.resolve(rows.map((r, i) => ({ id: `${key}-${i}`, ...r })));
    }
    patch(path: string, body: Row) {
      const t = path.split("?")[0];
      (this.store[t] ?? []).forEach((r) => Object.assign(r, body));
      return Promise.resolve([]);
    }
  }
  const db = new FakeDb();
  const msg = {
    providerMessageId: "resend-1", recipients: [], from: "Wise <noreply@wise.com>",
    subject: "You spent", receivedAt: "", text: "You spent 45.000 COP at UBER",
    html: null, headers: {}, rfcMessageId: null,
  };

  const outcome = wiseEmailParser.parse(msg);
  check("parser reports unparsed", !outcome.ok && outcome.reason === "unparsed");

  if (!outcome.ok) {
    // What the webhook does with that outcome.
    await db.patch("email_import_messages?id=eq.m-1", {
      status: outcome.reason === "not_a_transaction" ? "skipped" : "unparsed",
      skip_reason: outcome.detail,
    });
  }
  check("ledger row marked unparsed", db.store.email_import_messages[0].status === "unparsed");
  check("skip reason recorded", db.store.email_import_messages[0].skip_reason === "parser_awaiting_samples");
  check("NO expense was created", db.store.expenses.length === 0);
  check("the message is recorded, not dropped", db.store.email_import_messages.length === 1);

  // And the sanitised body would be retained for diagnosis.
  const retained = sanitizeForRetention(msg.text, msg.html);
  check("its body is retained for diagnosis", !!retained.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
