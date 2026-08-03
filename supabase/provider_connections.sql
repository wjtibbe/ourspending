-- OurSpending — connected external accounts (Wise today; Revolut, PayPal and
-- Stripe can be added later without touching this schema).
--
-- SAFETY: additive only. Two new tables. No existing table, column, policy,
-- grant, function, trigger or row is dropped or modified, so every current
-- feature keeps working exactly as before.
--
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Then run supabase/verify_provider_connections.sql, which proves the
-- guarantees below instead of asserting them in a comment.
--
-- ============================================================
--  THE SECURITY MODEL
-- ============================================================
-- A connection is split over two tables on purpose:
--
--   public.provider_connections — the NON-SECRET half. Provider, status,
--     masked hint, timestamps. The browser may SELECT its own rows and
--     nothing else: INSERT/UPDATE/DELETE are revoked from the API roles, so
--     every mutation must go through the provider-connect Edge Function,
--     which derives user_id from the JWT and household_id from profiles.
--
--   public.provider_credentials — the SECRET half. RLS is enabled with ZERO
--     policies and every privilege is revoked from anon + authenticated —
--     the same shape public.calendar_oauth_tokens already uses. The table is
--     invisible and unwritable from the browser even if a future migration
--     grants it by accident, and the token inside is stored AES-256-GCM
--     encrypted with a key that lives only in Edge Function secrets, so a
--     database dump alone does not yield a usable token.
--
-- Net effect: the access token is WRITE-ONLY from the user's point of view.
-- Once submitted there is no API path, no policy and no column that can hand
-- it back to a browser.

-- ============================================================
--  0. Shared helper (idempotent — already created by calendar.sql)
-- ============================================================
-- Repeated here so this migration is self-contained and can be run on a
-- project where calendar.sql has not been applied. Identical body.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
--  1. Connections — one row per (user, provider)
-- ============================================================
-- household_id is recorded at connect time from the user's own profile and is
-- never accepted from a client request. Later transaction syncing must STILL
-- re-derive it server-side at sync time rather than trusting this column, so
-- that a membership change can never route someone else's transactions into
-- the wrong household. The column exists for display and for cascade cleanup.
create table if not exists public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  provider text not null,
  status text not null default 'connected',
  -- Non-secret display metadata returned by the provider on verification.
  external_account_id text,
  account_label text,
  -- Last 4 characters of the token, so the UI can show "••••ab12" as proof of
  -- which key is stored without ever revealing a usable credential.
  secret_hint text,
  last_checked_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Adding a provider later is a one-line change here plus one adapter in the
  -- provider-connect Edge Function. No schema or UI migration needed.
  constraint provider_connections_provider_check
    check (provider in ('wise', 'revolut', 'paypal', 'stripe')),
  constraint provider_connections_status_check
    check (status in ('connected', 'error')),
  -- One connection per provider per user. The Edge Function upserts on this,
  -- so re-submitting a token rotates the stored credential rather than
  -- creating a second, ambiguous connection.
  constraint provider_connections_user_provider_unique unique (user_id, provider)
);

create index if not exists provider_connections_user_idx
  on public.provider_connections (user_id);
create index if not exists provider_connections_household_idx
  on public.provider_connections (household_id);

alter table public.provider_connections enable row level security;

-- Explicit privileges: SELECT only. A newly created table only inherits
-- privileges if the project has ALTER DEFAULT PRIVILEGES configured, so grant
-- here to keep the migration self-contained — and revoke the write verbs
-- explicitly in case defaults did hand them out.
revoke all on public.provider_connections from anon, authenticated;
grant select on public.provider_connections to authenticated;
grant all    on public.provider_connections to service_role;

-- A user sees their own connections and no one else's. Deliberately scoped to
-- the user rather than the household: the credential belongs to one person,
-- and a household member has no business seeing that someone else linked an
-- external bank account.
drop policy if exists "Users read own provider connections" on public.provider_connections;
create policy "Users read own provider connections" on public.provider_connections
  for select using (user_id = auth.uid());

-- No INSERT / UPDATE / DELETE policy exists, and the verbs are revoked above.
-- Both layers say the same thing: only the Edge Function (service_role) may
-- write here. Privileges are checked before RLS, so a future policy mistake
-- alone cannot re-open writes.

drop trigger if exists provider_connections_touch on public.provider_connections;
create trigger provider_connections_touch
  before update on public.provider_connections
  for each row execute function public.touch_updated_at();

-- ============================================================
--  2. Credentials — server-side only, never readable by a client
-- ============================================================
-- Encrypted at rest by the Edge Function before it ever reaches Postgres:
--   ciphertext = base64( AES-256-GCM( token ) )
--   iv         = base64( 96-bit random nonce, unique per write )
--   key_version = which PROVIDER_ENCRYPTION_KEY encrypted it, so the key can
--                 be rotated later without a flag day.
-- Nothing in this table is ever selected by the browser; the Edge Function
-- decrypts it in memory and discards it.
create table if not exists public.provider_credentials (
  connection_id uuid primary key
    references public.provider_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  iv text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS on with NO policies = no anon/authenticated access whatsoever, matching
-- public.calendar_oauth_tokens. Disconnecting deletes the connection, and the
-- cascade above removes the credential with it.
alter table public.provider_credentials enable row level security;
revoke all on public.provider_credentials from anon, authenticated;
grant all on public.provider_credentials to service_role;

drop trigger if exists provider_credentials_touch on public.provider_credentials;
create trigger provider_credentials_touch
  before update on public.provider_credentials
  for each row execute function public.touch_updated_at();
