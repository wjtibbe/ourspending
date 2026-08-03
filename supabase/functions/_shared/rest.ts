// Service-role PostgREST access, server side only.
//
// Same zero-dependency style as calendar-feed: raw fetch, no supabase-js. The
// service-role key is read from the platform-injected env and never leaves
// this process.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export type Row = Record<string, unknown>;

/** The narrow surface the sync core needs, so tests can supply a fake. */
export interface Db {
  select(path: string): Promise<Row[]>;
  insert(table: string, body: Row | Row[], prefer?: string): Promise<Row[]>;
  patch(path: string, body: Row, prefer?: string): Promise<Row[]>;
}

async function call(path: string, init: RequestInit = {}): Promise<Row[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  if (!res.ok) throw new Error(`db_${res.status}: ${await res.text()}`);
  const text = await res.text();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export const db: Db = {
  select: (path) => call(path),
  insert: (table, body, prefer = "return=representation") =>
    call(table, { method: "POST", headers: { Prefer: prefer }, body: JSON.stringify(body) }),
  patch: (path, body, prefer = "return=representation") =>
    call(path, { method: "PATCH", headers: { Prefer: prefer }, body: JSON.stringify(body) }),
};

export async function del(path: string): Promise<void> {
  await call(path, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

/**
 * Resolves the caller from their JWT. Returns null for anything unsigned,
 * expired or malformed.
 */
export async function currentUser(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: String(u.id) } : null;
}

export const q = (v: string) => encodeURIComponent(v);
