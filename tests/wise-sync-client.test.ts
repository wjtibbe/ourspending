// Wise sync-client endpoint and classification tests.
//
//   node --experimental-strip-types tests/wise-sync-client.test.ts
//
// Exercises createWiseClient() in supabase/functions/_shared/wise.ts -- the
// client the hourly job and "Sync now" both use via _shared/sync.ts -- against
// a fake fetch. No network, no real Wise API, no credentials.

import { createWiseClient, verifyWiseToken, WiseAuthError } from "../supabase/functions/_shared/wise.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

const BASE = "https://api.transferwise.com";

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

// A realistic v2 personal-profile listing: same essentials (id, type) as v1,
// since listBalances() in _shared/sync.ts only ever reads `.id`.
const PERSONAL_PROFILE = [{ id: 555, type: "personal", details: { firstName: "Ada", lastName: "Lovelace" } }];

// ---------------------------------------------------------------------------
console.log("\n-- requirement 1 + 6: sync's profile listing uses exactly /v2/profiles --");
{
  const { impl, calls } = fakeFetch(200, PERSONAL_PROFILE);
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  await client.profiles();
  check("exactly one call was made", calls.length === 1, String(calls.length));
  check("the URL is exactly {base}/v2/profiles", calls[0].url === `${BASE}/v2/profiles`, calls[0].url);
  check("never /v1/profiles", !calls.some((c) => c.url.includes("/v1/profiles")));
}

console.log("\n-- balances() and statement() endpoints are unchanged by this fix --");
{
  const { impl, calls } = fakeFetch(200, [{ id: 1, currency: "USD" }]);
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  await client.balances("profile-1");
  check(
    "balances() still hits /v4/profiles/{id}/balances",
    calls[0].url === `${BASE}/v4/profiles/profile-1/balances?types=STANDARD`,
    calls[0].url,
  );
}
{
  const { impl, calls } = fakeFetch(200, { transactions: [] });
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-01-15T00:00:00.000Z");
  await client.statement("profile-1", "bal-1", "USD", from, to);
  check(
    "statement() still hits the balance-statements path",
    calls[0].url.startsWith(`${BASE}/v1/profiles/profile-1/balance-statements/bal-1/statement.json`),
    calls[0].url,
  );
}

console.log("\n-- requirement 6: PERSONAL profiles are accepted (no business-profile requirement) --");
{
  const { impl } = fakeFetch(200, PERSONAL_PROFILE);
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  const profiles = await client.profiles();
  check("a personal profile is returned, not rejected", Array.isArray(profiles) && profiles.length === 1);
  check("its type is personal", (profiles[0] as Record<string, unknown>).type === "personal");
  check("its id is usable", (profiles[0] as Record<string, unknown>).id === 555);
}

console.log("\n-- requirement 3 + 6: 401 and 403 remain distinct --");
{
  const { impl } = fakeFetch(401, {});
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  try {
    await client.profiles();
    check("401 throws", false);
  } catch (e) {
    check(
      "401 -> WiseAuthError with code invalid_token",
      e instanceof WiseAuthError && e.code === "invalid_token",
      e instanceof WiseAuthError ? e.code : String(e),
    );
  }
}
{
  const { impl } = fakeFetch(403, {});
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  try {
    await client.profiles();
    check("403 throws", false);
  } catch (e) {
    check(
      "403 -> WiseAuthError with code insufficient_permissions, NOT invalid_token",
      e instanceof WiseAuthError && e.code === "insufficient_permissions",
      e instanceof WiseAuthError ? e.code : String(e),
    );
  }
}
{
  // Same class, different code: proves 401 and 403 are not silently collapsed
  // back into one message by an instanceof-only check further up the stack.
  const codes = new Set<string>();
  for (const status of [401, 403]) {
    const { impl } = fakeFetch(status, {});
    const client = createWiseClient("sometoken1234567890", BASE, impl);
    try { await client.profiles(); } catch (e) {
      if (e instanceof WiseAuthError) codes.add(e.code);
    }
  }
  check("401 and 403 produced two distinct codes", codes.size === 2, JSON.stringify([...codes]));
}

console.log("\n-- 429 is its own code, distinct from both 401 and 403 --");
{
  const { impl } = fakeFetch(429, {});
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  try {
    await client.profiles();
    check("429 throws", false);
  } catch (e) {
    check(
      "429 -> WiseAuthError with code wise_rate_limited",
      e instanceof WiseAuthError && e.code === "wise_rate_limited",
      e instanceof WiseAuthError ? e.code : String(e),
    );
  }
}

console.log("\n-- requirement 3: a 5xx is NOT a WiseAuthError (maps to provider_unreachable upstream) --");
{
  for (const status of [500, 502, 503]) {
    const { impl } = fakeFetch(status, {});
    const client = createWiseClient("sometoken1234567890", BASE, impl);
    try {
      await client.profiles();
      check(`${status} throws`, false);
    } catch (e) {
      check(`${status} is a plain Error, not WiseAuthError`, !(e instanceof WiseAuthError));
    }
  }
}

console.log("\n-- requirement 3: a network failure is also not a WiseAuthError --");
{
  const impl = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  try {
    await client.profiles();
    check("network failure throws", false);
  } catch (e) {
    check("network failure is not a WiseAuthError", !(e instanceof WiseAuthError));
  }
}

console.log("\n-- the Authorization header is unchanged (Bearer <token>) --");
{
  const { impl, calls } = fakeFetch(200, PERSONAL_PROFILE);
  const client = createWiseClient("sometoken1234567890", BASE, impl);
  await client.profiles();
  check(
    "header is 'Bearer <token>'",
    calls[0].headers.Authorization === "Bearer sometoken1234567890",
    calls[0].headers.Authorization,
  );
}

console.log("\n-- requirement 2 + 6: connect (verifyWiseToken) still uses exactly /v1/me, never /v2/profiles --");
{
  const { impl, calls } = fakeFetch(200, { id: 9, firstName: "Grace", lastName: "Hopper" });
  await verifyWiseToken("sometoken1234567890", { base: BASE, fetchImpl: impl });
  check("exactly one call was made", calls.length === 1, String(calls.length));
  check("the URL is exactly {base}/v1/me", calls[0].url === `${BASE}/v1/me`, calls[0].url);
  check("connect never touches /v2/profiles", !calls.some((c) => c.url.includes("profiles")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
