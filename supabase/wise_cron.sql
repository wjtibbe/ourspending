-- OurSpending — hourly Wise import schedule.
--
-- Run this LAST, after supabase/wise_transactions.sql and after the wise-sync
-- Edge Function has been deployed.
--
-- BEFORE RUNNING, replace the two placeholders below:
--   <PROJECT_REF>        your Supabase project ref (the subdomain of your
--                        project URL, e.g. abcdefghijklmno)
--   <SYNC_CRON_SECRET>   the exact value you set as the SYNC_CRON_SECRET
--                        Edge Function secret
--
-- The secret never reaches a browser: it lives in the cron command inside the
-- database and in the function's own environment. The service-role key and the
-- encryption key are not used here at all.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-running this file replaces the schedule rather than stacking duplicates.
select cron.unschedule('wise-hourly-sync')
where exists (select 1 from cron.job where jobname = 'wise-hourly-sync');

select cron.schedule(
  'wise-hourly-sync',
  '7 * * * *',   -- once an hour, at :07, to stay off the busy top of the hour
  $cron$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/wise-sync',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-sync-secret', '<SYNC_CRON_SECRET>'
               ),
    body    := jsonb_build_object('trigger', 'cron'),
    timeout_milliseconds := 120000
  );
  $cron$
);

-- ------------------------------------------------------------
-- Checking on it later
-- ------------------------------------------------------------
-- Is the schedule registered?
--   select jobid, jobname, schedule, active from cron.job;
--
-- Did the last firings succeed? (this is pg_cron's own view, and only tells
-- you the HTTP call was made)
--   select * from cron.job_run_details order by start_time desc limit 10;
--
-- What did the runs actually do? (this is the real answer)
--   select started_at, trigger_source, connections_processed, transactions_fetched,
--          expenses_imported, duplicates_skipped, unsupported_skipped,
--          failed, category_fallbacks
--   from provider_sync_runs order by started_at desc limit 20;
--
-- To pause the job:      select cron.unschedule('wise-hourly-sync');
-- To rotate the secret:  set the new Edge Function secret first, then re-run
--                        this file with the new value.
