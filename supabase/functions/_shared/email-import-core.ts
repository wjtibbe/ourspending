// The shared journey from "an email exists" to "an expense exists".
//
// This is deliberately NOT specific to how the message arrived. Resend pushes
// messages at us over a webhook; Gmail is polled on a schedule. Everything
// after that point -- four independent dedupe layers, sanitised retention,
// deterministic parsing, classification, household/payer resolution and
// expense creation -- must behave identically, or the same Wise email would
// import differently depending on which pipe carried it.
//
// So both callers hand an InboundMessage to the same two functions here:
//
//   claimMessage()          dedupe layer 1, before any real work
//   importClaimedMessage()  layers 2-4, then parse -> classify -> expense
//
// Splitting the claim from the import is what makes a retry safe: the row is
// claimed BEFORE the body is fetched, so a crash mid-fetch leaves a durable
// record rather than a message that will be processed twice.

import type { Db, Row } from "./import-core.ts";
import type { InboundMessage } from "./inbound-types.ts";
import { fingerprint, wiseEmailParser } from "./parse-wise-email.ts";
import { retentionExpiry, sanitizeForRetention } from "./sanitize.ts";
import {
  classifyNormalized, createExpense, isContextFailure, q, resolveImportContext,
  safeError, type NormalizedTransaction,
} from "./import-core.ts";

/** Records an outcome on an already-claimed ledger row. Never throws. */
export async function markMessage(db: Db, rowId: string, patch: Row): Promise<void> {
  await db.patch(`email_import_messages?id=eq.${q(rowId)}`, patch, "return=minimal")
    .catch(() => {});
}

export type ClaimResult =
  | { claimed: true; rowId: string }
  | { claimed: false; reason: "duplicate_message" };

/**
 * Dedupe layer 1: the delivering system's own message id.
 *
 * Claimed before any other work, so a webhook retry or an overlapping poll
 * window cannot double-import even while the first attempt is still running.
 * `resolution=ignore-duplicates` turns the unique-index collision into an
 * empty result rather than an error.
 */
export async function claimMessage(db: Db, params: {
  connectionId: string;
  userId: string;
  source: string;
  providerMessageId: string;
  fromAddress: string | null;
  receivedAt: string;
}): Promise<ClaimResult> {
  const claimed = await db.insert(
    "email_import_messages?on_conflict=connection_id,provider_message_id",
    {
      connection_id: params.connectionId,
      user_id: params.userId,
      source: params.source,
      provider_message_id: params.providerMessageId,
      from_address: params.fromAddress,
      received_at: params.receivedAt,
      status: "received",
    },
    "resolution=ignore-duplicates,return=representation",
  );
  if (!claimed.length) return { claimed: false, reason: "duplicate_message" };
  return { claimed: true, rowId: String(claimed[0].id) };
}

export type ImportResult =
  | { outcome: "imported"; expenseId: string | null; category: string }
  | { outcome: "duplicate"; reason: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "unparsed"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * Everything after the claim. Total: every path marks the ledger row and
 * returns a result rather than throwing, so one malformed message can never
 * stop the messages after it.
 */
export async function importClaimedMessage(db: Db, params: {
  rowId: string;
  connectionId: string;
  userId: string;
  message: InboundMessage;
  now: Date;
}): Promise<ImportResult> {
  const { rowId, connectionId, userId, message, now } = params;

  try {
    // ---- sender authenticity ----
    // Knowing an alias, or having a mailbox filter that matched loosely, must
    // not be enough: the message has to actually come from Wise.
    if (!wiseEmailParser.recognises(message)) {
      await markMessage(db, rowId, { status: "skipped", skip_reason: "sender_not_recognised" });
      return { outcome: "skipped", reason: "sender_not_recognised" };
    }

    // ---- retain a sanitised copy for 7 days, for parser diagnosis ----
    // Written before parsing, so a message that fails at ANY later step is
    // still diagnosable. Cleared again on a successful import below.
    const retained = sanitizeForRetention(message.text, message.html);
    if (retained.text || retained.html) {
      await markMessage(db, rowId, {
        raw_text: retained.text,
        raw_html: retained.html,
        raw_content_expires_at: retentionExpiry(now),
      });
    }

    // ---- dedupe layer 2: RFC 5322 Message-ID ----
    // Catches the same mail arriving through two different pipes, which is
    // exactly what happens if Resend forwarding and Gmail polling overlap.
    if (message.rfcMessageId) {
      const dup = await db.select(
        `email_import_messages?connection_id=eq.${q(connectionId)}` +
          `&rfc_message_id=eq.${q(message.rfcMessageId)}&select=id&limit=1`,
      );
      if (dup.length) {
        await markMessage(db, rowId, { status: "duplicate", skip_reason: "rfc_message_id" });
        return { outcome: "duplicate", reason: "rfc_message_id" };
      }
      await markMessage(db, rowId, { rfc_message_id: message.rfcMessageId });
    }

    // ---- parse ----
    const parsed = wiseEmailParser.parse(message);
    if (!parsed.ok) {
      await markMessage(db, rowId, {
        status: parsed.reason === "not_a_transaction" ? "skipped" : "unparsed",
        skip_reason: parsed.detail,
      });
      return parsed.reason === "not_a_transaction"
        ? { outcome: "skipped", reason: parsed.detail }
        : { outcome: "unparsed", reason: parsed.detail };
    }
    const tx: NormalizedTransaction = parsed.transaction;

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
        await markMessage(db, rowId, { status: "duplicate", skip_reason: column });
        return { outcome: "duplicate", reason: column };
      }
    }

    await markMessage(db, rowId, {
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
      await markMessage(db, rowId, { status: "skipped", skip_reason: classification.reason });
      return { outcome: "skipped", reason: classification.reason };
    }

    // ---- household, payer and rates come from the database, never the mail --
    const ctx = await resolveImportContext(db, userId, now);
    if (isContextFailure(ctx)) {
      await markMessage(db, rowId, { status: "skipped", skip_reason: ctx.error });
      return { outcome: "skipped", reason: ctx.error };
    }

    const result = await createExpense(db, ctx, tx, {
      sourceProvider: "wise",
      conversionSource: wiseEmailParser.provider,
    });
    if (result.status === "failed") {
      await markMessage(db, rowId, { status: "failed", error_summary: result.reason });
      return { outcome: "failed", reason: result.reason };
    }

    await markMessage(db, rowId, {
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

    return { outcome: "imported", expenseId: result.expenseId, category: result.category };
  } catch (e) {
    // One malformed message must never take down the run around it.
    const reason = safeError(e);
    await markMessage(db, rowId, { status: "failed", error_summary: reason });
    return { outcome: "failed", reason };
  }
}
