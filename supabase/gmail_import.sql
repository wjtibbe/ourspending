-- OurSpending — Gmail OAuth import.
--
-- SAFETY: additive and idempotent. Extends email_import_connections to serve a
-- second input method, and adds two new tables. No existing table is dropped,
-- no column is removed, no row is rewritten. `expenses` is untouched.
--
-- Run AFTER supabase/email_import.sql.
-- Then run supabase/verify_gmail_import.sql.
--
-- ============================================================
--  WHY THIS EXTENDS email_import_connections
-- ============================================================
-- Gmail polling and Resend forwarding differ only in HOW a message arrives.
-- Everything after that -- the four dedupe keys, the 7-day sanitised
-- retention, the purge job, the RLS and the column grants that hide raw
-- bodies from every client -- is identical, and all of it already hangs off
-- email_import_connections via email_import_messages.connection_id.
--
-- So Gmail reuses that table rather than introducing a parallel ledger that
-- would need its own copy of all four dedupe indexes. A Gmail row simply has
-- no alias_token: nothing is forwarded to it, so it has no inbound address.
--
-- The alias_token NOT NULL is therefore relaxed. That is a widening, not a
-- removal: existing Resend rows keep their tokens, the uniqueness constraint
-- still holds (NULLs never collide in a unique index), and the
-- `length(alias_token) >= 24` check already passes on NULL by SQL's
-- three-valued logic, so it needs no change.

-- ============================================================
--  0. Extensions
-- ============================================================
-- Supabase installs pgcrypto into `extensions`, not `public`. The
-- SECURITY DEFINER functions below pin `search_path = public, pg_temp`
-- (hardening: a caller must not be able to shadow a name they resolve), so
-- gen_random_bytes must be schema-qualified. gen_random_uuid needs no
-- qualification -- it is a pg_catalog builtin from Postgres 13 onward.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
--  1. Widen email_import_connections to a second provider
-- ============================================================
alter table public.email_import_connections
  alter column alias_token drop not null;

-- Gmail-specific, non-secret metadata. Everything here is safe for the owner
-- to read; the tokens themselves live in email_import_credentials below.
alter table public.email_import_connections
  -- Which mailbox is connected, so the UI can show it back. This is the
  -- user's OWN address -- not a third party's.
  add column if not exists account_email text,
  -- Exactly which scopes Google granted. Recorded so a scope downgrade is
  -- visible rather than surfacing later as a confusing 403.
  add column if not exists granted_scopes text,
  -- When the current access token dies. NOT a secret: knowing the expiry of
  -- a token you cannot read is useless.
  add column if not exists access_expires_at timestamptz,
  -- Incremental cursor for a future historyId-based sync. Unused by the
  -- current query-window poll, stored so switching is not a migration.
  add column if not exists last_history_id text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_synced_at timestamptz;

-- Re-point the provider check at both input methods. Dropping and recreating
-- a CHECK is the only way to widen it; the new constraint is a strict
-- superset, so every existing row still satisfies it.
alter table public.email_import_connections
  drop constraint if exists email_import_connections_provider_check;
alter table public.email_import_connections
  add constraint email_import_connections_provider_check
  check (provider in ('wise_email', 'gmail'));

-- A Resend connection MUST have an alias (it is the only way mail reaches
-- it); a Gmail connection must not (nothing is forwarded to it). Encoding
-- that here stops a half-configured row from ever existing.
alter table public.email_import_connections
  drop constraint if exists email_import_connections_alias_shape_check;
alter table public.email_import_connections
  add constraint email_import_connections_alias_shape_check
  check (
    (provider = 'wise_email' and alias_token is not null)
    or (provider = 'gmail' and alias_token is null)
  );

-- The ledger records which input method delivered each message.
alter table public.email_import_messages
  drop constraint if exists email_import_messages_source_check;
alter table public.email_import_messages
  add constraint email_import_messages_source_check
  check (source in ('resend', 'gmail'));

-- The owner may read their own new metadata columns. Column-level grants are
-- additive, and raw_text/raw_html remain deliberately excluded (see
-- email_import.sql) so retained bodies stay unreadable by every client.
grant select (
  account_email, granted_scopes, access_expires_at,
  last_history_id, last_checked_at, last_synced_at
) on public.email_import_connections to authenticated;

-- ============================================================
--  2. OAuth credentials — server-side only, never readable by a client
-- ============================================================
-- Encrypted by the Edge Function before it reaches Postgres, with the same
-- AES-256-GCM helper and PROVIDER_ENCRYPTION_KEY the Wise credentials use:
--   ciphertext = base64( AES-256-GCM( json ) )
--   iv         = base64( 96-bit nonce, unique per write )
-- The plaintext is a JSON document holding the refresh token and the current
-- access token together, so one row is one atomic credential rotation.
--
-- RLS enabled with ZERO policies plus revoked privileges: the same shape as
-- provider_credentials and calendar_oauth_tokens. The refresh token is
-- WRITE-ONLY from a browser's point of view -- no policy, no grant and no
-- column can hand it back.
create table if not exists public.email_import_credentials (
  connection_id uuid primary key
    references public.email_import_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_import_credentials
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists ciphertext text,
  add column if not exists iv text,
  add column if not exists key_version integer not null default 1,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.email_import_credentials enable row level security;
revoke all on public.email_import_credentials from anon, authenticated;
grant all on public.email_import_credentials to service_role;

drop trigger if exists email_import_credentials_touch on public.email_import_credentials;
create trigger email_import_credentials_touch
  before update on public.email_import_credentials
  for each row execute function public.touch_updated_at();

-- ============================================================
--  3. OAuth state — single-use, short-lived, bound to one user
-- ============================================================
-- `state` is what stops an attacker completing an OAuth dance in THEIR
-- browser against YOUR account. It is bound to the app user who started the
-- flow, consumed exactly once, and expires quickly.
--
-- `code_verifier` is the PKCE secret. It never leaves the server, so an
-- intercepted authorization code cannot be redeemed by anyone else.
--
-- Also RLS-on-zero-policies: a client that could read pending states could
-- read another user's verifier.
create table if not exists public.email_import_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null,
  redirect_uri text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  consumed_at timestamptz
);

alter table public.email_import_oauth_states
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists code_verifier text,
  add column if not exists redirect_uri text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists expires_at timestamptz not null default now() + interval '15 minutes',
  add column if not exists consumed_at timestamptz;

create index if not exists email_import_oauth_states_expiry_idx
  on public.email_import_oauth_states (expires_at);

alter table public.email_import_oauth_states enable row level security;
revoke all on public.email_import_oauth_states from anon, authenticated;
grant all on public.email_import_oauth_states to service_role;

-- ============================================================
--  4. Consuming a state — atomic, single-use
-- ============================================================
-- Returns the bound user exactly once. A replayed state returns no row,
-- because the same statement that reads it also marks it consumed. Doing
-- that in one UPDATE ... RETURNING (rather than SELECT-then-UPDATE) is what
-- makes a concurrent replay impossible rather than merely unlikely.
--
-- SECURITY DEFINER with execute revoked from every client role: only the
-- callback Edge Function (service_role) runs this.
create or replace function public.consume_email_import_oauth_state(p_state text)
returns table (user_id uuid, code_verifier text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update email_import_oauth_states s
     set consumed_at = now()
   where s.state = p_state
     and s.consumed_at is null
     and s.expires_at > now()
  returning s.user_id, s.code_verifier;
end;
$$;

revoke all on function public.consume_email_import_oauth_state(text)
  from public, anon, authenticated;
grant execute on function public.consume_email_import_oauth_state(text) to service_role;

-- Housekeeping: consumed and expired states are dead weight. Safe to run at
-- any time; it can never touch a live state.
create or replace function public.purge_email_import_oauth_states()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_purged integer;
begin
  delete from email_import_oauth_states
   where expires_at < now() - interval '1 day'
      or consumed_at is not null;
  get diagnostics v_purged = row_count;
  return v_purged;
end;
$$;

revoke all on function public.purge_email_import_oauth_states()
  from public, anon, authenticated;
grant execute on function public.purge_email_import_oauth_states() to service_role;

-- ============================================================
--  5. Disconnecting
-- ============================================================
-- There is deliberately NO disconnect RPC here. Disconnecting must also
-- revoke the grant on Google's side, which needs the decrypted refresh token
-- and therefore has to happen inside the gmail-disconnect Edge Function.
-- That function verifies the caller's JWT and then deletes the row scoped to
-- that user id, so a second SQL-level path would add surface area without
-- adding a capability.
--
-- Deleting the connection cascades to the credential and to the ledger. The
-- ledger going too is deliberate: keeping orphaned message rows would let a
-- later reconnect skip real transactions as "already imported" against a
-- mailbox that has since changed.

-- ============================================================
--  6. Scheduling (run once, after deploying gmail-sync)
-- ============================================================
-- Once per day, as specified. The two-day Gmail lookback window means a
-- missed run is caught by the next one, and the four dedupe keys make the
-- overlap a no-op rather than a duplicate.
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--
--   select cron.schedule(
--     'gmail-daily-sync',
--     '25 4 * * *',
--     $cron$
--     select net.http_post(
--       url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/gmail-sync',
--       headers := jsonb_build_object(
--                    'Content-Type',  'application/json',
--                    'x-sync-secret', '<SYNC_CRON_SECRET>'
--                  ),
--       body    := jsonb_build_object('trigger', 'cron'),
--       timeout_milliseconds := 120000
--     );
--     $cron$
--   );
--
-- To pause:  select cron.unschedule('gmail-daily-sync');
