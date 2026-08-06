-- OurSpending — learned household merchant categorisation rules.
--
-- SAFETY: additive/idempotent. One new table, one new nullable column on the
-- existing email_import_messages ledger. No existing table, column, policy,
-- grant, function or row is dropped or modified. `expenses` is untouched.
--
-- Run AFTER supabase/gmail_import.sql (or supabase/email_import.sql, if
-- Gmail was never applied) and supabase/multiuser.sql.
-- Then run supabase/verify_merchant_category_rules.sql.
--
-- ============================================================
--  WHY THIS TABLE EXISTS
-- ============================================================
-- The layered categorisation pipeline (see
-- _shared/merchant-categorization.ts) tries five sources in order:
--
--   1. household_rule  THIS table -- a household's own taught override
--   2. global_rule      the existing provider_category/merchant_category/mcc
--                        mapping in _shared/categories.ts
--   3. keyword           the existing multilingual merchant-name keyword
--                        mapping, also in categories.ts
--   4. ai                Claude text classification, feature-flagged
--   5. fallback          "other"
--
-- A household teaches a rule by editing an imported expense's category and
-- confirming "Always categorize <merchant> as <category>?" in the app. The
-- rule then applies to FUTURE imports only -- historical expenses are never
-- rewritten, by construction: nothing in this migration or the app touches
-- `expenses` rows when a rule is created.
--
-- `category_key` matches the app's existing convention exactly
-- (household_categories.category_key, expenses.category): a plain text
-- key, not a numeric id or a separate slug table. The app has never had a
-- separate "categories" table with its own id space -- built-in categories
-- are a fixed in-code list (APP_CATEGORIES in categories.ts) and a
-- household's custom categories are rows in household_categories keyed the
-- same way. Introducing a second id scheme here would just be a second
-- source of truth to keep in sync with the first, so this column
-- deliberately has no FK and no CHECK restricting it to built-ins --
-- exactly like household_categories.category_key and expenses.category
-- themselves, both of which already accept a household's own custom keys.

-- ============================================================
--  0. Shared helper (idempotent — already created by multiuser.sql)
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
--  1. Learned rules
-- ============================================================
create table if not exists public.merchant_category_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,

  -- The matching key -- see normalizeMerchant() in
  -- _shared/merchant-categorization.ts (mirrored in app.js as
  -- normalizeMerchantForRule(), the same hand-kept-in-sync pattern this repo
  -- already uses for perEur()/fmt() across the Deno/browser boundary).
  normalized_merchant text not null,
  -- The merchant exactly as it appeared, for display in Settings.
  display_merchant text,

  category_key text not null,

  -- How the rule came to exist. 'manual' -- confirmed via the "Always
  -- categorize...?" prompt; 'system' -- reserved for a future seeded/bulk
  -- path; 'ai_confirmed' -- reserved for a future "AI suggested, user
  -- confirmed" path. Only 'manual' is written by anything in this change.
  source text not null default 'manual',

  usage_count integer not null default 1,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint merchant_category_rules_source_check
    check (source in ('manual', 'system', 'ai_confirmed')),
  constraint merchant_category_rules_normalized_not_blank
    check (length(btrim(normalized_merchant)) > 0),
  -- One rule per merchant per household -- a second confirmation for the
  -- same merchant updates the existing rule (and bumps usage_count) rather
  -- than creating an ambiguous second row.
  constraint merchant_category_rules_household_merchant_unique
    unique (household_id, normalized_merchant)
);

alter table public.merchant_category_rules
  add column if not exists household_id uuid references public.households(id) on delete cascade,
  add column if not exists normalized_merchant text,
  add column if not exists display_merchant text,
  add column if not exists category_key text,
  add column if not exists source text not null default 'manual',
  add column if not exists usage_count integer not null default 1,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists merchant_category_rules_household_idx
  on public.merchant_category_rules (household_id);

alter table public.merchant_category_rules enable row level security;

-- Explicit table grants: a newly created table only inherits privileges if
-- the project has ALTER DEFAULT PRIVILEGES configured. Granting here makes
-- the migration self-contained. RLS still decides which rows are visible.
-- No DELETE: nothing in this change needs it, and a bad rule is fixed by
-- updating its category_key, not by removing history of what was taught.
grant select, insert, update on public.merchant_category_rules to authenticated;
grant all on public.merchant_category_rules to service_role;

-- Household members read their own household's rules, and only their own --
-- matches household_categories exactly.
drop policy if exists "merchant rules: read own household" on public.merchant_category_rules;
create policy "merchant rules: read own household" on public.merchant_category_rules
  for select using (household_id = public.my_household());

drop policy if exists "merchant rules: insert own household" on public.merchant_category_rules;
create policy "merchant rules: insert own household" on public.merchant_category_rules
  for insert with check (household_id = public.my_household());

drop policy if exists "merchant rules: update own household" on public.merchant_category_rules;
create policy "merchant rules: update own household" on public.merchant_category_rules
  for update using (household_id = public.my_household())
  with check (household_id = public.my_household());

drop trigger if exists merchant_category_rules_touch on public.merchant_category_rules;
create trigger merchant_category_rules_touch
  before update on public.merchant_category_rules
  for each row execute function public.touch_updated_at();

-- ============================================================
--  2. Explainability: which layer categorised each imported message
-- ============================================================
-- category_source already exists (email_import.sql) and already holds the
-- coarse mapped/fallback flag this feature widens into the full
-- household_rule/global_rule/keyword/ai/fallback vocabulary -- no new column
-- needed for that. category_match is new: the normalized merchant or
-- keyword that produced the match, safe to store (never email content, never
-- an amount, never a token) and useful for auditing why a transaction landed
-- where it did.
alter table public.email_import_messages
  add column if not exists category_match text;

comment on column public.email_import_messages.category_source is
  'Which categorisation layer decided this message''s category: household_rule | global_rule | keyword | ai | fallback. See _shared/merchant-categorization.ts.';
comment on column public.email_import_messages.category_match is
  'The normalized merchant or keyword that matched, when applicable. Never email content, an amount or a token.';

-- The existing column-level grant on email_import_messages already covers
-- category_source; category_match needs adding to the same list so the
-- owner can read it too, exactly like every other extracted field.
grant select (
  id, connection_id, user_id, household_id, source,
  provider_message_id, rfc_message_id, external_ref, fingerprint,
  received_at, from_address, status, skip_reason, error_summary,
  merchant, amount_value, amount_currency,
  merchant_amount_value, merchant_amount_currency, occurred_at,
  mapped_category, category_source, category_match, expense_id,
  raw_content_expires_at, created_at, updated_at
) on public.email_import_messages to authenticated;
