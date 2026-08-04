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
  addressOf, aliasFromRecipients, InboundVerificationError,
  type InboundMessage,
} from "../_shared/inbound-types.ts";
import { fingerprint, wiseEmailParser } from "../_shared/parse-wise-email.ts";
import { retentionExpiry, sanitizeForRetention } from "../_shared/sanitize.ts";
import {
  classifyNormalized, createExpense, isContextFailure, resolveImportContext,
  safeError, type NormalizedTransaction,
} from "../_shared/import-core.ts";

const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const INBOUND_EMAIL_DOMAIN = Deno.env.get("INBOUND_EMAIL_DOMAIN") ?? "";
// Aliases look like `wise-<token>@<domain>`; set to "" for a bare `<token>@`.
const INBOUND_ALIAS_PREFIX = Deno.env.get("INBOUND_ALIAS_PREFIX") ?? "wise";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Records the outcome on the ledger row we already claimed. */
async function mark(rowId: string, patch: Record<string, unknown>) {
  await db.patch(`email_import_messages?id=eq.${q(rowId)}`, patch, "return=minimal")
    .catch(() => {});
}

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
  const claimed = await db.insert(
    "email_import_messages?on_conflict=connection_id,provider_message_id",
    {
      connection_id: connectionId,
      user_id: userId,
      source: adapter.name,
      provider_message_id: envelope.providerMessageId,
      from_address: addressOf(envelope.from),
      received_at: envelope.receivedAt,
      status: "received",
    },
    "resolution=ignore-duplicates,return=representation",
  );
  if (!claimed.length) return json({ ok: true, ignored: "duplicate_message" });
  const rowId = String(claimed[0].id);

  try {
    // ---- sender authenticity: an alias alone must not be enough ----
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

    // ---- retain a sanitised copy for 7 days, for parser diagnosis ----
    // Written now, before parsing, so a message that fails at ANY later step
    // is still diagnosable. Cleared again immediately below if it imports.
    const retained = sanitizeForRetention(message.text, message.html);
    if (retained.text || retained.html) {
      await mark(rowId, {
        raw_text: retained.text,
        raw_html: retained.html,
        raw_content_expires_at: retentionExpiry(new Date()),
      });
    }

    // ---- dedupe layer 2: RFC Message-ID ----
    if (message.rfcMessageId) {
      const dup = await db.select(
        `email_import_messages?connection_id=eq.${q(connectionId)}` +
          `&rfc_message_id=eq.${q(message.rfcMessageId)}&select=id&limit=1`,
      );
      if (dup.length) {
        await mark(rowId, { status: "duplicate", skip_reason: "rfc_message_id" });
        return json({ ok: true, ignored: "duplicate_rfc_message_id" });
      }
      await mark(rowId, { rfc_message_id: message.rfcMessageId });
    }

    // ---- parse ----
    const outcome = wiseEmailParser.parse(message);
    if (!outcome.ok) {
      await mark(rowId, {
        status: outcome.reason === "not_a_transaction" ? "skipped" : "unparsed",
        skip_reason: outcome.detail,
      });
      // 200: a marketing mail or a template we cannot read yet is not a
      // failure the provider should retry.
      return json({ ok: true, ignored: outcome.reason });
    }
    const tx: NormalizedTransaction = outcome.transaction;

    // ---- dedupe layers 3 and 4: transaction reference, then fingerprint ----
    const fp = await fingerprint({
      userScope: connectionId,
      merchant: tx.merchant,
      amount: tx.amount?.value ?? null,
      currency: tx.amount?.currency ?? null,
      occurredAt: tx.occurredAt,
    });

    for (
      const [column, value] of [
        ["external_ref", tx.externalRef],
        ["fingerprint", fp],
      ] as const
    ) {
      if (!value) continue;
      const dup = await db.select(
        `email_import_messages?connection_id=eq.${q(connectionId)}` +
          `&${column}=eq.${q(value)}&select=id&limit=1`,
      );
      if (dup.length) {
        await mark(rowId, { status: "duplicate", skip_reason: column });
        return json({ ok: true, ignored: `duplicate_${column}` });
      }
    }

    await mark(rowId, {
      external_ref: tx.externalRef,
      fingerprint: fp,
      merchant: tx.merchant,
      amount_value: tx.amount?.value ?? null,
      amount_currency: tx.amount?.currency ?? null,
      merchant_amount_value: tx.merchantAmount?.value ?? null,
      merchant_amount_currency: tx.merchantAmount?.currency ?? null,
      occurred_at: tx.occurredAt,
    });

    // ---- only completed outgoing spend becomes an expense ----
    const classification = classifyNormalized(tx);
    if (classification.action === "skip") {
      await mark(rowId, { status: "skipped", skip_reason: classification.reason });
      return json({ ok: true, ignored: classification.reason });
    }

    // ---- household, payer and rates come from the database, never the mail --
    const ctx = await resolveImportContext(db, userId, new Date());
    if (isContextFailure(ctx)) {
      await mark(rowId, { status: "skipped", skip_reason: ctx.error });
      return json({ ok: true, ignored: ctx.error });
    }

    const result = await createExpense(db, ctx, tx);
    if (result.status === "failed") {
      await mark(rowId, { status: "failed", error_summary: result.reason });
      return json({ ok: true, ignored: "import_failed" });
    }

    await mark(rowId, {
      status: "imported",
      household_id: ctx.householdId,
      expense_id: result.expenseId,
      mapped_category: result.category,
      category_source: result.categoryFallback ? "fallback" : "mapped",
      error_summary: null,
      // Early purge: a message that parsed cleanly needs no diagnosis, so its
      // body goes now rather than sitting for the full seven days.
      raw_text: null,
      raw_html: null,
      raw_content_expires_at: null,
    });

    await db.patch(
      `email_import_connections?id=eq.${q(connectionId)}`,
      { last_message_at: new Date().toISOString(), status: "active", last_error: null },
      "return=minimal",
    ).catch(() => {});

    // Counters only.
    console.log("inbound-email: imported 1 transaction");
    return json({ ok: true, imported: 1 });
  } catch (e) {
    // One malformed message must never take the endpoint down.
    console.error("inbound-email: unexpected error:", safeError(e));
    await mark(rowId, { status: "failed", error_summary: safeError(e) });
    return json({ ok: true, ignored: "error_recorded" });
  }
});
