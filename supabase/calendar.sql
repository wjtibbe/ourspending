-- OurSpending shared calendar.
-- Safe, additive migration: creates new tables only, touches no existing data.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- Ownership model reuses the existing expense convention:
--   kind = 'shared' | 'p0' | 'p1'   (p0/p1 map to profiles.slot)
--   created_by = auth.users.id      (who actually entered it)

-- ============================================================
--  1. Events
-- ============================================================
create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,

  title text not null,
  description text,
  location text,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,

  -- who the event belongs to; drives the colour coding in the UI
  kind text not null default 'shared' check (kind in ('shared', 'p0', 'p1')),

  -- lightweight recurrence (expanded client-side over the visible range)
  recurrence text not null default 'none'
    check (recurrence in ('none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly')),
  recurrence_until date,

  -- external calendar sync scaffolding (null for locally created events)
  provider text check (provider in ('google', 'apple', 'outlook', 'ics')),
  external_calendar_id text,
  external_event_id text,
  external_etag text,
  sync_status text not null default 'local'
    check (sync_status in ('local', 'pending', 'synced', 'error')),
  last_synced_at timestamptz,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_events_range check (ends_at >= starts_at)
);

create index if not exists calendar_events_household_start_idx
  on public.calendar_events (household_id, starts_at);

-- Dedupe guard: the same external event can never be imported twice.
create unique index if not exists calendar_events_external_unique
  on public.calendar_events (household_id, provider, external_event_id)
  where external_event_id is not null;

alter table public.calendar_events enable row level security;

-- Everyone in the household sees the whole shared calendar.
drop policy if exists "Members can read household events" on public.calendar_events;
create policy "Members can read household events" on public.calendar_events
  for select using (
    household_id = (select household_id from public.profiles where id = auth.uid())
  );

drop policy if exists "Members can create household events" on public.calendar_events;
create policy "Members can create household events" on public.calendar_events
  for insert with check (
    household_id = (select household_id from public.profiles where id = auth.uid())
  );

-- You may edit/delete events you created, plus any event marked as shared.
-- Your partner's private events stay read-only for you.
drop policy if exists "Members can update own or shared events" on public.calendar_events;
create policy "Members can update own or shared events" on public.calendar_events
  for update using (
    household_id = (select household_id from public.profiles where id = auth.uid())
    and (created_by = auth.uid() or kind = 'shared')
  );

drop policy if exists "Members can delete own or shared events" on public.calendar_events;
create policy "Members can delete own or shared events" on public.calendar_events
  for delete using (
    household_id = (select household_id from public.profiles where id = auth.uid())
    and (created_by = auth.uid() or kind = 'shared')
  );

-- Keep updated_at honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists calendar_events_touch on public.calendar_events;
create trigger calendar_events_touch
  before update on public.calendar_events
  for each row execute function public.touch_updated_at();

-- ============================================================
--  2. External calendar connections (per user, not per household)
-- ============================================================
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  provider text not null check (provider in ('google', 'apple', 'outlook', 'ics')),
  account_email text,
  external_calendar_id text,
  external_calendar_name text,

  sync_direction text not null default 'both'
    check (sync_direction in ('import', 'export', 'both')),
  sync_enabled boolean not null default true,
  sync_status text not null default 'disconnected'
    check (sync_status in ('disconnected', 'connected', 'syncing', 'error')),
  last_synced_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, provider, external_calendar_id)
);

alter table public.calendar_connections enable row level security;

-- A connection is personal: only its owner can see or manage it.
drop policy if exists "Users manage own calendar connections" on public.calendar_connections;
create policy "Users manage own calendar connections" on public.calendar_connections
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists calendar_connections_touch on public.calendar_connections;
create trigger calendar_connections_touch
  before update on public.calendar_connections
  for each row execute function public.touch_updated_at();

-- ============================================================
--  3. OAuth tokens — server-side only, never readable by the client
-- ============================================================
create table if not exists public.calendar_oauth_tokens (
  connection_id uuid primary key
    references public.calendar_connections(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS on with NO policies = no anon/authenticated access whatsoever.
-- Only Edge Functions using the service_role key can touch this table.
alter table public.calendar_oauth_tokens enable row level security;
revoke all on public.calendar_oauth_tokens from anon, authenticated;

-- ============================================================
--  4. Live sync between both phones
-- ============================================================
alter publication supabase_realtime add table public.calendar_events;

-- ============================================================
--  5. ICS subscription feed tokens (optional — for calendar-feed function)
-- ============================================================
create table if not exists public.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  token text not null unique,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Members may see/rotate their own household's feed token.
alter table public.calendar_feeds enable row level security;

drop policy if exists "Members manage own household feed" on public.calendar_feeds;
create policy "Members manage own household feed" on public.calendar_feeds
  for all using (
    household_id = (select household_id from public.profiles where id = auth.uid())
  ) with check (
    household_id = (select household_id from public.profiles where id = auth.uid())
  );
