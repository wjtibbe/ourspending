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
//  5. Connect/reconnect verifies with GET /v1/me ONLY -- never /v1/profiles,
//     balances or a balance statement, and never a business-profile check.
//     Those need broader token permissions than plain identity and are not
//     required merely to prove a token works; they are exercised for real
//     the first time Sync now / the hourly job actually needs them.

import { currentUser, db, del, q } from "../_shared/rest.ts";
import { encryptToken, hasEncryptionKey, KEY_VERSION } from "../_shared/crypto.ts";
import { publicStats, syncDeps } from "../_shared/deps.ts";
import { recordRun, safeError, syncMany, type ConnectionRow } from "../_shared/sync.ts";
import {
  verifyWiseToken, WiseVerificationError,
  WISE_API_BASE_DEFAULT, type WiseIdentity,
} from "../_shared/wise.ts";

// Sandbox override for testing: https://api.sandbox.transferwise.tech
const WISE_API_BASE = Deno.env.get("WISE_API_BASE") ?? WISE_API_BASE_DEFAULT;

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

type Adapter = { verify(token: string): Promise<WiseIdentity> };

const ADAPTERS: Record<string, Adapter> = {
  // The real check lives in _shared/wise.ts (verifyWiseToken), so it can be
  // unit-tested without a live Deno runtime. This is a thin wrapper only.
  wise: { verify: (token) => verifyWiseToken(token, { base: WISE_API_BASE }) },

  // revolut: { async verify(token) { ... } },
  // paypal:  { async verify(token) { ... } },
  // stripe:  { async verify(token) { ... } },
};

// ---------------------------------------------------------------------------
// Data access (service role — server side only, see _shared/rest.ts)
// ---------------------------------------------------------------------------
// The household is ALWAYS read from the caller's own profile. It is never
// accepted from the request body, so a crafted payload cannot attach an
// external account to a household the caller is not a member of.
async function householdOf(userId: string): Promise<string | null> {
  const rows = await db.select(`profiles?id=eq.${q(userId)}&select=household_id&limit=1`);
  return rows?.[0]?.household_id ? String(rows[0].household_id) : null;
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

/**
 * The exact row upserted into provider_connections after a successful check.
 * Pulled out as its own pure function so "a 200 from the provider marks the
 * connection connected" is something a test can assert directly, without
 * going through Deno.serve or a real database.
 */
export function buildConnectionRow(
  userId: string,
  householdId: string,
  provider: string,
  verified: WiseIdentity,
  secretHint: string,
  nowIso: string,
) {
  return {
    user_id: userId,
    household_id: householdId,
    provider,
    status: "connected",
    external_account_id: verified.externalId,
    account_label: verified.label,
    secret_hint: secretHint,
    last_checked_at: nowIso,
    last_error: null,
  };
}

async function connect(userId: string, provider: string, rawToken: string) {
  // Trimmed here, not just by the caller below: verification, encryption and
  // storage must all see the same, whitespace-free value.
  const token = rawToken.trim();

  const householdId = await householdOf(userId);
  if (!householdId) return fail("no_household");

  let verified: WiseIdentity;
  try {
    verified = await ADAPTERS[provider].verify(token);
  } catch (e) {
    if (e instanceof WiseVerificationError) return fail(e.code);
    console.error("provider-connect: verify failed for", provider, String(e));
    return fail("wise_temporarily_unavailable");
  }

  const { ciphertext, iv } = await encryptToken(token);
  const now = new Date().toISOString();

  // Upsert on (user_id, provider): re-submitting a token rotates the stored
  // credential instead of creating a second, ambiguous connection.
  const rows = await db.insert(
    "provider_connections?on_conflict=user_id,provider",
    buildConnectionRow(userId, householdId, provider, verified, token.slice(-4), now),
    "resolution=merge-duplicates,return=representation",
  );
  const conn = rows[0];

  await db.insert(
    "provider_credentials?on_conflict=connection_id",
    {
      connection_id: conn.id,
      user_id: userId,
      provider,
      ciphertext,
      iv,
      key_version: KEY_VERSION,
      updated_at: now,
    },
    "resolution=merge-duplicates,return=minimal",
  );

  return json({ ok: true, connection: publicView(conn) });
}

async function disconnect(userId: string, provider: string) {
  // Scoped by user_id as well as provider, so this can only ever delete the
  // caller's own row. provider_credentials follows via ON DELETE CASCADE.
  await del(`provider_connections?user_id=eq.${q(userId)}&provider=eq.${q(provider)}`);
  return json({ ok: true, connection: null });
}

// "Sync now" runs exactly the same core as the hourly cron job — see
// _shared/sync.ts — scoped to this caller's own connection. The two entry
// points differ only in who may call them and which connections they pass in.
async function sync(userId: string, provider: string) {
  const rows = await db.select(
    `provider_connections?user_id=eq.${q(userId)}&provider=eq.${q(provider)}` +
      "&select=id,user_id,provider&limit=1",
  );
  if (!rows?.length) return fail("not_connected");

  const conn: ConnectionRow = {
    id: String(rows[0].id),
    user_id: String(rows[0].user_id),
    provider: String(rows[0].provider),
  };

  const started = new Date();
  let stats;
  try {
    // syncMany already updates last_checked_at / last_sync_at / status and
    // isolates failures, so nothing extra is needed here.
    stats = await syncMany(syncDeps, [conn]);
    await recordRun(db, "manual", started, stats);
  } catch (e) {
    console.error("provider-connect: sync failed:", safeError(e));
    return fail("server_error");
  }

  const updated = await db.select(`provider_connections?id=eq.${q(conn.id)}&select=*&limit=1`);
  const outcome = stats.connections[0];

  return json({
    ok: true,
    connection: publicView(updated[0] ?? null),
    stats: publicStats(stats),
    // Surfaced so the UI can say "reconnect" rather than a generic failure.
    connectionError: outcome?.status === "error" ? outcome.error : null,
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
      if (!hasEncryptionKey()) {
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
