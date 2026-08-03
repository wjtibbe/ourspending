// Wise connect/reconnect verification tests.
//
//   node --experimental-strip-types tests/wise-connect.test.ts
//
// Exercises verifyWiseToken() in supabase/functions/_shared/wise.ts — the
// ONLY place Connect/Reconnect checks a Wise token — against a fake fetch.
// No network, no real Wise API, no credentials.
//
// provider-connect/index.ts calls Deno.serve(...) at module scope, so it is
// imported dynamically below, after stubbing a minimal globalThis.Deno --
// the same pattern used to load-check every Edge Function module elsewhere
// in this project. _shared/wise.ts has no such side effect and is imported
// normally.

import { verifyWiseToken, WiseVerificationError } from "../supabase/functions/_shared/wise.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

// Captures every call so a test can assert exactly what was requested, and
// that nothing else was requested.
function fakeFetch(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

function throwingFetch(err: unknown) {
  const calls: Array<{ url: string }> = [];
  const impl = (async (url: string) => {
    calls.push({ url: String(url) });
    throw err;
  }) as typeof fetch;
  return { impl, calls };
}

const BASE = "https://api.transferwise.com";

// ---------------------------------------------------------------------------
console.log("\n-- requirement 1 + 8: the verification endpoint is exactly /v1/me --");
{
  const { impl, calls } = fakeFetch(200, { id: 555, firstName: "Ada", lastName: "Lovelace" });
  await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  check("exactly one call was made", calls.length === 1, String(calls.length));
  check("the URL is exactly {base}/v1/me", calls[0].url === `${BASE}/v1/me`, calls[0].url);
  check("no /v1/profiles call was made", !calls.some((c) => c.url.includes("/v1/profiles")));
}

console.log("\n-- requirement 1 + 8: the header is exactly Authorization: Bearer <trimmed token> --");
{
  const { impl, calls } = fakeFetch(200, { id: 1 });
  await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  check(
    "header is exactly 'Bearer <token>', no extra whitespace",
    calls[0].headers.Authorization === "Bearer sometoken1234567890",
    JSON.stringify(calls[0].headers.Authorization),
  );
}

console.log("\n-- requirement 3 + 8: trailing/leading whitespace in the token is removed --");
{
  const { impl, calls } = fakeFetch(200, { id: 1 });
  await verifyWiseToken("  sometoken1234567890\n\t ", { base: BASE, fetchImpl: impl });
  check(
    "the header carries the TRIMMED token, not the raw one",
    calls[0].headers.Authorization === "Bearer sometoken1234567890",
    JSON.stringify(calls[0].headers.Authorization),
  );
}

console.log("\n-- requirement 4 + 8: a 200 response marks the connection connected --");
{
  globalThis.Deno = {
    env: { get: () => undefined },
    serve: () => {},
  } as unknown as typeof Deno;
  const { buildConnectionRow } = await import("../supabase/functions/provider-connect/index.ts");

  const { impl } = fakeFetch(200, { id: 777, firstName: "Grace", lastName: "Hopper" });
  const identity = await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  const row = buildConnectionRow("user-1", "hh-1", "wise", identity, "7890", "2026-08-03T00:00:00.000Z");

  check("row status is 'connected'", row.status === "connected", row.status);
  check("row carries the household from the caller, not from Wise", row.household_id === "hh-1");
  check("row carries the user from the caller, not from Wise", row.user_id === "user-1");
  check("account_label uses the /v1/me name", row.account_label === "Grace Hopper");
  check("external_account_id uses the /v1/me id", row.external_account_id === "777");
  check("secret_hint is only the last 4 chars, never the token", row.secret_hint === "7890");
}

console.log("\n-- requirement 2 + 5: no business-profile check, and profiles/balances/statement are never called --");
{
  // /v1/me alone, with no personal/business "type" concept at all, must be
  // enough — there is nothing here for a profile-type check to even inspect.
  const { impl, calls } = fakeFetch(200, { id: 42, firstName: "Alan", lastName: "Turing" });
  const identity = await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  check("verification succeeds from /v1/me alone", identity.label === "Alan Turing");
  check(
    "only /v1/me was ever requested (no profiles, balances or statement)",
    calls.every((c) => c.url === `${BASE}/v1/me`) && calls.length === 1,
  );
}

console.log("\n-- requirement 6: distinct safe error codes per status --");
{
  const cases: Array<[number, string]> = [
    [401, "token_refused"],
    [403, "token_forbidden"],
    [429, "wise_rate_limited"],
    [500, "wise_temporarily_unavailable"],
    [502, "wise_temporarily_unavailable"],
  ];
  for (const [status, expected] of cases) {
    const { impl } = fakeFetch(status, {});
    try {
      await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
      check(`HTTP ${status} -> throws`, false, "did not throw");
    } catch (e) {
      check(
        `HTTP ${status} -> ${expected}`,
        e instanceof WiseVerificationError && e.code === expected,
        e instanceof WiseVerificationError ? e.code : String(e),
      );
    }
  }
}

console.log("\n-- requirement 6: a network failure is wise_temporarily_unavailable, never the token's fault --");
{
  const { impl } = throwingFetch(new TypeError("network down"));
  try {
    await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
    check("network failure throws", false);
  } catch (e) {
    check(
      "network failure -> wise_temporarily_unavailable",
      e instanceof WiseVerificationError && e.code === "wise_temporarily_unavailable",
    );
  }
}

console.log("\n-- requirement 7: never returns anything but a safe name and id --");
{
  const sensitive = {
    id: 9,
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    phoneNumber: "+44 7000 000000",
    dateOfBirth: "1815-12-10",
    address: { city: "London" },
  };
  const { impl } = fakeFetch(200, sensitive);
  const identity = await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  const keys = Object.keys(identity);
  check("only externalId and label are returned", keys.length === 2 && "externalId" in identity && "label" in identity, keys.join(","));
  const serialized = JSON.stringify(identity);
  check("no email in the returned identity", !serialized.includes("example.com"));
  check("no phone number in the returned identity", !serialized.includes("7000 000000"));
  check("no date of birth in the returned identity", !serialized.includes("1815"));
  check("no address in the returned identity", !serialized.includes("London"));
}

console.log("\n-- name fallback: plain 'name' field is used when first/last are absent --");
{
  const { impl } = fakeFetch(200, { id: 3, name: "Business Account Name" });
  const identity = await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  check("falls back to a plain 'name' field", identity.label === "Business Account Name");
}

console.log("\n-- no identity fields at all still resolves without throwing --");
{
  const { impl } = fakeFetch(200, {});
  const identity = await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  check("label is null rather than throwing", identity.label === null);
  check("externalId is null rather than throwing", identity.externalId === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
