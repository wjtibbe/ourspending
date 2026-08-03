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

-- Upgrade path: if an earlier version of this file was already run, widen the
-- uniqueness scope in place rather than requiring a drop.
do $$
begin
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

  if exists (
    select 1 from pg_constraint
    where conname = 'wise_transactions_reference_unique'
      and conrelid = 'public.wise_transactions'::regclass
      and array_length(conkey, 1) = 2
  ) then
    alter table public.wise_transactions
      drop constraint wise_transactions_reference_unique;
    alter table public.wise_transactions
      add constraint wise_transactions_reference_unique
      unique (connection_id, wise_profile_id, wise_balance_id, wise_reference);
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

-- Upgrade path for an earlier version of this file.
alter table public.provider_sync_runs
  add column if not exists missing_stable_id integer not null default 0;

create index if not exists provider_sync_runs_started_idx
  on public.provider_sync_runs (started_at desc);

alter table public.provider_sync_runs enable row level security;
revoke all on public.provider_sync_runs from anon, authenticated;
grant all on public.provider_sync_runs to service_role;
