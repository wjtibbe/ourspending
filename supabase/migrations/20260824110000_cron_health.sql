-- OurSpending — read-only cron/vault configuration diagnostic.
--
-- SAFETY: additive and idempotent. Creates one function. No table, column,
-- policy, grant, index or row is created, altered, dropped or rewritten, and
-- the function itself only ever reads catalogue metadata.
--
-- WHY
--
-- ensure_gmail_hourly_sync() deliberately no-ops when pg_cron, pg_net or the
-- Vault entries are missing, so an unconfigured project cannot block an
-- unrelated deploy. The cost of that choice is that "configured correctly" and
-- "quietly doing nothing" look identical from outside. This reports which one
-- it is, without ever revealing what the secrets contain.
--
-- SECRECY
--
-- Only EXISTENCE is reported, never a value. The vault columns are probed with
-- `exists(...)`, so no decrypted secret is selected, returned, or written to a
-- log. The cron job's `command` is likewise never returned: it embeds the
-- endpoint and the shared secret by construction.

create or replace function public.gmail_cron_health()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job_name   constant text := 'gmail-hourly-sync';
  v_has_cron   boolean := exists (select 1 from pg_extension where extname = 'pg_cron');
  v_has_net    boolean := exists (select 1 from pg_extension where extname = 'pg_net');
  v_installed  boolean := false;
  v_active     boolean := null;
  v_schedule   text := null;
  v_last_run   timestamptz := null;
  v_last_status text := null;
  v_has_url    boolean := false;
  v_has_secret boolean := false;
begin
  -- Vault: existence only. Never `decrypted_secret`.
  begin
    v_has_url := exists (select 1 from vault.decrypted_secrets where name = 'gmail_sync_url');
    v_has_secret := exists (select 1 from vault.decrypted_secrets where name = 'gmail_sync_secret');
  exception when others then
    v_has_url := false;
    v_has_secret := false;
  end;

  if v_has_cron then
    begin
      select true, j.active, j.schedule
        into v_installed, v_active, v_schedule
        from cron.job j
       where j.jobname = v_job_name
       limit 1;

      -- Run history is optional: cron.job_run_details may be absent or
      -- unreadable depending on the plan. Its absence is not an error.
      begin
        select d.end_time, d.status
          into v_last_run, v_last_status
          from cron.job_run_details d
          join cron.job j on j.jobid = d.jobid
         where j.jobname = v_job_name
         order by d.start_time desc
         limit 1;
      exception when others then
        v_last_run := null;
        v_last_status := null;
      end;
    exception when others then
      v_installed := false;
    end;
  end if;

  return jsonb_build_object(
    'cron_extension_installed', v_has_cron,
    'net_extension_installed',  v_has_net,
    'job_installed',            coalesce(v_installed, false),
    'job_active',               v_active,
    'expected_schedule',        public.gmail_sync_cron_schedule(),
    'actual_schedule',          v_schedule,
    'schedule_matches',         (v_schedule is not distinct from public.gmail_sync_cron_schedule()),
    'last_run_at',              v_last_run,
    'last_run_status',          v_last_status,
    'vault_url_configured',     v_has_url,
    'vault_secret_configured',  v_has_secret,
    -- One field the UI can act on without re-deriving the rules.
    'ready', (
      v_has_cron and v_has_net and coalesce(v_installed, false)
      and v_has_url and v_has_secret
      and (v_schedule is not distinct from public.gmail_sync_cron_schedule())
    )
  );
end
$$;

comment on function public.gmail_cron_health() is
  'Read-only diagnostic for the hourly Gmail sync schedule. Reports whether '
  'pg_cron/pg_net, the cron job and the Vault entries exist, and whether the '
  'installed schedule matches the expected one. Reports EXISTENCE only -- no '
  'secret value and no cron command is ever returned.';

-- Signed-in users may read it (it is the Settings diagnostic); anon may not.
revoke all on function public.gmail_cron_health() from public, anon;
grant execute on function public.gmail_cron_health() to authenticated, service_role;
