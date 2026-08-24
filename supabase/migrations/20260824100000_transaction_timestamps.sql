-- OurSpending — authoritative transaction timestamps and household timezone.
--
-- SAFETY: additive and idempotent. One new column on `households`, two on
-- `expenses`, all nullable or defaulted. No table, column, policy, grant,
-- function, index or row is dropped, renamed or rewritten, and no historical
-- expense's spent_on is recalculated.
--
-- WHY
--
-- `spent_on` was derived as `new Date().toISOString().slice(0, 10)` from the
-- SYNC clock, because the Wise parser never produced an occurredAt and Gmail's
-- internalDate -- which the message adapter already carried -- was discarded
-- before it reached the importer.
--
-- Two consequences, both wrong:
--
--   * an expense landed on the day the sync happened to run, not the day the
--     purchase happened. Hourly syncing makes that worse, not better: the same
--     message imported at 00:30 lands a day later than at 23:30.
--   * the day was the UTC day. A purchase at 23:40 in America/Bogota is 04:40
--     UTC the NEXT day, so late-evening spending was systematically filed
--     under tomorrow.
--
-- The instant is now stored as-is, and the calendar day is derived from it in
-- the household's own zone.

-- ---------------------------------------------------------------------------
-- households.timezone
-- ---------------------------------------------------------------------------
-- Deliberately nullable with NO default. NULL means UTC in the importer, which
-- is exactly the behaviour that existed before this column, so applying this
-- migration on its own changes nothing until a household opts in. Set it with:
--
--   update public.households set timezone = 'America/Bogota' where id = '...';
--
-- Any IANA zone name is accepted; the importer falls back to UTC if the zone
-- is unknown rather than failing an import.
alter table public.households
  add column if not exists timezone text;

comment on column public.households.timezone is
  'IANA timezone (e.g. America/Bogota) used to decide which calendar day an '
  'imported transaction falls on. NULL = UTC.';

-- ---------------------------------------------------------------------------
-- expenses.occurred_at / occurred_at_source
-- ---------------------------------------------------------------------------
-- The authoritative instant, plus where it came from. Kept alongside spent_on
-- rather than replacing it: spent_on stays the column the app reads and
-- groups by, and occurred_at explains how that day was arrived at.
--
-- Nullable, and never backfilled: every pre-existing expense predates this and
-- inventing an instant for it would be a claim we cannot support. NULL there
-- honestly means "unknown, this row predates timestamp tracking".
alter table public.expenses
  add column if not exists occurred_at timestamptz,
  add column if not exists occurred_at_source text;

comment on column public.expenses.occurred_at is
  'Authoritative instant the transaction happened. spent_on is this instant '
  'rendered in the household timezone. NULL for rows predating this column.';

comment on column public.expenses.occurred_at_source is
  'Provenance of occurred_at: wise_explicit | gmail_internal_date | '
  'sync_fallback. sync_fallback is the only value not derived from the '
  'transaction itself.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'expenses_occurred_at_source_check'
  ) then
    alter table public.expenses
      add constraint expenses_occurred_at_source_check
      check (
        occurred_at_source is null
        or occurred_at_source in ('wise_explicit', 'gmail_internal_date', 'sync_fallback')
      );
  end if;
end
$$;

-- RLS on `expenses` and `households` already scopes every column on those
-- tables the same way, so no policy changes are needed and none are made.
