// The runtime wiring shared by both sync entry points.
//
// Keeping this in one place is what makes "Sync now" and the hourly cron job
// genuinely the same implementation: they differ only in who is allowed to
// call them and which connections they pass in.

import { decryptToken } from "./crypto.ts";
import { db } from "./rest.ts";
import { createWiseClient, WISE_API_BASE_DEFAULT } from "./wise.ts";
import type { ConnectionRow, SyncDeps } from "./sync.ts";

// Sandbox override for testing: https://api.sandbox.transferwise.tech
const WISE_API_BASE = Deno.env.get("WISE_API_BASE") ?? WISE_API_BASE_DEFAULT;

const configuredLookback = parseInt(Deno.env.get("WISE_SYNC_DAYS") ?? "", 10);

/** Decrypts one connection's token and returns a client bound to it. */
export async function clientFor(conn: ConnectionRow) {
  const creds = await db.select(
    `provider_credentials?connection_id=eq.${encodeURIComponent(conn.id)}` +
      `&select=ciphertext,iv&limit=1`,
  );
  if (!creds.length) throw new Error("no_credentials");
  const token = await decryptToken(String(creds[0].ciphertext), String(creds[0].iv));
  // The token exists only inside this closure, for the life of the request.
  return createWiseClient(token, WISE_API_BASE);
}

export const syncDeps: SyncDeps = {
  db,
  clientFor,
  now: () => new Date(),
  lookbackDays: Number.isFinite(configuredLookback) && configuredLookback > 0
    ? configuredLookback
    : undefined,
};

/** The counters returned to a caller. No transaction detail, no token. */
export const publicStats = (s: {
  connectionsProcessed: number; transactionsFetched: number;
  expensesImported: number; duplicatesSkipped: number;
  unsupportedSkipped: number; failed: number; missingStableId: number;
  categoryFallbacks: number;
}) => ({
  connectionsProcessed: s.connectionsProcessed,
  transactionsFetched: s.transactionsFetched,
  expensesImported: s.expensesImported,
  duplicatesSkipped: s.duplicatesSkipped,
  unsupportedSkipped: s.unsupportedSkipped,
  failed: s.failed,
  missingStableId: s.missingStableId,
  categoryFallbacks: s.categoryFallbacks,
});
