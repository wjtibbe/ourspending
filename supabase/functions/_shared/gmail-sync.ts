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
  buildWiseQuery, getMessage, getMessageInternalDate, getProfileEmail, GmailError,
  listMessageIds, needsReconnect, refreshAccessToken, type FetchLike,
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
  /** Sender terms for discovery. Omitted = the Wise domains isWiseSender trusts. */
  senders?: string[] | string | null;
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
  // ---- diagnostics ----
  // Counters only. Nothing here derives from a subject, body, merchant,
  // amount or token, so the whole object stays safe to log and to return.
  //
  // duplicatesSkipped answers "how many were skipped", which on its own
  // cannot distinguish a healthy no-op from every message being permanently
  // stuck. These three split it:
  /** Skipped because a previous run genuinely imported them. */
  duplicatesAlreadyImported: number;
  /** Skipped because a previous run deliberately and terminally skipped them. */
  terminalSkipped: number;
  /** Existing ledger rows that had NOT succeeded, and were re-run this time. */
  retriedRows: number;
  /**
   * Deduped AFTER a successful claim, by layers 2-4 (RFC Message-ID, external
   * reference, fingerprint) matching a DIFFERENT ledger row.
   *
   * Split out because it used to vanish into duplicatesSkipped. A retried row
   * that ended here looked identical to a message that was never claimed at
   * all, which made `retriedRows: 31` with every other bucket at zero
   * unreadable -- 31 rows were re-run and 31 outcomes went unreported.
   */
  dedupedAfterClaim: number;
  /**
   * messagesSeen minus every terminal bucket below. MUST be 0: each message
   * that reaches processing ends in exactly one of imported /
   * duplicatesAlreadyImported / terminalSkipped / dedupedAfterClaim /
   * unparsed / skipped / failed. Anything else means an outcome escaped
   * unreported, which is the failure mode this counter exists to make loud.
   */
  unaccountedFor: number;

  // ---- discovery diagnostics ----
  // "Gmail returned nothing new" and "Gmail returned it and we rejected it"
  // look identical from expensesImported alone. These separate them.
  //
  // The query is safe to return: it contains sender DOMAINS and a day count,
  // never a mailbox address, and never a subject, merchant or amount. The
  // optional label is the user's own configured value.
  /** The exact Gmail search string used, so discovery is never a black box. */
  queryUsed: string | null;
  /** Message ids Gmail returned for that query, before any of our own checks. */
  gmailMessagesListed: number;
  /** Listed, then rejected because the From header was not a Wise sender. */
  rejectedSender: number;
  /** Listed and from Wise, then rejected because no template matched. */
  rejectedTemplate: number;
  /** Gmail list calls actually made. 1 means everything fitted on one page. */
  gmailPagesFetched: number;
  /**
   * Gmail's own rough total for the query. If this equals gmailMessagesListed,
   * nothing was lost to paging and Gmail genuinely has no other match -- which
   * points at the QUERY, not at discovery. If it is larger, messages were left
   * unfetched.
   */
  gmailResultSizeEstimate: number | null;
  /**
   * True when Gmail still had a nextPageToken after the last page we fetched,
   * i.e. the page cap truncated the results. Must be false on a healthy run.
   */
  gmailMoreAvailable: boolean;
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
  duplicatesAlreadyImported: 0,
  terminalSkipped: 0,
  retriedRows: 0,
  queryUsed: null,
  gmailMessagesListed: 0,
  rejectedSender: 0,
  rejectedTemplate: 0,
  gmailPagesFetched: 0,
  gmailResultSizeEstimate: null,
  gmailMoreAvailable: false,
  dedupedAfterClaim: 0,
  unaccountedFor: 0,
});

/**
 * Recomputes the accounting invariant. Called once per run, after every
 * message has been processed.
 */
export function reconcileStats(stats: SyncStats): SyncStats {
  const accounted = stats.expensesImported +
    stats.duplicatesAlreadyImported +
    stats.terminalSkipped +
    stats.dedupedAfterClaim +
    stats.unparsed +
    stats.skipped +
    stats.failed;
  stats.unaccountedFor = stats.messagesSeen - accounted;
  return stats;
}

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
export type DiscoveryResult = {
  ids: string[];
  /** How many Gmail list calls were actually made. */
  pagesFetched: number;
  /** Gmail's own rough total for the query, from the first page. */
  resultSizeEstimate: number | null;
  /**
   * True when Gmail still offered a nextPageToken after the LAST page we were
   * willing to fetch -- i.e. the page cap truncated the result set.
   */
  moreAvailable: boolean;
};

/**
 * Walks Gmail's paged message list until there is no nextPageToken left, or
 * until the page cap is reached.
 *
 * The cap exists so one runaway mailbox cannot consume the whole invocation,
 * but hitting it used to be INVISIBLE: the loop simply stopped and discarded a
 * live nextPageToken, so a truncated run and a complete one produced
 * identical-looking output. `moreAvailable` makes that state reportable, and
 * the default budget (10 x 100 = 1000 messages) is far above any realistic
 * 8-day Wise volume, so reaching it now means something is genuinely wrong
 * rather than merely large.
 */
async function collectIds(
  deps: GmailSyncDeps,
  accessToken: string,
  query: string,
): Promise<DiscoveryResult> {
  const maxPages = deps.maxPages ?? 10;
  const ids: string[] = [];
  let pageToken: string | null = null;
  let pagesFetched = 0;
  let resultSizeEstimate: number | null = null;
  let moreAvailable = false;

  for (let page = 0; page < maxPages; page++) {
    const res = await listMessageIds({
      accessToken,
      query,
      pageToken,
      // Gmail's own default. 50 doubled the number of round trips for no
      // benefit; the API accepts up to 500.
      maxResults: deps.pageSize ?? 100,
    }, deps.fetchImpl);
    pagesFetched++;
    // From the first page only: later pages report the same total, and taking
    // the first keeps it stable regardless of how far paging got.
    if (resultSizeEstimate === null) resultSizeEstimate = res.resultSizeEstimate;
    ids.push(...res.ids);

    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
    // Gmail has more and this was our last allowed page: record it rather
    // than silently dropping the rest.
    if (page === maxPages - 1) moreAvailable = true;
  }

  return { ids, pagesFetched, resultSizeEstimate, moreAvailable };
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
    senders: deps.senders ?? null,
  });
  // Recorded before anything is fetched, so even a run that imports nothing
  // shows exactly what was asked of Gmail and how much came back.
  stats.queryUsed = query;
  const discovery = await collectIds(deps, accessToken, query);
  const ids = discovery.ids;
  stats.gmailMessagesListed += ids.length;
  stats.gmailPagesFetched += discovery.pagesFetched;
  stats.gmailMoreAvailable = stats.gmailMoreAvailable || discovery.moreAvailable;
  if (discovery.resultSizeEstimate !== null) {
    stats.gmailResultSizeEstimate =
      (stats.gmailResultSizeEstimate ?? 0) + discovery.resultSizeEstimate;
  }
  if (discovery.moreAvailable) {
    // Loud, because it means transactions are being left undiscovered.
    console.error(
      `gmail-sync: TRUNCATED discovery connection=${conn.id} ` +
        `pages=${discovery.pagesFetched} listed=${ids.length} -- Gmail had more`,
    );
  }

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
      if (!claim.claimed) {
        // Still counted in duplicatesSkipped so the existing shape of this
        // response does not change, but now also split by WHY, so a run
        // where nothing imports can be told apart from a healthy no-op.
        stats.duplicatesSkipped++;
        if (claim.reason === "terminal_skip") stats.terminalSkipped++;
        else stats.duplicatesAlreadyImported++;
        continue;
      }
      // An existing row that had not succeeded, now being re-run.
      if (claim.retryOf !== null) stats.retriedRows++;

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
      else if (result.outcome === "duplicate") {
        // Still counted in duplicatesSkipped so the response keeps its shape,
        // but no longer ONLY there: this is a post-claim dedupe against a
        // different row, not a message that was never claimed.
        stats.duplicatesSkipped++;
        stats.dedupedAfterClaim++;
      }
      else if (result.outcome === "unparsed") {
        stats.unparsed++;
        // Reached the parser and matched no template.
        stats.rejectedTemplate++;
      } else if (result.outcome === "skipped") {
        stats.skipped++;
        // Split the two very different reasons a listed message is skipped:
        // the From header was not Wise at all, versus it was Wise but the mail
        // is not a card payment (a statement, a marketing send).
        if (result.reason === "sender_not_recognised") stats.rejectedSender++;
        else if (result.reason === "not_a_transaction") stats.rejectedTemplate++;
      } else stats.failed++;
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

// ---------------------------------------------------------------------------
// Discovery diagnostic
// ---------------------------------------------------------------------------

/**
 * The fixed probe query. Deliberately hard-coded and NOT derived from
 * buildWiseQuery(): the whole point is to ask Gmail the narrowest, most
 * literal question possible -- "do you have anything at all from this exact
 * address in the last two days?" -- so that the answer cannot be blamed on
 * the production query's own sender list or lookback.
 */
export const DIAGNOSTIC_QUERY = "from:noreply@wise.com newer_than:2d";

/** How many ids to read an internalDate for. Bounded; this is a probe. */
const DIAGNOSTIC_DATE_SAMPLE = 25;

export type DiscoveryDiagnostic = {
  connectionId: string;
  /** The mailbox Gmail says this token belongs to, from users.getProfile. */
  profileEmailAddress: string | null;
  /** Whether the stored account_email still matches that mailbox. */
  accountMatchesProfile: boolean | null;
  queryUsed: string;
  gmailResultSizeEstimate: number | null;
  gmailMessagesListed: number;
  gmailPagesFetched: number;
  gmailMoreAvailable: boolean;
  /** ISO timestamp of the most recent match, or null if there were none. */
  newestMatchingInternalDate: string | null;
  /** ISO timestamp of the oldest match, or null if there were none. */
  oldestMatchingInternalDate: string | null;
  /** Populated instead of the above if the probe itself failed. */
  error: string | null;
};

/**
 * Read-only probe of the Gmail discovery layer for ONE connection.
 *
 * Touches nothing: no ledger row is claimed or written, no expense is created,
 * no credential is rotated beyond the ordinary access-token refresh the API
 * requires. Returns counts, dates and the connected mailbox address only --
 * never a subject, body, merchant, amount, message id or token.
 *
 * It exists to separate two indistinguishable outcomes. If Gmail reports
 * matches this process never listed, discovery is broken. If Gmail reports
 * none at all, then for this token the messages are not there to be found, and
 * the next question is which mailbox the token actually belongs to -- which is
 * what profileEmailAddress and accountMatchesProfile answer.
 */
export async function diagnoseDiscovery(
  deps: GmailSyncDeps,
  conn: GmailConnectionRow,
): Promise<DiscoveryDiagnostic> {
  const base: DiscoveryDiagnostic = {
    connectionId: conn.id,
    profileEmailAddress: null,
    accountMatchesProfile: null,
    queryUsed: DIAGNOSTIC_QUERY,
    gmailResultSizeEstimate: null,
    gmailMessagesListed: 0,
    gmailPagesFetched: 0,
    gmailMoreAvailable: false,
    newestMatchingInternalDate: null,
    oldestMatchingInternalDate: null,
    error: null,
  };

  try {
    const creds = await deps.db.select(
      `email_import_credentials?connection_id=eq.${q(conn.id)}&select=ciphertext,iv&limit=1`,
    );
    if (!creds.length) return { ...base, error: "no_credential" };
    const cred: StoredCredential = JSON.parse(
      await deps.decrypt(String(creds[0].ciphertext), String(creds[0].iv)),
    );
    const accessToken = await accessTokenFor(deps, conn, cred);

    // Which mailbox does this token actually belong to?
    const profileEmailAddress = await getProfileEmail(accessToken, deps.fetchImpl);
    const stored = (conn.account_email ?? "").trim().toLowerCase();
    const live = (profileEmailAddress ?? "").trim().toLowerCase();
    const accountMatchesProfile = stored && live ? stored === live : null;

    const discovery = await collectIds(deps, accessToken, DIAGNOSTIC_QUERY);

    // Bounded sample, newest-first as Gmail returns them, read with
    // format=minimal so no header or body is ever fetched.
    let newest: number | null = null;
    let oldest: number | null = null;
    for (const id of discovery.ids.slice(0, DIAGNOSTIC_DATE_SAMPLE)) {
      const ms = await getMessageInternalDate({ accessToken, id }, deps.fetchImpl)
        .catch(() => null);
      if (ms === null) continue;
      if (newest === null || ms > newest) newest = ms;
      if (oldest === null || ms < oldest) oldest = ms;
    }

    return {
      ...base,
      profileEmailAddress,
      accountMatchesProfile,
      gmailResultSizeEstimate: discovery.resultSizeEstimate,
      gmailMessagesListed: discovery.ids.length,
      gmailPagesFetched: discovery.pagesFetched,
      gmailMoreAvailable: discovery.moreAvailable,
      newestMatchingInternalDate: newest === null ? null : new Date(newest).toISOString(),
      oldestMatchingInternalDate: oldest === null ? null : new Date(oldest).toISOString(),
    };
  } catch (e) {
    // A sanitised code, never a raw Gmail body.
    return { ...base, error: needsReconnect(e) ? "reconnect_required" : safeError(e) };
  }
}

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

  reconcileStats(stats);
  if (stats.unaccountedFor !== 0) {
    // Loud: some message reached processing and its outcome was never
    // recorded in any bucket. That is a reporting bug, and the whole point of
    // the invariant is that it cannot pass unnoticed.
    console.error(
      `gmail-sync: ACCOUNTING MISMATCH seen=${stats.messagesSeen} ` +
        `unaccounted=${stats.unaccountedFor}`,
    );
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
