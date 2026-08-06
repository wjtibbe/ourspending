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
