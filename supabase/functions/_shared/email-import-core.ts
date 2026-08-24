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
import { categorizeTransaction, type AiClassifier } from "./merchant-categorization.ts";

/** Records an outcome on an already-claimed ledger row. Never throws. */
export async function markMessage(db: Db, rowId: string, patch: Row): Promise<void> {
  await db.patch(`email_import_messages?id=eq.${q(rowId)}`, patch, "return=minimal")
    .catch(() => {});
}

export type ClaimResult =
  | { claimed: true; rowId: string; retryOf: null }
  /** An existing ledger row that never reached a terminal success -- re-run it. */
  | { claimed: true; rowId: string; retryOf: string }
  | { claimed: false; reason: "already_imported" | "terminal_skip" };

/**
 * Which existing-row states mean "this message still deserves another attempt".
 *
 * Deliberately an allowlist, not a denylist: an unrecognised or future status
 * is treated as terminal, so a new state can never silently start causing
 * re-imports of transactions that were already handled.
 *
 *   received  the row was claimed but the run died before finishing -- a
 *             timeout, a crash, a dead token mid-batch. Nothing was imported.
 *   failed    an error before or during expense creation.
 *   unparsed  the parser did not recognise the template AT THE TIME. Parser
 *             support is added over time, so this must not be a life sentence.
 */
const RETRYABLE_STATUSES = new Set(["received", "failed", "unparsed"]);

/**
 * `skipped` is the one status that means two very different things, so it is
 * decided by reason rather than by status alone.
 *
 * Everything else that produces `skipped` is a deliberate business rule --
 * incoming money, a declined/reversed transaction, an unsupported currency, a
 * non-positive amount, an unrecognised sender, an email that is not a
 * transaction at all. Re-importing those would be wrong, so `skipped` defaults
 * to terminal and only these two transient configuration problems reopen it.
 */
const RETRYABLE_SKIP_REASONS = new Set(["no_household", "unresolved_slot"]);

/**
 * Bumps the retry counters on a ledger row. Entirely best-effort and fully
 * isolated: every failure is swallowed, so a project whose schema predates
 * these columns still retries normally. Nothing branches on what this writes.
 */
async function recordRetryAttempt(db: Db, rowId: string): Promise<void> {
  try {
    const rows = await db.select(
      `email_import_messages?id=eq.${q(rowId)}&select=attempt_count&limit=1`,
    );
    const attempts = Number(rows[0]?.attempt_count ?? 0);
    await markMessage(db, rowId, {
      attempt_count: Number.isFinite(attempts) ? attempts + 1 : 1,
      last_attempt_at: new Date().toISOString(),
    });
  } catch {
    // The columns do not exist yet, or the ledger is briefly unreachable.
    // Neither is a reason to fail or skip a retry.
  }
}

/** Classifies an existing ledger row. Exported for tests and diagnostics. */
export function isRetryableLedgerRow(row: Row): boolean {
  const status = String(row.status ?? "");
  if (RETRYABLE_STATUSES.has(status)) return true;
  if (status === "skipped") {
    return RETRYABLE_SKIP_REASONS.has(String(row.skip_reason ?? ""));
  }
  // "imported" is terminal even when expense_id is null: expense_id is only
  // null when the INSERT succeeded but returned no representation, so the
  // expense exists either way. It is also null after someone deliberately
  // deletes an expense (the FK is `on delete set null`), and re-importing
  // would resurrect what they removed. "duplicate" is terminal because layers
  // 2-4 already matched this transaction to one that was imported.
  return false;
}

/**
 * Dedupe layer 1: the delivering system's own message id.
 *
 * Claimed before any other work, so a webhook retry or an overlapping poll
 * window cannot double-import even while the first attempt is still running.
 * `resolution=ignore-duplicates` turns the unique-index collision into an
 * empty result rather than an error.
 *
 * The collision is NOT automatically a duplicate. A row existing only proves
 * that this message was SEEN before, not that it was successfully imported --
 * and a row can be left behind at `received`, `failed` or `unparsed` by a run
 * that never created an expense. Treating those as duplicates is what makes a
 * message permanently un-importable, so the existing row's own state decides.
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
  if (claimed.length) return { claimed: true, rowId: String(claimed[0].id), retryOf: null };

  // A row already exists. Read its state before deciding.
  let existing: Row | undefined;
  try {
    const rows = await db.select(
      `email_import_messages?connection_id=eq.${q(params.connectionId)}` +
        `&provider_message_id=eq.${q(params.providerMessageId)}` +
        // Only columns that have existed since the ledger was created. The
        // retry-diagnostic columns are deliberately NOT selected here: an
        // unknown column makes PostgREST reject the whole request, and this
        // request failing would skip the message -- reintroducing the exact
        // bug being fixed. They are written separately, best-effort, below.
        "&select=id,status,skip_reason,expense_id&limit=1",
    );
    existing = rows[0];
  } catch {
    // The lookup failed, so the row's state is unknown. Skipping is the safe
    // choice: a retry we skip is recovered by the next sync, but a retry we
    // wrongly allow could double-import.
    return { claimed: false, reason: "already_imported" };
  }
  if (!existing?.id) return { claimed: false, reason: "already_imported" };

  const rowId = String(existing.id);
  if (!isRetryableLedgerRow(existing)) {
    return {
      claimed: false,
      reason: String(existing.status) === "skipped" ? "terminal_skip" : "already_imported",
    };
  }

  // Reclaim it. Resetting to `received` and clearing the stale outcome fields
  // puts the row back at the start of the same state machine, so the retry is
  // indistinguishable from a first attempt and cannot inherit a previous
  // error_summary or skip_reason.
  const previousStatus = String(existing.status ?? "");
  await markMessage(db, rowId, {
    status: "received",
    skip_reason: null,
    error_summary: null,
  });

  // Retry diagnostics, kept off the critical path on purpose: this is a
  // separate best-effort write of columns added by a later migration, and
  // markMessage swallows its own errors. A project that has not applied that
  // migration yet still retries correctly -- it just records no counter.
  await recordRetryAttempt(db, rowId);

  return { claimed: true, rowId, retryOf: previousStatus };
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
  /** Layer 4 of categorizeTransaction(). Omitted = AI fallback disabled. */
  aiClassifier?: AiClassifier | null;
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
          `&rfc_message_id=eq.${q(message.rfcMessageId)}` +
          // Exclude THIS row. On a first attempt the row has no
          // rfc_message_id yet, so this changes nothing -- but a RETRY runs
          // against a row the previous attempt already stamped, and without
          // this the row matches itself and is marked a duplicate of itself.
          // That turned every retryable row terminal on its first retry,
          // which is the opposite of what the retry path exists to do.
          `&id=neq.${q(rowId)}&select=id&limit=1`,
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
          `&${column}=eq.${q(value)}` +
          // Same self-exclusion as layer 2: a retry re-derives the same
          // external_ref and fingerprint its previous attempt already stored
          // on this very row, and would otherwise dedupe against itself.
          `&id=neq.${q(rowId)}&select=id&limit=1`,
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

    // ---- layered categorisation: household rule -> global/keyword -> AI -> fallback ----
    // Resolved BEFORE createExpense() so the decision (and which layer made
    // it) is known up front, rather than re-deriving "was this a fallback"
    // from the expense afterwards.
    const categorization = await categorizeTransaction(db, {
      householdId: ctx.householdId,
      merchant: tx.merchant,
      subject: typeof tx.sourceMetadata?.subject === "string" ? tx.sourceMetadata.subject : null,
      categoryInput: tx.categoryInput,
      allowed: ctx.allowed,
      aiClassifier: params.aiClassifier ?? null,
    });

    const result = await createExpense(db, ctx, tx, {
      sourceProvider: "wise",
      conversionSource: wiseEmailParser.provider,
    }, {
      category: categorization.category,
      source: categorization.provenance,
      matched: categorization.matched,
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
      // household_rule | global_rule | keyword | ai | fallback -- see
      // _shared/merchant-categorization.ts. Never email content, an amount
      // or a token; category_match (below) carries the normalized merchant
      // or keyword only, when there is one to show.
      category_source: categorization.provenance,
      category_match: categorization.matched,
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
