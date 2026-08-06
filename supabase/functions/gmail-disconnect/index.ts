// Supabase Edge Function: disconnect Gmail.
//
//   supabase functions deploy gmail-disconnect
//
// Two things happen, in this order, and the order matters: Google's copy of
// the grant is revoked FIRST, while the token is still readable, and the
// local rows are deleted second. Doing it the other way round would leave a
// live grant on Google's side that the user can no longer see or revoke from
// this app.
//
// Revocation is best-effort: if Google is unreachable, the local rows still
// go, because a user who asked to disconnect must not stay connected here.

import { currentUser, db, del, q } from "../_shared/rest.ts";
import { decryptToken } from "../_shared/crypto.ts";
import { revokeToken } from "../_shared/gmail.ts";
import { safeError } from "../_shared/import-core.ts";

// Matches provider-connect's established pattern. supabase-js's
// functions.invoke() always sends apikey and x-client-info alongside
// authorization and content-type -- omitting either from Allow-Headers
// makes the browser's CORS preflight fail closed with no error surfaced to
// this function at all: the request never arrives, only the OPTIONS does.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  // Answered before anything else, and unauthenticated: the platform lets an
  // OPTIONS preflight through even with "Verify JWT" on, but only if the
  // function itself replies -- and the reply must carry these headers or the
  // browser blocks the real request that would have followed.
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "not_authenticated" }, 401);

  try {
    const conns = await db.select(
      `email_import_connections?user_id=eq.${q(user.id)}` +
        "&provider=eq.gmail&select=id&limit=1",
    );

    if (conns.length) {
      const connectionId = String(conns[0].id);
      const creds = await db.select(
        `email_import_credentials?connection_id=eq.${q(connectionId)}` +
          "&select=ciphertext,iv&limit=1",
      );
      if (creds.length) {
        try {
          const cred = JSON.parse(
            await decryptToken(String(creds[0].ciphertext), String(creds[0].iv)),
          );
          if (cred?.refresh_token) {
            // Revoking the refresh token invalidates the whole grant,
            // including any access token derived from it.
            await revokeToken(String(cred.refresh_token));
          }
        } catch {
          // An unreadable credential cannot be revoked. The rows still go.
        }
      }
    }

    // Scoped to the caller's own row by the filter itself. The user id comes
    // from the verified JWT above, never from the request body, and the
    // cascade removes the credential and the ledger with it.
    await del(`email_import_connections?user_id=eq.${q(user.id)}&provider=eq.gmail`);

    console.log("gmail-disconnect: disconnected 1 mailbox");
    return json({ ok: true });
  } catch (e) {
    console.error("gmail-disconnect: failed:", safeError(e));
    return json({ error: "disconnect_failed" }, 500);
  }
});
