// Supabase Edge Function: complete Gmail OAuth.
//
// Deploy with "Verify JWT" OFF -- this URL is reached by Google redirecting
// the user's BROWSER, which carries no Supabase session header:
//
//   supabase functions deploy gmail-oauth-callback --no-verify-jwt
//
// That makes the state row the only thing establishing identity, which is
// exactly why it is generated with a CSPRNG, bound to one user, and consumed
// atomically. A replayed or forged state resolves to no user and the request
// dies here.
//
// The authorization code is exchanged SERVER-SIDE, so the client secret and
// the resulting refresh token never exist anywhere near a browser. The
// refresh token is encrypted before it reaches Postgres.

import { db, q } from "../_shared/rest.ts";
import { encryptToken, hasEncryptionKey } from "../_shared/crypto.ts";
import { exchangeCode, getProfileEmail, GMAIL_SCOPE } from "../_shared/gmail.ts";
import { safeError } from "../_shared/import-core.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const GOOGLE_REDIRECT_URI = Deno.env.get("GOOGLE_REDIRECT_URI");
const APP_URL = Deno.env.get("APP_URL") ?? "";

/** Sends the browser back to the app with a short, non-sensitive marker. */
function back(status: string): Response {
  const base = APP_URL || "/";
  const sep = base.includes("?") ? "&" : "?";
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}${sep}gmail=${encodeURIComponent(status)}` },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("method_not_allowed", { status: 405 });

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    console.error("gmail-oauth-callback: missing Google OAuth configuration");
    return back("server_not_configured");
  }
  if (!hasEncryptionKey()) {
    // Refusing loudly beats storing a bare refresh token.
    console.error("gmail-oauth-callback: PROVIDER_ENCRYPTION_KEY is not set");
    return back("server_not_configured");
  }

  const url = new URL(req.url);
  const denied = url.searchParams.get("error");
  if (denied) return back("denied");

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return back("invalid_request");

  try {
    // Single-use: the same statement that reads the state marks it consumed,
    // so a replay -- even a concurrent one -- finds nothing.
    const consumed = await db.insert(
      "rpc/consume_email_import_oauth_state",
      { p_state: state },
    );
    const row = consumed[0];
    if (!row?.user_id || !row?.code_verifier) return back("invalid_state");

    const userId = String(row.user_id);

    const tokens = await exchangeCode({
      code,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: GOOGLE_REDIRECT_URI,
      codeVerifier: String(row.code_verifier),
    });

    // Without a refresh token the connection would stop working in an hour
    // with no way to renew, so treat it as a failed connect rather than
    // storing something that looks connected but is not.
    let refreshToken = tokens.refreshToken;
    if (!refreshToken) {
      const existing = await db.select(
        `email_import_connections?user_id=eq.${q(userId)}&provider=eq.gmail&select=id&limit=1`,
      );
      if (existing.length) {
        const prior = await db.select(
          `email_import_credentials?connection_id=eq.${q(String(existing[0].id))}` +
            "&select=ciphertext,iv&limit=1",
        );
        // A reconnect that reuses the existing grant legitimately omits the
        // refresh token; keeping the stored one is the correct behaviour.
        if (prior.length) refreshToken = null;
        else return back("no_refresh_token");
      } else {
        return back("no_refresh_token");
      }
    }

    const accountEmail = await getProfileEmail(tokens.accessToken).catch(() => null);

    const connections = await db.insert(
      "email_import_connections?on_conflict=user_id,provider",
      {
        user_id: userId,
        provider: "gmail",
        alias_token: null,
        enabled: true,
        status: "active",
        account_email: accountEmail,
        granted_scopes: tokens.scope ?? GMAIL_SCOPE,
        access_expires_at: tokens.expiresAt,
        last_error: null,
      },
      "resolution=merge-duplicates,return=representation",
    );
    const connectionId = String(connections[0].id);

    if (refreshToken) {
      const payload = JSON.stringify({
        refresh_token: refreshToken,
        access_token: tokens.accessToken,
        expires_at: tokens.expiresAt,
      });
      const enc = await encryptToken(payload);
      await db.insert(
        "email_import_credentials?on_conflict=connection_id",
        {
          connection_id: connectionId,
          user_id: userId,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          key_version: 1,
        },
        "resolution=merge-duplicates,return=minimal",
      );
    }

    // Counters only: never the address, the token or the code.
    console.log("gmail-oauth-callback: connected 1 mailbox");
    return back("connected");
  } catch (e) {
    console.error("gmail-oauth-callback: failed:", safeError(e));
    return back("failed");
  }
});
