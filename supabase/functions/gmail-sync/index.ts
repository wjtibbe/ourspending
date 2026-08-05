// Supabase Edge Function: Gmail polling — the daily cron AND "Sync now".
//
//   supabase functions deploy gmail-sync
//   supabase secrets set SYNC_CRON_SECRET=<base64 of 32 random bytes>
//
// Two callers, deliberately one implementation (_shared/gmail-sync.ts), so a
// manual sync can never behave differently from the scheduled one:
//
//   cron       x-sync-secret header, compared in constant time -> EVERY
//              enabled connection.
//   "Sync now" a signed-in user's JWT -> ONLY that user's own connection.
//
// The cron path deliberately does not accept a user JWT and the user path
// deliberately cannot reach anyone else's mailbox. Neither relies on an open
// browser session.

import { currentUser, db } from "../_shared/rest.ts";
import { decryptToken, encryptToken, hasEncryptionKey, safeEqual } from "../_shared/crypto.ts";
import { safeError } from "../_shared/import-core.ts";
import {
  enabledGmailConnections, syncGmailConnections,
  type GmailConnectionRow, type GmailSyncDeps,
} from "../_shared/gmail-sync.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SYNC_CRON_SECRET = Deno.env.get("SYNC_CRON_SECRET");
const GMAIL_LABEL = Deno.env.get("GMAIL_LABEL") ?? "";
const lookbackConfigured = parseInt(Deno.env.get("GMAIL_LOOKBACK_DAYS") ?? "", 10);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, x-sync-secret",
    },
  });

const deps = (): GmailSyncDeps => ({
  db,
  now: () => new Date(),
  fetchImpl: fetch,
  clientId: GOOGLE_CLIENT_ID!,
  clientSecret: GOOGLE_CLIENT_SECRET!,
  encrypt: encryptToken,
  decrypt: decryptToken,
  lookbackDays: Number.isFinite(lookbackConfigured) && lookbackConfigured > 0
    ? lookbackConfigured
    : 2,
  label: GMAIL_LABEL.trim() || null,
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !hasEncryptionKey()) {
    console.error("gmail-sync: missing required configuration");
    return json({ error: "server_not_configured" }, 500);
  }

  const presented = req.headers.get("x-sync-secret");
  let connections: GmailConnectionRow[];
  let trigger: "cron" | "manual";

  if (presented !== null) {
    // ---- scheduled run ----
    if (!SYNC_CRON_SECRET) {
      console.error("gmail-sync: SYNC_CRON_SECRET is not set");
      return json({ error: "server_not_configured" }, 500);
    }
    // Constant time, so the secret cannot be discovered one character at a
    // time by measuring how long the comparison takes.
    if (!safeEqual(presented, SYNC_CRON_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }
    trigger = "cron";
    connections = await enabledGmailConnections(db);
  } else {
    // ---- "Sync now" ----
    const user = await currentUser(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    trigger = "manual";
    // Scoped to the caller by the query itself: there is no request field
    // that could widen this to someone else's connection.
    const rows = await db.select(
      `email_import_connections?user_id=eq.${encodeURIComponent(user.id)}` +
        "&provider=eq.gmail&enabled=is.true&select=id,user_id,enabled,account_email&limit=1",
    );
    connections = rows.map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      enabled: true,
      account_email: r.account_email ? String(r.account_email) : null,
    }));
    if (!connections.length) return json({ error: "not_connected" }, 400);
  }

  try {
    const stats = await syncGmailConnections(deps(), connections);
    // Counters only -- no addresses, merchants or amounts.
    console.log(
      `gmail-sync: ${trigger} processed=${stats.connectionsProcessed} ` +
        `imported=${stats.expensesImported} duplicates=${stats.duplicatesSkipped} ` +
        `unparsed=${stats.unparsed} failed=${stats.failed}`,
    );
    return json({ ok: true, trigger, ...stats });
  } catch (e) {
    console.error("gmail-sync: run failed:", safeError(e));
    return json({ error: "sync_failed" }, 500);
  }
});
