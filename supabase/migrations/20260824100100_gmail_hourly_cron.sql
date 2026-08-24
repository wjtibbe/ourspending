-- OurSpending — hourly Gmail sync schedule, managed from the repository.
--
-- SAFETY: additive and idempotent. Creates one function and (when configured)
-- one pg_cron job. No table, column, policy, grant, index or row is dropped or
-- rewritten. Running it repeatedly can never produce a second hourly job.
--
-- WHY A FUNCTION RATHER THAN A BARE cron.schedule()
--
-- The schedule belongs in the repo so it is reviewable and reproducible, but
-- the two values it needs -- the project's function URL and SYNC_CRON_SECRET --
-- must not be. They are read at call time from Supabase Vault instead, so this
-- file is safe to commit and every deploy re-asserts the schedule from it.
--
-- The function is written to be a no-op when anything it depends on is
-- missing (pg_cron, pg_net, the vault entries). A migration that hard-failed
-- on an unconfigured project would block every unrelated deploy, so an
-- unconfigured project gets a NOTICE and an unchanged schedule instead.

-- ---------------------------------------------------------------------------
-- The schedule, in one place
-- ---------------------------------------------------------------------------
-- Hourly, on the hour. Safe to run this often because duplicate protection
-- does not depend on a tight window: dedupe layer 1 claims each Gmail message
-- id before any work, and layers 2-4 (RFC Message-ID, external reference,
-- fingerprint) catch anything that slips past it. An hourly run over an 8-day
-- lookback re-sees the same messages ~192 times and imports each exactly once.
create or replace function public.gmail_sync_cron_schedule()
returns text
language sql
immutable
as $$ select '0 * * * *'::text $$;

comment on function public.gmail_sync_cron_schedule() is
  'The single source of truth for the Gmail sync cron expression. Hourly, on '
  'the hour. Tests assert this exact value.';

-- ---------------------------------------------------------------------------
-- Idempotent (re)installation
-- ---------------------------------------------------------------------------
create or replace function public.ensure_gmail_hourly_sync()
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job_name  constant text := 'gmail-hourly-sync';
  v_url       text;
  v_secret    text;
  v_schedule  text := public.gmail_sync_cron_schedule();
  v_existing  bigint;
begin
  -- Dependencies. Absent on a local or partially provisioned project.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'ensure_gmail_hourly_sync: pg_cron not installed, skipping';
    return 'skipped_no_pg_cron';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'ensure_gmail_hourly_sync: pg_net not installed, skipping';
    return 'skipped_no_pg_net';
  end if;

  -- Configuration, from Vault. Never from this file.
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'gmail_sync_url' limit 1;
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'gmail_sync_secret' limit 1;
  exception when others then
    raise notice 'ensure_gmail_hourly_sync: vault unreadable, skipping';
    return 'skipped_no_vault';
  end;

  if v_url is null or v_secret is null then
    raise notice 'ensure_gmail_hourly_sync: gmail_sync_url/gmail_sync_secret not set, skipping';
    return 'skipped_not_configured';
  end if;

  -- Idempotence: remove any existing job of this name FIRST, so repeated
  -- deploys converge on exactly one job rather than stacking duplicates.
  -- cron.unschedule(name) raises if the job is absent, hence the lookup.
  select jobid into v_existing from cron.job where jobname = v_job_name limit 1;
  if v_existing is not null then
    perform cron.unschedule(v_job_name);
  end if;

  perform cron.schedule(
    v_job_name,
    v_schedule,
    format(
      $cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'Content-Type',  'application/json',
                     'x-sync-secret', %L
                   ),
        body    := jsonb_build_object('trigger', 'cron'),
        timeout_milliseconds := 120000
      );
      $cmd$,
      v_url, v_secret
    )
  );

  return 'scheduled';
end
$$;

comment on function public.ensure_gmail_hourly_sync() is
  'Installs or re-installs the hourly Gmail sync cron job from '
  'gmail_sync_cron_schedule(). Idempotent: always converges on exactly one '
  'job named gmail-hourly-sync. No-ops when pg_cron/pg_net/vault are absent.';

-- Only the service role may re-install the schedule.
revoke all on function public.ensure_gmail_hourly_sync() from public, anon, authenticated;
grant execute on function public.ensure_gmail_hourly_sync() to service_role;
revoke all on function public.gmail_sync_cron_schedule() from public, anon;
grant execute on function public.gmail_sync_cron_schedule() to authenticated, service_role;

-- Re-assert on every deploy. Safe: a no-op when unconfigured, and convergent
-- when configured.
do $$
declare r text;
begin
  r := public.ensure_gmail_hourly_sync();
  raise notice 'ensure_gmail_hourly_sync: %', r;
end
$$;

-- ---------------------------------------------------------------------------
-- ONE-TIME PROJECT SETUP (run once, in the Supabase SQL editor)
-- ---------------------------------------------------------------------------
-- Stores the two values this schedule needs. After this, every deploy
-- re-installs the job automatically and nothing further is manual.
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--
--   select vault.create_secret(
--     'https://<PROJECT_REF>.supabase.co/functions/v1/gmail-sync',
--     'gmail_sync_url',
--     'Gmail sync endpoint for the hourly cron job'
--   );
--   select vault.create_secret(
--     '<the same value as the SYNC_CRON_SECRET function secret>',
--     'gmail_sync_secret',
--     'Shared secret the gmail-sync function compares in constant time'
--   );
--
--   select public.ensure_gmail_hourly_sync();   -- expect: scheduled
--
-- To verify:      select jobname, schedule, active from cron.job where jobname = 'gmail-hourly-sync';
-- To pause:       select cron.unschedule('gmail-hourly-sync');
-- To rotate the secret: vault.update_secret(...) then select public.ensure_gmail_hourly_sync();
