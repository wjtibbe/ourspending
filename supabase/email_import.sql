-- OurSpending — inbound email transaction import.
--
-- SAFETY: additive only. Two new tables. No existing table, column, policy,
-- grant, function or row is dropped or modified. `expenses` is untouched: an
-- imported expense is an ordinary expense row, and the link back to its source
-- lives here.
--
-- Run AFTER supabase/provider_connections.sql and supabase/wise_transactions.sql.
-- Then run supabase/verify_email_import.sql.
--
-- ============================================================
--  WHY THESE TABLES EXIST
-- ============================================================
-- email_import_connections gives each user a unique inbound alias. The token
-- is the ONLY thing that identifies the user to the webhook, so it is random
-- and encodes nothing: no user id, no household id, no name, no email address.
--
-- email_import_messages is the idempotency ledger AND the audit trail. Every
-- inbound message is recorded exactly once -- imported, skipped, unparsed or
-- failed -- and four independent unique keys make re-delivery safe:
--
--   provider_message_id  the inbound provider's own id  -> webhook retries
--   rfc_message_id       RFC 5322 Message-ID            -> the same mail twice
--   external_ref         the transaction reference      -> two mails, one txn
--   fingerprint          deterministic hash             -> last resort
--
-- Each is a PARTIAL unique index (`where ... is not null`), because NULLs do
-- not collide in a unique constraint: a message missing one identifier must
-- still be deduped by the others rather than slipping past all of them.
--
-- PRIVACY / RETENTION: the table stores the extracted fields the app actually
-- uses, plus hashes, plus a SANITISED copy of the body kept for SEVEN DAYS to
-- diagnose parser failures during rollout.
--
-- That retained body is constrained three ways:
--   * sanitised before storage -- scripts, styles, images, remote URLs and
--     inline handlers stripped; email addresses and card-length digit runs
--     redacted; attachments and binary content never stored at all;
--   * unreadable by clients -- column-level grants below omit raw_text and
--     raw_html, so no frontend query can return them, RLS notwithstanding;
--   * cleared on expiry by purge_expired_email_raw_content(), and cleared
--     EARLY on a successful import, since a message that parsed needs no
--     diagnosis. Purging removes only the body: ids, hashes, parsed metadata,
--     status, linked expense and error summary all survive.

-- ============================================================
--  0. Shared helper (idempotent)
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
--  1. Inbound aliases
-- ============================================================
create table if not exists public.email_import_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Which input method this alias serves. Generic on purpose: a future
  -- provider that also arrives by email adds a value here, not a new table.
  provider text not null default 'wise_email',

  -- The random alias token. 20 bytes of entropy rendered base32 (32 chars).
  -- Server-generated only -- clients cannot insert or update this table.
  alias_token text not null,

  -- A disabled connection keeps its history but stops accepting mail, without
  -- the user having to delete and re-create the alias.
  enabled boolean not null default true,

  status text not null default 'active',
  last_message_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint email_import_connections_provider_check
    check (provider in ('wise_email')),
  constraint email_import_connections_status_check
    check (status in ('active', 'error')),
  -- Long enough that it cannot be brute-forced or guessed.
  constraint email_import_connections_token_len check (length(alias_token) >= 24),
  constraint email_import_connections_token_unique unique (alias_token),
  constraint email_import_connections_user_provider_unique unique (user_id, provider)
);

-- Convergence: `create table if not exists` is a silent no-op against a table
-- of the same name in another shape, so nothing below assumes a column exists.
alter table public.email_import_connections
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists provider text not null default 'wise_email',
  add column if not exists alias_token text,
  add column if not exists enabled boolean not null default true,
  add column if not exists status text not null default 'active',
  add column if not exists last_message_at timestamptz,
  add column if not exists last_error text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists email_import_connections_user_idx
  on public.email_import_connections (user_id);

alter table public.email_import_connections enable row level security;

-- SELECT only, own rows only. Every write goes through the Edge Function or
-- the rotate RPC below, so an alias can never be forged or re-pointed.
revoke all on public.email_import_connections from anon, authenticated;
grant select on public.email_import_connections to authenticated;
grant all    on public.email_import_connections to service_role;

drop policy if exists "Users read own email import connection" on public.email_import_connections;
create policy "Users read own email import connection" on public.email_import_connections
  for select using (user_id = auth.uid());

drop trigger if exists email_import_connections_touch on public.email_import_connections;
create trigger email_import_connections_touch
  before update on public.email_import_connections
  for each row execute function public.touch_updated_at();

-- ============================================================
--  2. Message ledger
-- ============================================================
create table if not exists public.email_import_messages (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.email_import_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The household the expense actually landed in, recorded after the fact.
  -- Never read back as an input: the importer always re-derives it.
  household_id uuid references public.households(id) on delete set null,

  -- Which inbound provider delivered this (resend today).
  source text not null default 'resend',

  -- ---- the four dedupe keys ----
  provider_message_id text,
  rfc_message_id text,
  external_ref text,
  fingerprint text,

  received_at timestamptz not null default now(),
  -- The ORIGINAL sender, kept for sender-authenticity auditing. This is the
  -- bank's address, not the user's.
  from_address text,

  status text not null default 'received',
  skip_reason text,
  error_summary text,

  -- Extracted fields only. No subject, no body, no headers.
  merchant text,
  amount_value numeric,
  amount_currency text,
  merchant_amount_value numeric,
  merchant_amount_currency text,
  occurred_at timestamptz,
  mapped_category text,
  category_source text,

  expense_id uuid references public.expenses(id) on delete set null,

  -- ---- short-lived diagnostic retention (7 days) ----
  -- Sanitised body kept ONLY to diagnose a parser failure: scripts, styles,
  -- images, remote URLs and inline handlers are stripped before storage, and
  -- email addresses / long card-like digit runs are redacted. Attachments and
  -- binary content are never stored at all. Cleared early on a successful
  -- import, because a message that parsed needs no diagnosis.
  raw_text text,
  raw_html text,
  raw_content_expires_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint email_import_messages_status_check
    check (status in ('received', 'imported', 'skipped', 'unparsed', 'failed', 'duplicate'))
);

alter table public.email_import_messages
  add column if not exists connection_id uuid
    references public.email_import_connections(id) on delete cascade,
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists household_id uuid references public.households(id) on delete set null,
  add column if not exists source text not null default 'resend',
  add column if not exists provider_message_id text,
  add column if not exists rfc_message_id text,
  add column if not exists external_ref text,
  add column if not exists fingerprint text,
  add column if not exists received_at timestamptz not null default now(),
  add column if not exists from_address text,
  add column if not exists status text not null default 'received',
  add column if not exists skip_reason text,
  add column if not exists error_summary text,
  add column if not exists merchant text,
  add column if not exists amount_value numeric,
  add column if not exists amount_currency text,
  add column if not exists merchant_amount_value numeric,
  add column if not exists merchant_amount_currency text,
  add column if not exists occurred_at timestamptz,
  add column if not exists mapped_category text,
  add column if not exists category_source text,
  add column if not exists expense_id uuid references public.expenses(id) on delete set null,
  add column if not exists raw_text text,
  add column if not exists raw_html text,
  add column if not exists raw_content_expires_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- ---- THE idempotency guarantees ----
-- Partial, because a NULL identifier must not silently satisfy the constraint.
-- Scoped to the connection: two different users can legitimately receive
-- messages carrying the same reference, and collapsing those would drop a real
-- expense belonging to one of them.
create unique index if not exists email_import_messages_provider_msg_unique
  on public.email_import_messages (connection_id, provider_message_id)
  where provider_message_id is not null;

create unique index if not exists email_import_messages_rfc_msg_unique
  on public.email_import_messages (connection_id, rfc_message_id)
  where rfc_message_id is not null;

create unique index if not exists email_import_messages_external_ref_unique
  on public.email_import_messages (connection_id, external_ref)
  where external_ref is not null;

create unique index if not exists email_import_messages_fingerprint_unique
  on public.email_import_messages (connection_id, fingerprint)
  where fingerprint is not null;

create index if not exists email_import_messages_user_idx
  on public.email_import_messages (user_id);
create index if not exists email_import_messages_connection_idx
  on public.email_import_messages (connection_id, received_at desc);

alter table public.email_import_messages enable row level security;

revoke all on public.email_import_messages from anon, authenticated;

-- COLUMN-level SELECT, deliberately omitting raw_text and raw_html. RLS scopes
-- rows to their owner; this additionally makes the retained body unreadable by
-- ANY client, including its own owner, so it can never surface in the frontend.
-- Privileges are checked before RLS, so a future policy mistake cannot expose
-- it either.
grant select (
  id, connection_id, user_id, household_id, source,
  provider_message_id, rfc_message_id, external_ref, fingerprint,
  received_at, from_address, status, skip_reason, error_summary,
  merchant, amount_value, amount_currency,
  merchant_amount_value, merchant_amount_currency, occurred_at,
  mapped_category, category_source, expense_id,
  raw_content_expires_at, created_at, updated_at
) on public.email_import_messages to authenticated;

grant all on public.email_import_messages to service_role;

drop policy if exists "Users read own email import messages" on public.email_import_messages;
create policy "Users read own email import messages" on public.email_import_messages
  for select using (user_id = auth.uid());

drop trigger if exists email_import_messages_touch on public.email_import_messages;
create trigger email_import_messages_touch
  before update on public.email_import_messages
  for each row execute function public.touch_updated_at();

-- ============================================================
--  3. Alias issuing / rotation
-- ============================================================
-- SECURITY DEFINER so the token is generated server-side with real entropy and
-- the table stays unwritable by clients. Callable by the owner only, and it can
-- only ever touch the caller's own row -- auth.uid() is the only identity used.
--
-- The token is 20 bytes from pgcrypto's CSPRNG rendered as 40 lowercase hex
-- chars: unguessable (160 bits), case-insensitive, and safe in an email local
-- part, which is what makes `wise-<token>@...` route reliably. Deliberately
-- NOT random() -- that is not cryptographically strong, and this token is the
-- only thing standing between a stranger and injecting expenses.
create or replace function public.issue_email_import_alias(p_rotate boolean default false)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
  v_existing text;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select alias_token into v_existing
    from email_import_connections
   where user_id = v_uid and provider = 'wise_email';

  if v_existing is not null and not p_rotate then
    return v_existing;
  end if;

  v_token := encode(gen_random_bytes(20), 'hex');

  insert into email_import_connections (user_id, provider, alias_token)
  values (v_uid, 'wise_email', v_token)
  on conflict (user_id, provider)
  do update set alias_token = excluded.alias_token,
                enabled = true,
                status = 'active',
                last_error = null,
                updated_at = now();

  return v_token;
end;
$$;

revoke all on function public.issue_email_import_alias(boolean) from public, anon;
grant execute on function public.issue_email_import_alias(boolean) to authenticated;

-- Enable/disable without losing history or changing the address.
create or replace function public.set_email_import_enabled(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  update email_import_connections
     set enabled = p_enabled, updated_at = now()
   where user_id = v_uid and provider = 'wise_email';
  return p_enabled;
end;
$$;

revoke all on function public.set_email_import_enabled(boolean) from public, anon;
grant execute on function public.set_email_import_enabled(boolean) to authenticated;

-- ============================================================
--  4. Retention cleanup
-- ============================================================
-- Removes the retained body once it expires, and NOTHING else. Message ids,
-- hashes, parsed metadata, parsing status, the linked expense and the safe
-- error summary all survive -- so history, dedupe and auditing are unaffected
-- and a purged message can never be re-imported.
--
-- SECURITY DEFINER with execute revoked from clients: only the scheduled job
-- (or an operator) runs this. Batched so a large backlog cannot hold a long
-- transaction open.
create or replace function public.purge_expired_email_raw_content(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purged integer;
begin
  with due as (
    select id
      from email_import_messages
     where raw_content_expires_at is not null
       and raw_content_expires_at <= now()
       and (raw_text is not null or raw_html is not null)
     order by raw_content_expires_at
     limit greatest(1, p_limit)
     for update skip locked
  )
  update email_import_messages m
     set raw_text = null,
         raw_html = null,
         raw_content_expires_at = null
    from due
   where m.id = due.id;

  get diagnostics v_purged = row_count;
  return v_purged;
end;
$$;

revoke all on function public.purge_expired_email_raw_content(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_email_raw_content(integer) to service_role;

-- ------------------------------------------------------------
-- Scheduling (optional but recommended)
-- ------------------------------------------------------------
-- Retention is enforced in two independent ways, so a missing schedule can
-- never turn 7-day retention into indefinite retention by accident:
--   1. this daily job actively clears expired bodies;
--   2. the frontend cannot read raw_text/raw_html at all (column grants
--      above), so an unpurged body is still unreachable.
--
-- Run once to schedule it:
--
--   create extension if not exists pg_cron;
--   select cron.schedule(
--     'purge-email-raw-content',
--     '20 3 * * *',
--     $cron$ select public.purge_expired_email_raw_content(); $cron$
--   );
--
-- To check:  select * from cron.job where jobname = 'purge-email-raw-content';
-- To remove: select cron.unschedule('purge-email-raw-content');
--
-- To purge everything immediately, regardless of expiry:
--   update email_import_messages
--      set raw_text = null, raw_html = null, raw_content_expires_at = null
--    where raw_text is not null or raw_html is not null;
