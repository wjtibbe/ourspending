-- OurSpending — migration baseline status.
--
-- READ-ONLY. Pure SELECT: no table, row, index, policy or grant is created,
-- altered or dropped. Safe to run on production at any time.
--
-- Purpose: the eleven files in supabase/migrations/ were originally applied by
-- hand in the SQL Editor, so the project's supabase_migrations.schema_migrations
-- table has no record of them. `supabase migration list` therefore reports all
-- eleven as local-only and CANNOT tell you which are genuinely already applied.
--
-- This script answers that question directly, by checking whether each
-- migration's distinctive schema object actually exists. Run it in the Supabase
-- SQL Editor and use the `verdict` column to decide which timestamps to pass to
-- `supabase migration repair ... --status applied`.
--
--   verdict = APPLIED  -> repair it as applied (do NOT let db push run it)
--   verdict = PENDING  -> leave it alone (let db push apply it)

with checks(seq, version, migration, object_checked, present) as (
  values
    (1, '20260713231102', 'groceries',
        'table public.groceries',
        to_regclass('public.groceries') is not null),

    (2, '20260727214607', 'calendar',
        'table public.calendar_events',
        to_regclass('public.calendar_events') is not null),

    (3, '20260728035836', 'upgrade_weekday_and_colors',
        'column households.shared_color',
        exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'households'
                   and column_name = 'shared_color')),

    (4, '20260729012421', 'multiuser',
        'table public.household_categories',
        to_regclass('public.household_categories') is not null),

    (5, '20260803034033', 'provider_connections',
        'table public.provider_connections',
        to_regclass('public.provider_connections') is not null),

    (6, '20260803035849', 'wise_transactions',
        'table public.wise_transactions',
        to_regclass('public.wise_transactions') is not null),

    (7, '20260804002220', 'email_import',
        'table public.email_import_connections',
        to_regclass('public.email_import_connections') is not null),

    (8, '20260804202613', 'expense_conversion_fields',
        'column expenses.had_currency_conversion',
        exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'expenses'
                   and column_name = 'had_currency_conversion')),

    (9, '20260805182726', 'gmail_import',
        'table public.email_import_oauth_states',
        to_regclass('public.email_import_oauth_states') is not null),

    -- Existence is not enough here. email_import.sql already created an index
    -- under this name, but PARTIAL (`where provider_message_id is not null`),
    -- which PostgREST's bare on_conflict target cannot match -- the bug that
    -- made every Gmail message fail. The fix replaces it with a NON-partial
    -- index of the same name, so "applied" means: exists AND has no predicate.
    (10, '20260806211500', 'email_import_ledger_fix',
        'index email_import_messages_provider_msg_unique is NOT partial',
        exists (select 1 from pg_index i
                  join pg_class c on c.oid = i.indexrelid
                 where c.relname = 'email_import_messages_provider_msg_unique'
                   and i.indpred is null)),

    (11, '20260806215948', 'merchant_category_rules',
        'table public.merchant_category_rules',
        to_regclass('public.merchant_category_rules') is not null)
)
select
  seq,
  version,
  migration,
  object_checked,
  case when present then 'APPLIED' else 'PENDING' end as verdict,
  case when present
       then 'supabase migration repair ' || version || ' --status applied'
       else '(leave unrepaired -- db push will apply it)'
  end as action
from checks
order by seq;
