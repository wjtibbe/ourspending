// =============================================================================
// INACTIVE -- retained as a future/alternate inbound adapter.
// =============================================================================
// Gmail OAuth polling replaced Resend inbound forwarding: it needs no inbound
// domain, no MX records and no manual forwarding setup, which suits a private
// app with a handful of users. See supabase/GMAIL_SETUP.md.
//
// This function is NOT part of the current setup instructions and no UI calls
// it. It is kept, unbroken and still tested, because it is the only adapter
// that works for a mailbox the app cannot poll -- and because rollback should
// be a redeploy rather than a rewrite.
//
// Note that it now shares _shared/email-import-core.ts with the Gmail path, so
// both adapters produce byte-identical expenses from the same email.
// =============================================================================
//
// Supabase Edge Function: inbound transaction emails.
//
// Deploy with "Verify JWT" OFF -- an email provider cannot present a user JWT.
// Authenticity comes from the provider's webhook signature instead.
//
//   supabase functions deploy inbound-email --no-verify-jwt
//   supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...
//   supabase secrets set RESEND_API_KEY=re_...
//   supabase secrets set INBOUND_EMAIL_DOMAIN=inbound.yourdomain.com
//
// ---------------------------------------------------------------------------
// TRUST RULES
// ---------------------------------------------------------------------------
//  1. The signature is verified against the RAW body before anything is read.
//  2. The user is resolved ONLY from the alias token in the recipient address.
//     No user id, household id or amount is ever taken from the payload.
//  3. The household and payer slot are re-derived from that user's CURRENT
//     profile by import-core, never from the message.
//  4. The sender must be the bank's own domain: knowing an alias is not
//     enough to inject an expense.
//  5. Nothing sensitive is logged -- no addresses, merchants or amounts.
//  6. Always answer 200 once the message is recorded, so the provider does not
//     retry a message we have already durably accounted for.

import { db, q } from "../_shared/rest.ts";
import { createResendAdapter } from "../_shared/inbound-resend.ts";
import {
  addressOf, aliasFromRecipients,
  type InboundMessage,
} from "../_shared/inbound-types.ts";
import { wiseEmailParser } from "../_shared/parse-wise-email.ts";
import { safeError } from "../_shared/import-core.ts";
import {
  claimMessage, importClaimedMessage, markMessage,
} from "../_shared/email-import-core.ts";
import { createAiClassifier, type AiClassifier } from "../_shared/merchant-categorization.ts";

const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const INBOUND_EMAIL_DOMAIN = Deno.env.get("INBOUND_EMAIL_DOMAIN") ?? "";
// Aliases look like `wise-<token>@<domain>`; set to "" for a bare `<token>@`.
const INBOUND_ALIAS_PREFIX = Deno.env.get("INBOUND_ALIAS_PREFIX") ?? "wise";

// Same feature flag as gmail-sync, kept in step so re-activating this
// adapter someday behaves identically. Off unless both are explicitly set.
const AI_CATEGORIZATION_ENABLED = (Deno.env.get("AI_CATEGORIZATION_ENABLED") ?? "")
  .trim().toLowerCase() === "true";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const aiClassifier: AiClassifier | null = AI_CATEGORIZATION_ENABLED && ANTHROPIC_API_KEY
  ? createAiClassifier(ANTHROPIC_API_KEY)
  : null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Records the outcome on the ledger row we already claimed. */
const mark = (rowId: string, patch: Record<string, unknown>) =>
  markMessage(db, rowId, patch);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!RESEND_WEBHOOK_SECRET || !RESEND_API_KEY || !INBOUND_EMAIL_DOMAIN) {
    console.error("inbound-email: missing required configuration");
    return json({ error: "server_not_configured" }, 500);
  }

  // The raw body, untouched. Parsing and re-serialising would change bytes and
  // break every signature scheme.
  const rawBody = await req.text();
  const adapter = createResendAdapter(RESEND_WEBHOOK_SECRET, RESEND_API_KEY);

  try {
    await adapter.verify(req.headers, rawBody);
  } catch (e) {
    // 401, and nothing else: an unverified caller learns nothing about whether
    // the alias, the user or the message existed.
    console.warn("inbound-email: rejected unverified request:", safeError(e));
    return json({ error: "unauthorized" }, 401);
  }

  const envelope = adapter.parseEnvelope(rawBody);
  if (!envelope) {
    // A non-inbound event (delivery, bounce, open). Not an error.
    return json({ ok: true, ignored: "not_an_inbound_message" });
  }

  // ---- resolve the user from the alias, and nothing else ----
  const token = aliasFromRecipients(
    envelope.recipients, INBOUND_EMAIL_DOMAIN, INBOUND_ALIAS_PREFIX,
  );
  if (!token) return json({ ok: true, ignored: "no_alias" });

  const conns = await db.select(
    `email_import_connections?alias_token=eq.${q(token)}` +
      "&select=id,user_id,enabled,provider&limit=1",
  );
  const conn = conns[0];
  // Unknown alias: answer exactly as for a known-but-disabled one, so the
  // endpoint cannot be used to test which aliases exist.
  if (!conn) return json({ ok: true, ignored: "unknown_alias" });
  if (conn.enabled === false) return json({ ok: true, ignored: "connection_disabled" });

  const connectionId = String(conn.id);
  const userId = String(conn.user_id);

  // ---- dedupe layer 1: the provider's own message id ----
  // Claimed BEFORE any work, so a webhook retry cannot double-import even if
  // the first attempt is still running.
  const claim = await claimMessage(db, {
    connectionId,
    userId,
    source: adapter.name,
    providerMessageId: envelope.providerMessageId,
    fromAddress: addressOf(envelope.from),
    receivedAt: envelope.receivedAt,
  });
  if (!claim.claimed) return json({ ok: true, ignored: "duplicate_message" });
  const rowId = claim.rowId;

  try {
    // ---- sender authenticity, checked on the ENVELOPE ----
    // Done here rather than leaving it to the shared core purely as an
    // optimisation: rejecting junk now avoids paying for a content fetch.
    // The core checks it again on the full message regardless.
    if (!wiseEmailParser.recognises({ ...envelope, text: null, html: null, headers: {}, rfcMessageId: null })) {
      await mark(rowId, { status: "skipped", skip_reason: "sender_not_recognised" });
      return json({ ok: true, ignored: "sender_not_recognised" });
    }

    // ---- fetch the body (Resend's webhook carries metadata only) ----
    let message: InboundMessage;
    try {
      message = await adapter.fetchContent(envelope);
    } catch (e) {
      await mark(rowId, { status: "failed", error_summary: safeError(e) });
      // 500 so the provider retries: the message is real, we just could not
      // read it. The claimed row makes the retry idempotent.
      return json({ ok: false, error: "content_fetch_failed" }, 500);
    }

    // ---- everything else is the SHARED pipeline ----
    // Retention, dedupe layers 2-4, parsing, classification, household/payer
    // resolution and expense creation all live in email-import-core.ts, so
    // this adapter and the Gmail poller cannot drift apart.
    const result = await importClaimedMessage(db, {
      rowId,
      connectionId,
      userId,
      message,
      now: new Date(),
      aiClassifier,
    });

    if (result.outcome === "imported") {
      await db.patch(
        `email_import_connections?id=eq.${q(connectionId)}`,
        { last_message_at: new Date().toISOString(), status: "active", last_error: null },
        "return=minimal",
      ).catch(() => {});
      // Counters only.
      console.log("inbound-email: imported 1 transaction");
      return json({ ok: true, imported: 1 });
    }

    // 200 for everything else: a marketing mail, a duplicate, or a template
    // we cannot read yet is not a failure the provider should retry.
    return json({ ok: true, ignored: result.outcome, reason: result.reason });
  } catch (e) {
    // One malformed message must never take the endpoint down.
    console.error("inbound-email: unexpected error:", safeError(e));
    await mark(rowId, { status: "failed", error_summary: safeError(e) });
    return json({ ok: true, ignored: "error_recorded" });
  }
});
