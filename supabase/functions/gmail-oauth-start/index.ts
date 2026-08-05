// Supabase Edge Function: begin Gmail OAuth.
//
//   supabase functions deploy gmail-oauth-start
//
// Requires a signed-in caller. The returned consent URL is bound to THAT
// user through a single-use state row, which is the whole point: without it,
// an attacker could start a flow, hand the URL to a victim, and have the
// victim's mailbox attached to the attacker's account.
//
// Nothing secret reaches the browser. The client secret stays here; the PKCE
// verifier stays in the database; only the public consent URL is returned.

import { currentUser, db } from "../_shared/rest.ts";
import { buildAuthUrl, codeChallengeOf, randomToken } from "../_shared/gmail.ts";
import { safeError } from "../_shared/import-core.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_REDIRECT_URI = Deno.env.get("GOOGLE_REDIRECT_URI");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
    },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    console.error("gmail-oauth-start: missing Google OAuth configuration");
    return json({ error: "server_not_configured" }, 500);
  }

  const user = await currentUser(req);
  if (!user) return json({ error: "not_authenticated" }, 401);

  try {
    // Does this user already hold a working credential? If so, this is a
    // reconnect and we do NOT force the consent screen again -- Google will
    // simply return a fresh access token against the existing grant.
    const existing = await db.select(
      `email_import_connections?user_id=eq.${encodeURIComponent(user.id)}` +
        "&provider=eq.gmail&select=id,account_email&limit=1",
    );
    const hasCredential = existing.length > 0 &&
      (await db.select(
        `email_import_credentials?connection_id=eq.${encodeURIComponent(String(existing[0].id))}` +
          "&select=connection_id&limit=1",
      )).length > 0;

    const state = randomToken(32);
    const verifier = randomToken(32);

    // Stored server-side, bound to this user, before the URL is handed out.
    await db.insert("email_import_oauth_states", {
      state,
      user_id: user.id,
      code_verifier: verifier,
      redirect_uri: GOOGLE_REDIRECT_URI,
    }, "return=minimal");

    const url = buildAuthUrl({
      clientId: GOOGLE_CLIENT_ID,
      redirectUri: GOOGLE_REDIRECT_URI,
      state,
      codeChallenge: await codeChallengeOf(verifier),
      // First connect must force consent, or Google issues no refresh token
      // and the connection dies silently in an hour.
      forceConsent: !hasCredential,
      loginHint: existing[0]?.account_email ? String(existing[0].account_email) : null,
    });

    // The URL contains the state and challenge, both public by design.
    return json({ url });
  } catch (e) {
    console.error("gmail-oauth-start: failed:", safeError(e));
    return json({ error: "start_failed" }, 500);
  }
});
