-- OurSpending — historical conversion fields on expenses.
--
-- SAFETY: additive only. Six new nullable/defaulted columns on the existing
-- `expenses` table. No column is dropped, renamed or retyped, no row is
-- rewritten (defaults apply to new rows only), no policy or grant changes --
-- RLS on `expenses` already scopes every one of these columns the same way
-- it scopes amount_orig today.
--
-- Run AFTER supabase/email_import.sql.
-- Then run supabase/verify_expense_conversion_fields.sql.
--
-- ============================================================
--  WHY THIS EXISTS
-- ============================================================
-- A Wise card payment in a foreign currency reports TWO true amounts: what the
-- merchant charged (e.g. 71,362 COP) and what actually left the Wise balance
-- (e.g. 19.76 EUR). `amount_orig`/`currency` already store the deducted
-- amount -- that was correct before this migration and remains correct after
-- it: the deducted amount is, and stays, the authoritative expense amount.
--
-- What was missing is a place to keep the MERCHANT'S amount for display and
-- audit, once per expense, on the row every household member reads. Without
-- it, showing "COP 71,362" next to "€19.76" would mean either inventing a
-- second expense (double counting) or recomputing 71,362 from a CURRENT
-- exchange rate (which silently rewrites a historical transaction every time
-- rates update). Neither is acceptable, so the merchant amount is stored
-- once, at import time, next to the amount it annotates.
--
-- These columns are populated by _shared/import-core.ts and are otherwise
-- inert: manual expenses (added directly by the app) never set them, so
-- `had_currency_conversion` defaults to false and every other new column
-- stays null, exactly like a plain Spotify-style entry today.

alter table public.expenses
  -- The merchant's own amount/currency, kept ONLY as display/audit metadata.
  -- Never the authoritative amount, never summed into a total on its own.
  add column if not exists merchant_amount numeric,
  add column if not exists merchant_currency text,

  -- True only when the merchant amount above is in a DIFFERENT currency from
  -- amount_orig/currency -- i.e. a real conversion happened. A provider that
  -- echoes the same currency in both fields (a direct, unconverted payment)
  -- must not set this, so no merchant amount is invented where none exists.
  add column if not exists had_currency_conversion boolean not null default false,

  -- A fact about the import contract, not a guess: amount_orig/currency is
  -- ALWAYS what left the account, by construction of NormalizedTransaction.
  -- Recorded explicitly so nothing downstream -- a report, a future
  -- migration, a support ticket -- can mistake a later rate update for a
  -- reason to recompute this row. Null for manually entered expenses, which
  -- have no such contract to record.
  add column if not exists amount_authority text,

  -- Audit trail: which integration produced this row, and by which specific
  -- template/path within it. Both null for manual expenses.
  add column if not exists source_provider text,
  add column if not exists conversion_source text;

comment on column public.expenses.merchant_amount is
  'Merchant-charged amount in its own currency, e.g. Wise''s "you spent" figure. Display/audit only -- never the authoritative amount and never summed on its own.';
comment on column public.expenses.merchant_currency is
  'Currency of merchant_amount. Null unless had_currency_conversion is true.';
comment on column public.expenses.had_currency_conversion is
  'True only when merchant_currency differs from currency -- i.e. amount_orig is a real currency conversion of merchant_amount, not an echo of the same figure.';
comment on column public.expenses.amount_authority is
  'Why amount_orig is trusted as-is, e.g. deducted_balance_amount for Wise email imports. Null for manual entries.';
comment on column public.expenses.source_provider is
  'Which integration created this row, e.g. wise. Null for manual entries.';
comment on column public.expenses.conversion_source is
  'Which specific parser/template within source_provider produced this row, e.g. wise_email. Null for manual entries.';

-- No index needed: these columns are read alongside amount_orig on rows
-- already selected by household_id, never filtered or sorted on directly.
