// Supabase Edge Function: connect / disconnect / re-check an external account
// (Wise today; Revolut, PayPal and Stripe plug in as extra ADAPTERS below).
//
// This is the ONLY place a provider access token exists in plaintext, and it
// exists there only in memory, for the duration of one request.
//
// Deploy with "Verify JWT" ON (the default) — every action requires a signed
// in user. Unlike calendar-feed, there is no token-in-URL path here.
//
//   supabase functions deploy provider-connect
//   supabase secrets set PROVIDER_ENCRYPTION_KEY=<base64 of 32 random bytes>
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected
// by the platform. The service-role key is used ONLY inside this function and
// is never returned, logged, or sent to the browser.
//
// ---------------------------------------------------------------------------
// TRUST RULES (the whole point of this file)
// ---------------------------------------------------------------------------
//  1. user_id comes from the verified JWT. Never from the request body.
//  2. household_id is read from that user's own profiles row, server-side.
//     Never from the request body, and never from a provider response.
//  3. The token is encrypted before it touches the database and is never
//     included in any response, on any code path, including errors.
//  4. Every response is metadata only: status, label, masked hint, timestamps.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENCRYPTION_KEY_B64 = Deno.env.get("PROVIDER_ENCRYPTION_KEY");
const KEY_VERSION = 1;

// Sandbox override for testing: https://api.sandbox.transferwise.tech
const WISE_API_BASE = Deno.env.get("WISE_API_BASE") ?? "https://api.transferwise.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Expected, user-fixable outcomes (a wrong token, a revoked token, an
// unreachable provider) are returned as HTTP 200 with an error code, because
// supabase-js hides the response body of any non-2xx function reply — the
// browser would only see a generic "non-2xx status code" and could not tell
// the user what to do. Genuine protocol failures below still use real HTTP
// status codes.
const fail = (code: string) => json({ ok: false, error: code });

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------
// Adding Revolut / PayPal / Stripe later means adding one entry here and one
// line to the provider CHECK constraint in supabase/provider_connections.sql.
// Nothing else in the schema, the function or the UI has to change.
//
// verify() must either return non-secret display metadata, or throw. It must
// never return anything derived from the token itself.

type Verified = { externalId: string | null; label: string | null };
type Adapter = { verify(token: string): Promise<Verified> };

class TokenError extends Error {}

const ADAPTERS: Record<string, Adapter> = {
  wise: {
    async verify(token: string): Promise<Verified> {
      const res = await fetch(`${WISE_API_BASE}/v1/profiles`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

      if (res.status === 401 || res.status === 403) {
        throw new TokenError("invalid_token");
      }
      if (!res.ok) {
        throw new Error(`wise_api_error_${res.status}`);
      }

      const profiles = await res.json();
      if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new TokenError("no_profiles");
      }

      // Prefer the personal profile; fall back to whatever came first.
      const p = profiles.find((x: Record<string, unknown>) => x.type === "personal") ?? profiles[0];
      const d = (p.details ?? {}) as Record<string, string>;
      const label =
        [d.firstName, d.lastName].filter(Boolean).join(" ").trim() ||
        d.name ||
        (p.type ? String(p.type) : null);

      return { externalId: p.id != null ? String(p.id) : null, label: label || null };
    },
  },

  // revolut: { async verify(token) { ... } },
  // paypal:  { async verify(token) { ... } },
  // stripe:  { async verify(token) { ... } },
};

// ---------------------------------------------------------------------------
// Encryption at rest — AES-256-GCM, key held only in Edge Function secrets
// ---------------------------------------------------------------------------
// There is deliberately NO plaintext fallback: if the key is missing the
// function refuses to store anything rather than quietly saving a bare token.

const b64encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(): Promise<CryptoKey> {
  if (!ENCRYPTION_KEY_B64) throw new Error("missing_encryption_key");
  const raw = b64decode(ENCRYPTION_KEY_B64);
  if (raw.length !== 32) throw new Error("bad_encryption_key_length");
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptToken(token: string) {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  return { ciphertext: b64encode(new Uint8Array(ct)), iv: b64encode(iv) };
}

async function decryptToken(ciphertext: string, iv: string) {
  const key = await aesKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(iv) },
    key,
    b64decode(ciphertext),
  );
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// Data access (service role — server side only)
// ---------------------------------------------------------------------------
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  if (!res.ok) throw new Error(`db_${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Resolves the caller from their JWT. Returns null for anything unsigned,
// expired or malformed — the function is never reachable without a real user.
async function currentUser(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: String(u.id) } : null;
}

// The household is ALWAYS read from the caller's own profile. It is never
// accepted from the request body, so a crafted payload cannot attach an
// external account to a household the caller is not a member of.
async function householdOf(userId: string): Promise<string | null> {
  const rows = await rest(
    `profiles?id=eq.${encodeURIComponent(userId)}&select=household_id&limit=1`,
  );
  return rows?.[0]?.household_id ?? null;
}

// The only shape ever sent back to the browser. No token, no ciphertext, no
// iv, no key version.
const publicView = (row: Record<string, unknown> | null) =>
  row
    ? {
        provider: row.provider,
        status: row.status,
        accountLabel: row.account_label,
        secretHint: row.secret_hint,
        lastCheckedAt: row.last_checked_at,
        lastSyncAt: row.last_sync_at,
        lastError: row.last_error,
        createdAt: row.created_at,
      }
    : null;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function connect(userId: string, provider: string, token: string) {
  const householdId = await householdOf(userId);
  if (!householdId) return fail("no_household");

  let verified: Verified;
  try {
    verified = await ADAPTERS[provider].verify(token);
  } catch (e) {
    if (e instanceof TokenError) return fail("invalid_token");
    console.error("provider-connect: verify failed for", provider, String(e));
    return fail("provider_unreachable");
  }

  const { ciphertext, iv } = await encryptToken(token);
  const now = new Date().toISOString();

  // Upsert on (user_id, provider): re-submitting a token rotates the stored
  // credential instead of creating a second, ambiguous connection.
  const rows = await rest(
    "provider_connections?on_conflict=user_id,provider",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        user_id: userId,
        household_id: householdId,
        provider,
        status: "connected",
        external_account_id: verified.externalId,
        account_label: verified.label,
        secret_hint: token.slice(-4),
        last_checked_at: now,
        last_error: null,
      }),
    },
  );
  const conn = rows[0];

  await rest("provider_credentials?on_conflict=connection_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      connection_id: conn.id,
      user_id: userId,
      provider,
      ciphertext,
      iv,
      key_version: KEY_VERSION,
      updated_at: now,
    }),
  });

  return json({ ok: true, connection: publicView(conn) });
}

async function disconnect(userId: string, provider: string) {
  // Scoped by user_id as well as provider, so this can only ever delete the
  // caller's own row. provider_credentials follows via ON DELETE CASCADE.
  await rest(
    `provider_connections?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  );
  return json({ ok: true, connection: null });
}

// Transaction syncing is intentionally NOT implemented yet. "Sync now" proves
// the stored credential still works and refreshes the connection's status, so
// a revoked or expired token surfaces in Settings instead of failing silently
// later. It imports nothing.
async function sync(userId: string, provider: string) {
  const rows = await rest(
    `provider_connections?user_id=eq.${encodeURIComponent(userId)}` +
      `&provider=eq.${encodeURIComponent(provider)}&select=id&limit=1`,
  );
  if (!rows?.length) return fail("not_connected");
  const connectionId = rows[0].id;

  const creds = await rest(
    `provider_credentials?connection_id=eq.${connectionId}&select=ciphertext,iv&limit=1`,
  );
  if (!creds?.length) return fail("not_connected");

  const now = new Date().toISOString();
  let patch: Record<string, unknown>;

  try {
    const token = await decryptToken(creds[0].ciphertext, creds[0].iv);
    const verified = await ADAPTERS[provider].verify(token);
    patch = {
      status: "connected",
      account_label: verified.label,
      external_account_id: verified.externalId,
      last_checked_at: now,
      last_sync_at: now,
      last_error: null,
    };
  } catch (e) {
    const reason = e instanceof TokenError ? "invalid_token" : "provider_unreachable";
    console.error("provider-connect: sync failed for", provider, String(e));
    patch = { status: "error", last_checked_at: now, last_error: reason };
  }

  const updated = await rest(`provider_connections?id=eq.${connectionId}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });

  return json({
    ok: true,
    connection: publicView(updated[0]),
    // Explicit so the UI never has to guess why nothing appeared.
    imported: 0,
    transactionSyncEnabled: false,
  });
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "not_authenticated" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const provider = String(body.provider ?? "");

    if (!ADAPTERS[provider]) return fail("unknown_provider");

    if (action === "connect") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token.length < 20 || token.length > 500) {
        return fail("invalid_token");
      }
      if (!ENCRYPTION_KEY_B64) {
        console.error("provider-connect: PROVIDER_ENCRYPTION_KEY is not set");
        return fail("server_not_configured");
      }
      return await connect(user.id, provider, token);
    }

    if (action === "disconnect") return await disconnect(user.id, provider);
    if (action === "sync") return await sync(user.id, provider);

    return fail("unknown_action");
  } catch (e) {
    // Never echo the exception to the client: it can contain request bodies.
    console.error("provider-connect: unexpected error:", String(e));
    return fail("server_error");
  }
});
