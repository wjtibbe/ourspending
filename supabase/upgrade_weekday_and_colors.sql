-- OurSpending: adds "every weekday" recurrence + configurable person/shared
-- colors to an EXISTING install (i.e. you already ran calendar.sql once).
-- Safe, additive, idempotent - run once in the Supabase SQL editor.
--
-- If you are setting up calendar.sql for the very first time, you don't
-- need this file: calendar.sql already includes "weekday" in its recurrence
-- check. This file only exists to upgrade a database that ran the OLD
-- calendar.sql before "weekday" was added.

-- ------------------------------------------------------------------
-- 1) "Every weekday" recurrence option
-- ------------------------------------------------------------------
-- Postgres auto-names an inline column CHECK as "<table>_<column>_check" -
-- exactly what calendar.sql's original `recurrence text ... check (...)`
-- produced. Drop + recreate with "weekday" added to the allowed list.
alter table public.calendar_events
  drop constraint if exists calendar_events_recurrence_check;
alter table public.calendar_events
  add constraint calendar_events_recurrence_check
  check (recurrence in ('none', 'daily', 'weekday', 'weekly', 'biweekly', 'monthly', 'yearly'));

-- ------------------------------------------------------------------
-- 2) Configurable person/shared colors
-- ------------------------------------------------------------------
-- Nullable on purpose: null means "use the app's built-in default color"
-- until the household explicitly picks one in Settings - existing
-- households/rows are visually unchanged until they do.
alter table public.profiles add column if not exists color text;
alter table public.households add column if not exists shared_color text;
