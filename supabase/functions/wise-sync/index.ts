// Supabase Edge Function: the hourly Wise import.
//
// Deploy with "Verify JWT" OFF — pg_cron calls this from inside Postgres and
// cannot mint a user JWT. Authentication is instead a shared secret in the
// x-sync-secret header, compared in constant time. Without a valid secret this
// function does nothing and says nothing useful.
//
//   supabase functions deploy wise-sync --no-verify-jwt
//   supabase secrets set SYNC_CRON_SECRET=<base64 of 32 random bytes>
//
// It uses exactly the same core as the manual "Sync now" button
// (see _shared/sync.ts). There is no second implementation.
//
// Nothing here logs a token, an amount, a merchant or a customer name.

import { safeEqual } from "../_shared/crypto.ts";
import { db } from "../_shared/rest.ts";
import { publicStats, syncDeps } from "../_shared/deps.ts";
import { recordRun, safeError, syncMany, type ConnectionRow } from "../_shared/sync.ts";
import { redactTransaction } from "../_shared/wise.ts";

const SYNC_CRON_SECRET = Deno.env.get("SYNC_CRON_SECRET");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Every connected Wise account, across all users. */
async function activeConnections(): Promise<ConnectionRow[]> {
  const rows = await db.select(
    "provider_connections?provider=eq.wise&status=eq.connected&select=id,user_id,provider",
  );
  return rows.map((r) => ({
    id: String(r.id),
    user_id: String(r.user_id),
    provider: String(r.provider),
  }));
}

/**
 * One-off shape check against the real API, without exposing real data.
 * Returns key paths and value *types* for the first transactions found;
 * amounts, names and descriptions are replaced by their type name and the
 * digits of any reference are masked. Use it to confirm the field choices
 * documented in _shared/wise.ts, then stop calling it.
 */
async function inspect(connectionId: string | null) {
  const filter = connectionId
    ? `&id=eq.${encodeURIComponent(connectionId)}`
    : "";
  const rows = await db.select(
    `provider_connections?provider=eq.wise&status=eq.connected${filter}` +
      "&select=id,user_id,provider&limit=1",
  );
  if (!rows.length) return json({ ok: false, error: "no_connection" });

  const conn: ConnectionRow = {
    id: String(rows[0].id),
    user_id: String(rows[0].user_id),
    provider: String(rows[0].provider),
  };

  const wise = await syncDeps.clientFor(conn);
  const profiles = await wise.profiles();
  const out: Record<string, unknown> = {
    profileCount: Array.isArray(profiles) ? profiles.length : 0,
    profileShape: redactTransaction(Array.isArray(profiles) ? profiles[0] : null),
    balances: [] as unknown[],
    transactionShapes: [] as unknown[],
  };

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400000);

  for (const p of (profiles ?? []).slice(0, 2)) {
    const profileId = String((p as Record<string, unknown>).id ?? "");
    if (!profileId) continue;
    let balances: Array<Record<string, unknown>> = [];
    try {
      balances = await wise.balances(profileId);
    } catch (e) {
      (out.balances as unknown[]).push({ error: safeError(e) });
      continue;
    }
    for (const b of (balances ?? []).slice(0, 3)) {
      const currency = String(b.currency ?? "");
      (out.balances as unknown[]).push({ currency, shape: redactTransaction(b) });
      if (!b.id || !currency) continue;
      try {
        const st = await wise.statement(profileId, String(b.id), currency, from, to);
        const txs = Array.isArray(st?.transactions) ? st.transactions : [];
        for (const tx of txs.slice(0, 2)) {
          (out.transactionShapes as unknown[]).push(redactTransaction(tx));
        }
      } catch (e) {
        (out.transactionShapes as unknown[]).push({ error: safeError(e) });
      }
    }
  }

  return json({ ok: true, inspection: out });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!SYNC_CRON_SECRET) {
    console.error("wise-sync: SYNC_CRON_SECRET is not set");
    return json({ error: "server_not_configured" }, 500);
  }
  const presented = req.headers.get("x-sync-secret") ?? "";
  if (!safeEqual(presented, SYNC_CRON_SECRET)) {
    return json({ error: "forbidden" }, 403);
  }

  const body = await req.json().catch(() => ({}));

  try {
    if (body.action === "inspect") {
      return await inspect(body.connectionId ? String(body.connectionId) : null);
    }

    const started = new Date();
    const connections = await activeConnections();
    const stats = await syncMany(syncDeps, connections);
    await recordRun(db, "cron", started, stats);

    // Counters only — safe for the function log.
    console.log("wise-sync:", JSON.stringify(publicStats(stats)));

    return json({
      ok: true,
      ...publicStats(stats),
      connections: stats.connections.map((c) => ({
        connectionId: c.connectionId,
        status: c.status,
        error: c.error,
        expensesImported: c.expensesImported,
      })),
    });
  } catch (e) {
    console.error("wise-sync: run failed:", safeError(e));
    return json({ ok: false, error: "server_error" }, 500);
  }
});
