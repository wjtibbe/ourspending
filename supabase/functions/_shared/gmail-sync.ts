// The Gmail polling core, shared verbatim by the daily cron and "Sync now".
//
// Those two differ ONLY in who is allowed to call them and which connections
// they pass in. Everything else -- token refresh, the restrictive query,
// pagination, MIME adaptation, dedupe, parsing, expense creation -- happens
// here, so a manual sync can never behave differently from the scheduled one.
//
// Two isolation guarantees are load-bearing, and both are enforced by
// structure rather than by care:
//
//   * one failing CONNECTION must not stop the others -- so every connection
//     runs inside its own try/catch and records its own last_error;
//   * one malformed MESSAGE must not stop the ones after it -- so every
//     message does too, and importClaimedMessage is itself total.
//
// Without those, a single revoked token or one unreadable email would stop
// every other household from importing anything.

import type { Db, Row } from "./import-core.ts";
import { q, safeError } from "./import-core.ts";
import { claimMessage, importClaimedMessage, markMessage } from "./email-import-core.ts";
import { gmailToInboundMessage, type GmailMessage } from "./gmail-message.ts";
import {
  buildWiseQuery, getMessage, GmailError, listMessageIds, needsReconnect,
  refreshAccessToken, type FetchLike,
} from "./gmail.ts";
import { addressOf } from "./inbound-types.ts";
import type { AiClassifier } from "./merchant-categorization.ts";

/** The decrypted credential document. Never logged, never returned. */
export type StoredCredential = {
  refresh_token: string;
  access_token?: string | null;
  expires_at?: string | null;
};

export type GmailConnectionRow = {
  id: string;
  user_id: string;
  enabled?: boolean;
  account_email?: string | null;
};

export interface GmailSyncDeps {
  db: Db;
  now(): Date;
  fetchImpl: FetchLike;
  clientId: string;
  clientSecret: string;
  /** Injected so tests never need the real PROVIDER_ENCRYPTION_KEY. */
  encrypt(plaintext: string): Promise<{ ciphertext: string; iv: string }>;
  decrypt(ciphertext: string, iv: string): Promise<string>;
  lookbackDays?: number;
  label?: string | null;
  /** Bounded so one runaway mailbox cannot consume the whole invocation. */
  maxPages?: number;
  pageSize?: number;
  /** Layer 4 of categorizeTransaction(). Omitted/null = AI fallback disabled. */
  aiClassifier?: AiClassifier | null;
}

export type SyncStats = {
  connectionsProcessed: number;
  connectionsFailed: number;
  messagesSeen: number;
  expensesImported: number;
  duplicatesSkipped: number;
  unparsed: number;
  skipped: number;
  failed: number;
};

const emptyStats = (): SyncStats => ({
  connectionsProcessed: 0,
  connectionsFailed: 0,
  messagesSeen: 0,
  expensesImported: 0,
  duplicatesSkipped: 0,
  unparsed: 0,
  skipped: 0,
  failed: 0,
});

/** Refresh a minute early, so a token cannot expire mid-run. */
const EXPIRY_SKEW_MS = 60_000;

async function patchConnection(db: Db, id: string, patch: Row): Promise<void> {
  await db.patch(`email_import_connections?id=eq.${q(id)}`, patch, "return=minimal")
    .catch(() => {});
}

/**
 * Returns a usable access token, refreshing and re-encrypting if needed.
 *
 * A refresh that returns a NEW refresh token rotates the stored one; a
 * refresh that omits it (the common case) keeps the existing one. Getting
 * that backwards would either lose the credential or ignore a rotation.
 */
async function accessTokenFor(
  deps: GmailSyncDeps,
  conn: GmailConnectionRow,
  cred: StoredCredential,
): Promise<string> {
  const expiresAt = cred.expires_at ? Date.parse(cred.expires_at) : 0;
  const stillValid = cred.access_token &&
    Number.isFinite(expiresAt) &&
    expiresAt - EXPIRY_SKEW_MS > deps.now().getTime();
  if (stillValid) return String(cred.access_token);

  const refreshed = await refreshAccessToken({
    refreshToken: cred.refresh_token,
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
  }, deps.fetchImpl);

  const next: StoredCredential = {
    refresh_token: refreshed.refreshToken ?? cred.refresh_token,
    access_token: refreshed.accessToken,
    expires_at: refreshed.expiresAt,
  };
  const enc = await deps.encrypt(JSON.stringify(next));
  await deps.db.patch(
    `email_import_credentials?connection_id=eq.${q(conn.id)}`,
    { ciphertext: enc.ciphertext, iv: enc.iv, key_version: 1 },
    "return=minimal",
  ).catch(() => {});
  await patchConnection(deps.db, conn.id, { access_expires_at: refreshed.expiresAt });

  return refreshed.accessToken;
}

/**
 * Records a message failure that happened BEFORE (or instead of) a normal
 * claim -- a Gmail fetch error, an unreadable MIME payload, or the claim
 * insert itself failing. Two things, both best-effort and both safe:
 *
 *   1. A log line naming the STAGE and a sanitised error code -- Gmail's own
 *      message id and the connection id are opaque platform identifiers, not
 *      content, so they are safe to log; the subject, body, merchant, amount
 *      and any token never are and never appear here.
 *   2. An attempt to claim (or re-use an already-claimed) ledger row and
 *      mark it failed, so the failure has a durable trace instead of only
 *      ever existing as an aggregate counter. This reuses claimMessage()
 *      itself, so it is exactly as duplicate-safe as the normal path: if a
 *      row already exists for this id, this is a no-op.
 *
 * Deliberately swallows its own errors: a ledger that is itself unreachable
 * must not turn a per-message failure into a second, unhandled exception.
 */
async function recordPreClaimFailure(
  deps: GmailSyncDeps,
  conn: GmailConnectionRow,
  gmailId: string,
  stage: string,
  reason: string,
): Promise<void> {
  console.error(
    `gmail-sync: message failed stage=${stage} connection=${conn.id} gmail_id=${gmailId} reason=${reason}`,
  );
  try {
    const claim = await claimMessage(deps.db, {
      connectionId: conn.id,
      userId: conn.user_id,
      source: "gmail",
      providerMessageId: gmailId,
      fromAddress: null,
      receivedAt: deps.now().toISOString(),
    });
    if (claim.claimed) {
      await markMessage(deps.db, claim.rowId, { status: "failed", error_summary: reason });
    }
  } catch {
    // The ledger itself is unavailable. The log line above is the only
    // remaining diagnostic, and it must not be masked by a second exception
    // escaping this best-effort path.
  }
}

/** Collects matching message ids across pages, bounded. */
async function collectIds(
  deps: GmailSyncDeps,
  accessToken: string,
  query: string,
): Promise<string[]> {
  const maxPages = deps.maxPages ?? 5;
  const ids: string[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const res = await listMessageIds({
      accessToken,
      query,
      pageToken,
      maxResults: deps.pageSize ?? 50,
    }, deps.fetchImpl);
    ids.push(...res.ids);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return ids;
}

/**
 * Syncs ONE connection. Throws only for connection-level failures (a dead
 * token, Gmail unreachable); per-message problems are absorbed and counted.
 */
export async function syncOneConnection(
  deps: GmailSyncDeps,
  conn: GmailConnectionRow,
  stats: SyncStats,
): Promise<void> {
  const creds = await deps.db.select(
    `email_import_credentials?connection_id=eq.${q(conn.id)}&select=ciphertext,iv&limit=1`,
  );
  if (!creds.length) throw new GmailError("reconnect_required", "no stored credential");

  let cred: StoredCredential;
  try {
    cred = JSON.parse(await deps.decrypt(String(creds[0].ciphertext), String(creds[0].iv)));
  } catch {
    // A credential we cannot read is functionally a missing one. Deliberately
    // not logged: the failure itself is the only safe thing to say about it.
    throw new GmailError("reconnect_required", "stored credential unreadable");
  }
  if (!cred?.refresh_token) throw new GmailError("reconnect_required", "no refresh token");

  const accessToken = await accessTokenFor(deps, conn, cred);

  const query = buildWiseQuery({
    lookbackDays: deps.lookbackDays,
    label: deps.label ?? null,
  });
  const ids = await collectIds(deps, accessToken, query);

  for (const id of ids) {
    stats.messagesSeen++;
    // Tracked so a failure caught below can log exactly where it happened --
    // "message failed" alone, with no stage, is what hid the ledger-claim
    // bug: every one of 14 messages failed the same way and there was no way
    // to tell claim-insert-rejected apart from Gmail-fetch-failed apart from
    // unreadable-MIME without this.
    let stage = "gmail_fetch";
    try {
      const raw = await getMessage({ accessToken, id }, deps.fetchImpl) as GmailMessage;

      stage = "mime_adapt";
      const message = gmailToInboundMessage(raw);
      if (!message) {
        await recordPreClaimFailure(deps, conn, id, stage, "no_usable_id");
        stats.failed++;
        continue;
      }

      stage = "ledger_claim";
      const claim = await claimMessage(deps.db, {
        connectionId: conn.id,
        userId: conn.user_id,
        source: "gmail",
        // Gmail's own id is dedupe key #1: stable, and the same across every
        // overlapping lookback window.
        providerMessageId: message.providerMessageId,
        fromAddress: addressOf(message.from),
        receivedAt: message.receivedAt,
      });
      if (!claim.claimed) { stats.duplicatesSkipped++; continue; }

      stage = "import";
      const result = await importClaimedMessage(deps.db, {
        rowId: claim.rowId,
        connectionId: conn.id,
        userId: conn.user_id,
        message,
        now: deps.now(),
        aiClassifier: deps.aiClassifier ?? null,
      });

      if (result.outcome === "imported") stats.expensesImported++;
      else if (result.outcome === "duplicate") stats.duplicatesSkipped++;
      else if (result.outcome === "unparsed") stats.unparsed++;
      else if (result.outcome === "skipped") stats.skipped++;
      else stats.failed++;
    } catch (e) {
      // A dead token mid-run is a CONNECTION problem, not a message problem:
      // every remaining message would fail the same way, so stop this
      // connection and let the others carry on.
      if (needsReconnect(e)) throw e;
      await recordPreClaimFailure(deps, conn, id, stage, safeError(e));
      stats.failed++;
    }
  }

  await patchConnection(deps.db, conn.id, {
    last_checked_at: deps.now().toISOString(),
    last_synced_at: deps.now().toISOString(),
    status: "active",
    last_error: null,
  });
}

/**
 * Syncs every supplied connection, isolating failures.
 *
 * `connections` is passed in rather than queried here so the cron (all
 * enabled connections) and "Sync now" (exactly one, the caller's own) share
 * this function without it needing to know which case it is in.
 */
export async function syncGmailConnections(
  deps: GmailSyncDeps,
  connections: GmailConnectionRow[],
): Promise<SyncStats> {
  const stats = emptyStats();

  for (const conn of connections) {
    try {
      await syncOneConnection(deps, conn, stats);
      stats.connectionsProcessed++;
    } catch (e) {
      stats.connectionsFailed++;
      const code = e instanceof GmailError ? e.code : safeError(e);
      await patchConnection(deps.db, conn.id, {
        last_checked_at: deps.now().toISOString(),
        status: "error",
        last_error: code,
      });
      // A connection id and a sanitised code -- never the mailbox address,
      // an email body, or the raw exception text.
      console.error(`gmail-sync: connection failed connection=${conn.id} reason=${code}`);
    }
  }

  return stats;
}

/** Every enabled Gmail connection. Used by the scheduled run. */
export async function enabledGmailConnections(db: Db): Promise<GmailConnectionRow[]> {
  const rows = await db.select(
    "email_import_connections?provider=eq.gmail&enabled=is.true" +
      "&select=id,user_id,enabled,account_email",
  );
  return rows.map((r) => ({
    id: String(r.id),
    user_id: String(r.user_id),
    enabled: r.enabled !== false,
    account_email: r.account_email ? String(r.account_email) : null,
  }));
}
