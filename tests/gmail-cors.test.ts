// CORS + preflight tests for the browser-invoked Gmail Edge Functions.
//
//   node --experimental-strip-types tests/gmail-cors.test.ts
//
// Regression coverage for a real bug: gmail-oauth-start's Access-Control-
// Allow-Headers omitted `apikey` and `x-client-info`, which supabase-js's
// functions.invoke() always sends. The OPTIONS preflight itself returned 200,
// so it LOOKED fine in the Supabase function logs -- but the browser rejects
// a preflight whose Allow-Headers doesn't cover every header the real request
// will carry, and silently never sends the POST. gmail-sync and
// gmail-disconnect had the identical defect.
//
// These tests drive the ACTUAL Deno.serve handler in each index.ts, not a
// reimplementation, by capturing the callback Deno.serve() is invoked with.
// A stubbed Deno.env.get() (independent per import, since module-scope
// consts are read exactly once) and a stubbed global fetch stand in for the
// Supabase platform and Google.

type Handler = (req: Request) => Response | Promise<Response>;

const envValues: Record<string, string> = {};
let lastHandler: Handler | null = null;

(globalThis as Record<string, unknown>).Deno = {
  env: { get: (k: string) => envValues[k] },
  serve: (fn: Handler) => { lastHandler = fn; },
};

const setEnv = (vars: Record<string, string>) => {
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, vars);
};

let importSeq = 0;

async function loadHandler(path: string, env: Record<string, string>): Promise<Handler> {
  setEnv(env);
  lastHandler = null;
  // Node caches an ES module by its exact specifier, so importing the same
  // index.ts a second time would return the cached module WITHOUT re-running
  // its top level -- meaning its Deno.env.get() reads would silently keep
  // the first call's values. A unique query string forces a fresh
  // evaluation each time, against whatever setEnv() just configured.
  await import(`${path}?t=${++importSeq}`);
  if (!lastHandler) throw new Error(`Deno.serve was not called by ${path}`);
  return lastHandler;
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

/** What a supabase-js functions.invoke() OPTIONS preflight actually sends. */
const preflight = (origin = "https://app.example.com") =>
  new Request("https://ref.supabase.co/functions/v1/x", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

const postRequest = (headers: Record<string, string> = {}, body: unknown = {}) =>
  new Request("https://ref.supabase.co/functions/v1/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** Every header a real preflight asked to send must be explicitly allowed. */
function assertCoversPreflight(name: string, res: Response) {
  const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "")
    .toLowerCase().split(",").map((s) => s.trim());
  for (const needed of ["authorization", "apikey", "x-client-info", "content-type"]) {
    check(`${name}: Allow-Headers covers "${needed}"`, allowed.includes(needed), allowed.join(", "));
  }
  check(`${name}: Allow-Origin present`, !!res.headers.get("Access-Control-Allow-Origin"));
  check(`${name}: Allow-Methods includes POST`,
    (res.headers.get("Access-Control-Allow-Methods") ?? "").includes("POST"),
    res.headers.get("Access-Control-Allow-Methods") ?? "(missing)");
  check(`${name}: Allow-Methods includes OPTIONS`,
    (res.headers.get("Access-Control-Allow-Methods") ?? "").includes("OPTIONS"));
}

// ---------------------------------------------------------------------------
// gmail-oauth-start
// ---------------------------------------------------------------------------
console.log("\n-- gmail-oauth-start: CORS --");
{
  const handler = await loadHandler("../supabase/functions/gmail-oauth-start/index.ts", {
    GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
    GOOGLE_REDIRECT_URI: "https://ref.supabase.co/functions/v1/gmail-oauth-callback",
    SUPABASE_URL: "https://ref.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  });

  const opt = await handler(preflight());
  check("OPTIONS returns 200 (or any 2xx) without requiring auth", opt.status < 300);
  check("OPTIONS body is empty (nothing to parse before the real request)",
    (await opt.text()) === "");
  assertCoversPreflight("OPTIONS", opt);

  // -- authentication is still required for the real POST --
  const unauth = await handler(postRequest());
  check("POST with no Authorization header is rejected", unauth.status === 401);
  const unauthBody = await unauth.json();
  check("rejected as not_authenticated, not silently allowed",
    unauthBody.error === "not_authenticated", JSON.stringify(unauthBody));
  assertCoversPreflight("unauthenticated POST", unauth);

  // currentUser() validates a presented bearer against Supabase auth, so
  // exercising this path needs that call stubbed too -- a real invalid
  // session correctly gets a real 401 from Supabase, not a dropped
  // connection, which is what this fake reproduces.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    if (String(input).includes("/auth/v1/user")) return new Response("invalid token", { status: 401 });
    throw new Error("unexpected fetch: " + String(input));
  }) as typeof fetch;
  try {
    const bearerNoSession = await handler(postRequest({ Authorization: "Bearer not-a-real-session" }));
    check("a bearer token that cannot be validated is still rejected", bearerNoSession.status !== 200);
    check("...specifically as not_authenticated",
      (await bearerNoSession.json()).error === "not_authenticated");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\n-- gmail-oauth-start: a real signed-in POST still returns the OAuth URL --");
{
  const handler = await loadHandler("../supabase/functions/gmail-oauth-start/index.ts", {
    GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
    GOOGLE_REDIRECT_URI: "https://ref.supabase.co/functions/v1/gmail-oauth-callback",
    SUPABASE_URL: "https://ref.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  });

  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }
    if (url.includes("/rest/v1/email_import_connections")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes("/rest/v1/email_import_oauth_states")) {
      return new Response("[]", { status: 201 });
    }
    throw new Error("unexpected fetch in test: " + url);
  }) as typeof fetch;

  try {
    const res = await handler(postRequest({ Authorization: "Bearer real-session-jwt" }));
    check("a valid signed-in POST succeeds", res.status === 200, String(res.status));
    assertCoversPreflight("successful POST", res);
    const body = await res.json();
    check("the frontend receives a usable OAuth URL", typeof body.url === "string" && body.url.length > 0,
      JSON.stringify(body));
    check("the URL points at Google's consent screen",
      body.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), body.url);
    check("the URL requests only gmail.readonly",
      new URL(body.url).searchParams.get("scope") === "https://www.googleapis.com/auth/gmail.readonly");
    check("the state was persisted before being handed out",
      calls.some((u) => u.includes("/rest/v1/email_import_oauth_states")));
    check("no client secret leaked into the response", !JSON.stringify(body).toLowerCase().includes("secret"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// gmail-sync
// ---------------------------------------------------------------------------
console.log("\n-- gmail-sync: CORS --");
{
  const handler = await loadHandler("../supabase/functions/gmail-sync/index.ts", {
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "secret",
    SYNC_CRON_SECRET: "cron-secret",
    PROVIDER_ENCRYPTION_KEY: "a".repeat(44), // shape only; not exercised here
    SUPABASE_URL: "https://ref.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  });

  const opt = await handler(preflight());
  assertCoversPreflight("OPTIONS", opt);
  check("OPTIONS still allows x-sync-secret for the cron caller",
    (opt.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase().includes("x-sync-secret"));

  const unauth = await handler(postRequest());
  check("Sync now with no Authorization header is rejected", unauth.status === 401);
  assertCoversPreflight("unauthenticated POST", unauth);

  const wrongSecret = await handler(postRequest({ "x-sync-secret": "wrong" }));
  check("a wrong cron secret is rejected", wrongSecret.status === 401);
  assertCoversPreflight("wrong-secret POST", wrongSecret);
}

// ---------------------------------------------------------------------------
// gmail-disconnect
// ---------------------------------------------------------------------------
console.log("\n-- gmail-disconnect: CORS --");
{
  const handler = await loadHandler("../supabase/functions/gmail-disconnect/index.ts", {
    SUPABASE_URL: "https://ref.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    PROVIDER_ENCRYPTION_KEY: "a".repeat(44),
  });

  const opt = await handler(preflight());
  assertCoversPreflight("OPTIONS", opt);

  const unauth = await handler(postRequest());
  check("Disconnect with no Authorization header is rejected", unauth.status === 401);
  const unauthBody = await unauth.json();
  check("rejected as not_authenticated", unauthBody.error === "not_authenticated");
  assertCoversPreflight("unauthenticated POST", unauth);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
