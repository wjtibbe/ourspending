-- OurSpending — imported Wise transactions.
--
-- SAFETY: additive only. Two new tables. No existing table, column, policy,
-- grant, function or row is dropped or modified. In particular `expenses` is
-- untouched: an imported expense is an ordinary expense row, and the link back
-- to its source lives here rather than as a new column on expenses.
--
-- Run AFTER supabase/provider_connections.sql.
-- Then run supabase/verify_wise_transactions.sql.
--
-- ============================================================
--  WHY THIS TABLE EXISTS
-- ============================================================
-- It is the idempotency ledger. Every transaction Wise reports is recorded
-- here exactly once — imported, skipped or failed — keyed by the provider's
-- own stable reference. That single unique constraint is what makes the hourly
-- job safe to run repeatedly: a second run inserts nothing and creates no
-- second expense.
--
-- It is also the audit trail for the two decisions that are easy to get wrong:
--   amount_source_path  — WHICH field of the Wise payload was treated as the
--                         amount actually deducted from the balance.
--   category_source     — how the app category was chosen (provider category,
--                         merchant category, MCC, description, or fallback).
-- Both are recorded per row, so the field choices documented in
-- supabase/functions/_shared/wise.ts can be verified against real data instead
-- of trusted.

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
--  1. The transaction ledger
-- ============================================================
create table if not exists public.wise_transactions (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.provider_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete set null,

  -- Wise's own stable identifier for the movement (e.g. "CARD-123456789"),
  -- taken from referenceNumber or, failing that, the transaction id. A
  -- transaction with neither is never imported and never reaches this table.
  wise_reference text not null,
  -- Compatibility alias for wise_reference, kept NOT NULL. Self-populated by
  -- the trigger below (never by application code), so every caller — the
  -- sync Edge Function, "Sync now", and this file's own verification script —
  -- satisfies it automatically without needing to know it exists.
  wise_transaction_id text not null,
  -- Part of the uniqueness scope, so '' rather than null: NULLs do not collide
  -- in a unique constraint, which would silently disable the dedupe guarantee.
  wise_profile_id text not null default '',
  wise_balance_id text not null default '',
  occurred_at timestamptz,

  direction text,        -- out | in | unknown
  wise_status text,      -- provider status when one is present
  detail_type text,      -- CARD | TRANSFER | CONVERSION | ...

  -- The amount ACTUALLY DEDUCTED from the Wise balance, stored positive to
  -- match the app convention (AddExpense rejects <= 0). amount_source_path
  -- records which payload field it came from; amount_low_confidence flags the
  -- last-resort path so questionable rows can be found with one query.
  amount_value numeric,
  amount_currency text,
  amount_source_path text,
  amount_low_confidence boolean not null default false,
  -- Compatibility alias for amount_value, kept NOT NULL. Self-populated by
  -- the trigger below, same reason and same mechanism as wise_transaction_id.
  amount numeric not null,

  -- What the merchant charged, when a conversion means that differs. Optional
  -- source metadata only; the expense always uses the deducted amount.
  merchant_amount_value numeric,
  merchant_amount_currency text,
  merchant_amount_source_path text,

  wise_category text,       -- the provider's own label, kept for auditing only
  mapped_category text,     -- the existing app category it was mapped onto
  category_source text,     -- provider_category | merchant_category | mcc | description | fallback

  import_status text not null default 'pending_import',
  skip_reason text,
  error_summary text,

  -- Nulled rather than cascading if the user deletes the expense: the ledger
  -- row must survive so the transaction is never re-imported.
  expense_id uuid references public.expenses(id) on delete set null,

  raw_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint wise_transactions_import_status_check
    check (import_status in ('pending_import', 'imported', 'skipped', 'failed')),

  -- THE idempotency guarantee. Two runs over the same statement cannot create
  -- two ledger rows, and therefore cannot create two expenses.
  --
  -- The scope includes profile and balance because a Wise reference is only
  -- documented to be unique within one balance statement. The same reference
  -- under a different profile or balance is a different movement, and
  -- collapsing the two would silently drop a real expense.
  constraint wise_transactions_reference_unique
    unique (connection_id, wise_profile_id, wise_balance_id, wise_reference)
);

-- ============================================================
--  1b. Schema convergence
-- ============================================================
-- `create table if not exists` above is a SILENT NO-OP when a table of this
-- name already exists in any other shape — an earlier version of this file, or
-- a hand-rolled first attempt. Everything below therefore assumes nothing:
-- every column is added with IF NOT EXISTS before any default, constraint or
-- index refers to it. On a genuinely fresh database all of these are no-ops.
alter table public.wise_transactions
  add column if not exists connection_id uuid
    references public.provider_connections(id) on delete cascade,
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists household_id uuid
    references public.households(id) on delete set null,
  add column if not exists wise_reference text,
  add column if not exists wise_transaction_id text,
  add column if not exists wise_profile_id text,
  add column if not exists wise_balance_id text,
  add column if not exists occurred_at timestamptz,
  add column if not exists direction text,
  add column if not exists wise_status text,
  add column if not exists detail_type text,
  add column if not exists amount_value numeric,
  add column if not exists amount_currency text,
  add column if not exists amount_source_path text,
  add column if not exists amount_low_confidence boolean not null default false,
  add column if not exists amount numeric,
  add column if not exists merchant_amount_value numeric,
  add column if not exists merchant_amount_currency text,
  add column if not exists merchant_amount_source_path text,
  add column if not exists wise_category text,
  add column if not exists mapped_category text,
  add column if not exists category_source text,
  add column if not exists import_status text not null default 'pending_import',
  add column if not exists skip_reason text,
  add column if not exists error_summary text,
  add column if not exists expense_id uuid references public.expenses(id) on delete set null,
  add column if not exists raw_json jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Foreign keys, for the same reason: when a column already existed, the
-- ADD COLUMN above was a no-op and its REFERENCES clause never ran. The delete
-- behaviour is part of the guarantees this table makes — ledger rows must die
-- with their connection, and must SURVIVE the deletion of their expense so the
-- transaction is never re-imported — so each key is ensured explicitly.
do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      ('connection_id', 'public.provider_connections(id)', 'cascade'),
      ('user_id',       'auth.users(id)',                  'cascade'),
      ('household_id',  'public.households(id)',           'set null'),
      ('expense_id',    'public.expenses(id)',             'set null')
    ) as t(col, target, on_delete)
  loop
    if not exists (
      select 1
        from pg_constraint c
        join pg_attribute a
          on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.conrelid = 'public.wise_transactions'::regclass
         and c.contype = 'f'
         and a.attname = fk.col
    ) then
      begin
        execute format(
          'alter table public.wise_transactions add constraint %I foreign key (%I) references %s on delete %s',
          'wise_transactions_' || fk.col || '_fkey', fk.col, fk.target, fk.on_delete);
      exception when foreign_key_violation then
        raise notice
          'wise_transactions.% foreign key not added: existing rows reference missing parents', fk.col;
      end;
    end if;
  end loop;
end $$;

-- The dedupe columns must never be NULL: NULLs do not collide in a unique
-- constraint, so a single NULL profile or balance would quietly disable the
-- idempotency guarantee. Default, backfill, then enforce — in that order, so
-- this is safe on a table that already holds rows.
alter table public.wise_transactions
  alter column wise_profile_id set default '',
  alter column wise_balance_id set default '';

update public.wise_transactions
   set wise_profile_id = coalesce(wise_profile_id, ''),
       wise_balance_id = coalesce(wise_balance_id, '')
 where wise_profile_id is null or wise_balance_id is null;

alter table public.wise_transactions
  alter column wise_profile_id set not null,
  alter column wise_balance_id set not null;

-- wise_transaction_id and amount are compatibility aliases for wise_reference
-- and amount_value respectively. Both follow the same default/backfill/enforce
-- shape as above, plus a trigger so they stay populated on every FUTURE insert
-- or update too, not just the rows that already exist today. Neither the sync
-- Edge Function, "Sync now", nor this file's own verification script ever
-- needs to know these columns exist.
update public.wise_transactions
   set wise_transaction_id = coalesce(wise_transaction_id, wise_reference)
 where wise_transaction_id is null;

-- amount_value is legitimately NULL for every SKIPPED transaction (pending,
-- reversed, incoming, unsupported-currency, ...) -- the sync core never
-- resolves an amount for those by design. A straight copy would therefore
-- make `amount` NOT NULL impossible to satisfy for real, everyday skip rows,
-- not just for this file's own tests. 0 is the "no resolved amount" sentinel
-- for exactly those rows.
--
-- Two plain assignments rather than one COALESCE: a legacy `amount` column
-- could be text (Wise's own field naming isn't guaranteed numeric on an
-- unknown pre-existing table), and while a direct assignment from numeric
-- into text is allowed (an "assignment cast"), COALESCE(text, numeric, int)
-- is not -- it requires a common IMPLICIT cast across all arguments, which
-- text and numeric do not have, and errors even though a plain SET does not.
update public.wise_transactions
   set amount = amount_value
 where amount is null and amount_value is not null;
update public.wise_transactions
   set amount = 0
 where amount is null;

create or replace function public.wise_transactions_default_transaction_id()
returns trigger language plpgsql as $$
begin
  if new.wise_transaction_id is null then
    new.wise_transaction_id := new.wise_reference;
  end if;
  -- Same reason as the backfill above: two plain assignments, not a COALESCE,
  -- so this works whether `amount` is numeric or text.
  if new.amount is null then
    if new.amount_value is not null then
      new.amount := new.amount_value;
    else
      new.amount := 0;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists wise_transactions_default_transaction_id on public.wise_transactions;
create trigger wise_transactions_default_transaction_id
  before insert or update on public.wise_transactions
  for each row execute function public.wise_transactions_default_transaction_id();

-- The remaining NOT NULLs and the status CHECK, applied only where the data
-- allows it. A pre-existing table holding rows that violate them is left alone
-- with a notice rather than failing the migration.
do $$
declare
  col text;
  bad bigint;
begin
  foreach col in array array['connection_id', 'user_id', 'wise_reference', 'wise_transaction_id', 'amount', 'raw_json'] loop
    execute format('select count(*) from public.wise_transactions where %I is null', col)
      into bad;
    if bad = 0 then
      execute format('alter table public.wise_transactions alter column %I set not null', col);
    else
      raise notice
        'wise_transactions.% left nullable: % existing row(s) are NULL', col, bad;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conname = 'wise_transactions_import_status_check'
      and conrelid = 'public.wise_transactions'::regclass
  ) then
    select count(*) into bad from public.wise_transactions
     where import_status is not null
       and import_status not in ('pending_import', 'imported', 'skipped', 'failed');
    if bad = 0 then
      alter table public.wise_transactions
        add constraint wise_transactions_import_status_check
        check (import_status in ('pending_import', 'imported', 'skipped', 'failed'));
    else
      raise notice
        'wise_transactions import_status CHECK not added: % row(s) hold other values', bad;
    end if;
  end if;
end $$;

-- ============================================================
--  1c. The uniqueness scope
-- ============================================================
-- Ensure the constraint exists AND spans exactly the four target columns,
-- whatever shape it had before (absent, or the earlier two-column version).
do $$
declare
  target text[] := array['connection_id', 'wise_profile_id', 'wise_balance_id', 'wise_reference'];
  current_cols text[];
begin
  select array_agg(a.attname::text order by k.ord)
    into current_cols
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conname = 'wise_transactions_reference_unique'
     and c.conrelid = 'public.wise_transactions'::regclass;

  if current_cols is not null and current_cols <> target then
    alter table public.wise_transactions
      drop constraint wise_transactions_reference_unique;
    current_cols := null;
  end if;

  if current_cols is null then
    begin
      alter table public.wise_transactions
        add constraint wise_transactions_reference_unique
        unique (connection_id, wise_profile_id, wise_balance_id, wise_reference);
    exception when unique_violation then
      raise exception
        'wise_transactions holds duplicate (connection_id, wise_profile_id, wise_balance_id, wise_reference) rows. Remove them, then re-run this migration.';
    end;
  end if;
end $$;

create index if not exists wise_transactions_user_idx
  on public.wise_transactions (user_id);
create index if not exists wise_transactions_household_idx
  on public.wise_transactions (household_id);
create index if not exists wise_transactions_connection_idx
  on public.wise_transactions (connection_id, occurred_at desc);

alter table public.wise_transactions enable row level security;

-- SELECT only, and only your own rows. Writes belong to the Edge Functions
-- (service_role) alone, so a client can neither forge an import nor retarget
-- one at another household.
revoke all on public.wise_transactions from anon, authenticated;
grant select on public.wise_transactions to authenticated;
grant all    on public.wise_transactions to service_role;

drop policy if exists "Users read own wise transactions" on public.wise_transactions;
create policy "Users read own wise transactions" on public.wise_transactions
  for select using (user_id = auth.uid());

drop trigger if exists wise_transactions_touch on public.wise_transactions;
create trigger wise_transactions_touch
  before update on public.wise_transactions
  for each row execute function public.touch_updated_at();

-- ============================================================
--  2. Sync run log — counters only, server-side only
-- ============================================================
-- Deliberately contains no transaction detail, no merchant, no amount and no
-- token: just the per-run counters, so an hourly job that quietly stops
-- importing is visible. RLS on with NO policies and everything revoked, the
-- same shape as provider_credentials and calendar_oauth_tokens.
create table if not exists public.provider_sync_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_source text not null,          -- cron | manual
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  connections_processed integer not null default 0,
  transactions_fetched integer not null default 0,
  expenses_imported integer not null default 0,
  duplicates_skipped integer not null default 0,
  unsupported_skipped integer not null default 0,
  failed integer not null default 0,
  -- Transactions Wise reported with no stable identifier. These are logged and
  -- counted but never imported, because without a stable key a re-run could
  -- create the same expense twice.
  missing_stable_id integer not null default 0,
  category_fallbacks integer not null default 0,
  error_summary text,
  created_at timestamptz not null default now(),
  constraint provider_sync_runs_trigger_check
    check (trigger_source in ('cron', 'manual'))
);

-- Schema convergence, for the same reason as above: `create table if not
-- exists` is a no-op against an earlier-shaped table, so every column is added
-- defensively. All no-ops on a fresh database.
alter table public.provider_sync_runs
  add column if not exists trigger_source text,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz not null default now(),
  add column if not exists connections_processed integer not null default 0,
  add column if not exists transactions_fetched integer not null default 0,
  add column if not exists expenses_imported integer not null default 0,
  add column if not exists duplicates_skipped integer not null default 0,
  add column if not exists unsupported_skipped integer not null default 0,
  add column if not exists failed integer not null default 0,
  add column if not exists missing_stable_id integer not null default 0,
  add column if not exists category_fallbacks integer not null default 0,
  add column if not exists error_summary text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists provider_sync_runs_started_idx
  on public.provider_sync_runs (started_at desc);

alter table public.provider_sync_runs enable row level security;
revoke all on public.provider_sync_runs from anon, authenticated;
grant all on public.provider_sync_runs to service_role;
