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
  diagnoseDiscovery, enabledGmailConnections, syncGmailConnections,
  type GmailConnectionRow, type GmailSyncDeps,
} from "../_shared/gmail-sync.ts";
import { createAiClassifier, type AiClassifier } from "../_shared/merchant-categorization.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SYNC_CRON_SECRET = Deno.env.get("SYNC_CRON_SECRET");
const GMAIL_LABEL = Deno.env.get("GMAIL_LABEL") ?? "";
// Comma-separated escape hatch, e.g. "wise.com,e.wise.com". Left unset, the
// query uses the Wise domains the sender-authenticity gate already trusts.
const GMAIL_SENDERS = Deno.env.get("GMAIL_SENDERS") ?? "";

// AI categorisation fallback (layer 4) is feature-flagged and off by
// default: it only ever runs once household rules, the existing global
// mapping and the multilingual keyword mapping have all found nothing, and
// even then only if BOTH this flag is explicitly on AND a key is set.
const AI_CATEGORIZATION_ENABLED = (Deno.env.get("AI_CATEGORIZATION_ENABLED") ?? "")
  .trim().toLowerCase() === "true";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const aiClassifier: AiClassifier | null = AI_CATEGORIZATION_ENABLED && ANTHROPIC_API_KEY
  ? createAiClassifier(ANTHROPIC_API_KEY)
  : null;
// Default 8, not 2: the job runs once daily, and Gmail OAuth or the
// scheduled invocation can occasionally fail outright (a dead token, a
// transient 5xx). An 8-day window means one or even several missed days
// still catch up on the next successful run. This is safe to widen because
// duplicate protection does not depend on the window being tight -- four
// independent dedupe keys (provider message id, RFC Message-ID, transaction
// reference, fingerprint) already make re-scanning the same message a no-op
// rather than a second expense. See claimMessage()/importClaimedMessage() in
// _shared/email-import-core.ts, unchanged here.
const lookbackConfigured = parseInt(Deno.env.get("GMAIL_LOOKBACK_DAYS") ?? "", 10);

// Matches provider-connect's established pattern, with x-sync-secret added
// for the cron caller. supabase-js's functions.invoke() ("Sync now") always
// sends apikey and x-client-info alongside authorization and content-type --
// omitting either from Allow-Headers makes the browser's CORS preflight fail
// closed with no error surfaced to this function at all: the request never
// arrives, only the OPTIONS does.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    : 8,
  label: GMAIL_LABEL.trim() || null,
  senders: GMAIL_SENDERS.trim() || null,
  aiClassifier,
});

Deno.serve(async (req) => {
  // Answered before anything else, and unauthenticated: the platform lets an
  // OPTIONS preflight through even with "Verify JWT" on, but only if the
  // function itself replies -- and the reply must carry these headers or the
  // browser blocks the real request (cron's x-sync-secret path is a
  // server-to-server call and never preflights, but the browser-driven
  // "Sync now" path does).
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !hasEncryptionKey()) {
    console.error("gmail-sync: missing required configuration");
    return json({ error: "server_not_configured" }, 500);
  }

  // Read once, tolerantly: the body is optional and every existing caller
  // sends either nothing or {"trigger":"cron"}. A malformed or absent body
  // must behave exactly as before, so parse failures fall back to {}.
  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const diagnose = body.mode === "diagnose";

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
    // The diagnostic reports the mailbox address behind a connection. On this
    // path `connections` is EVERY enabled connection, so answering here would
    // hand one caller other people's addresses. The diagnostic is for a
    // signed-in user inspecting their own connection, and nothing else.
    if (diagnose) return json({ error: "diagnose_requires_user_auth" }, 403);
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

  // ---- read-only discovery probe ----
  // Claims no ledger row, writes no ledger row, creates no expense, and does
  // not touch categorisation, retry state or the parser. It asks Gmail one
  // fixed, deliberately literal question and reports what came back.
  if (diagnose) {
    const report = await diagnoseDiscovery(deps(), connections[0]);
    console.log(
      `gmail-sync: diagnose connection=${report.connectionId} ` +
        `listed=${report.gmailMessagesListed} estimate=${report.gmailResultSizeEstimate} ` +
        `pages=${report.gmailPagesFetched} more_available=${report.gmailMoreAvailable} ` +
        `account_matches_profile=${report.accountMatchesProfile} ` +
        `newest=${report.newestMatchingInternalDate} error=${report.error}`,
    );
    return json({ ok: true, mode: "diagnose", ...report });
  }

  try {
    const stats = await syncGmailConnections(deps(), connections);
    // Counters only -- no addresses, merchants or amounts.
    console.log(
      `gmail-sync: ${trigger} processed=${stats.connectionsProcessed} ` +
        `imported=${stats.expensesImported} duplicates=${stats.duplicatesSkipped} ` +
        `(already_imported=${stats.duplicatesAlreadyImported} ` +
        `terminal_skip=${stats.terminalSkipped}) retried=${stats.retriedRows} ` +
        `unparsed=${stats.unparsed} failed=${stats.failed} ` +
        `listed=${stats.gmailMessagesListed} rejected_sender=${stats.rejectedSender} ` +
        `rejected_template=${stats.rejectedTemplate} pages=${stats.gmailPagesFetched} ` +
        `estimate=${stats.gmailResultSizeEstimate} more_available=${stats.gmailMoreAvailable} ` +
        `query=${JSON.stringify(stats.queryUsed)}`,
    );
    return json({ ok: true, trigger, ...stats });
  } catch (e) {
    console.error("gmail-sync: run failed:", safeError(e));
    return json({ error: "sync_failed" }, 500);
  }
});
