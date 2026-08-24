# One-time Supabase setup runbook

Everything in the repository is merged to `main` and deployed by CI/CD. Two
things remain that CI/CD **cannot** do for you, and this is how to finish them.

Run this from a place that has the Supabase CLI authenticated and linked to
project `cleeaaqyhmevacsfjawi` — a Codespace or your own machine. Verify each
step before moving on; nothing here is urgent enough to guess at.

---

## Why these two steps are manual

**The Vault bootstrap** stores the endpoint and the shared cron secret. It
cannot live in a committed migration, because the migration would then contain
the secret in git. `ensure_gmail_hourly_sync()` reads both from Vault at call
time and deliberately no-ops with a NOTICE when they are absent, so an
unconfigured project never blocks an unrelated deploy — the cost is that
somebody has to put them there once.

**The household timezone** is deliberately not hard-coded in a migration. It is
a per-household choice, and it is settable from Settings → Household. The SQL
below is only a fallback if you would rather set it directly.

---

## Step 1 — confirm you are pointed at the right project

```bash
npx supabase migration list
```

Expect project ref `cleeaaqyhmevacsfjawi` and a Local/Remote table. If it says
`LegacyProjectNotLinkedError`, you are not in a linked environment — stop here
and run `npx supabase link --project-ref cleeaaqyhmevacsfjawi` first.

All fifteen migrations up to `20260824110000_cron_health` should show as
applied on Remote. If the last four are local-only, CI/CD has not deployed
them: check **Actions → Deploy to Supabase (production)**, and confirm the
repository variable `PRODUCTION_DEPLOY_ENABLED` is `true`. Prefer re-running
that workflow over `db push` by hand, so `main` stays the source of truth.

## Step 2 — see what is already configured

In the SQL editor:

```sql
select jsonb_pretty(public.gmail_cron_health());
```

This is read-only and reports existence only — never a secret value, never the
cron command (which embeds both the endpoint and the secret).

If the function does not exist, the new migrations have not been applied; go
back to step 1.

Read the result:

| field | meaning |
|---|---|
| `cron_extension_installed` / `net_extension_installed` | pg_cron / pg_net present |
| `vault_url_configured` / `vault_secret_configured` | the two Vault entries exist |
| `job_installed` / `job_active` | the `gmail-hourly-sync` job exists and is on |
| `expected_schedule` / `actual_schedule` / `schedule_matches` | drift detection |
| `ready` | all of the above are true |

If `ready` is already `true`, skip to step 6.

## Step 3 — check the EXISTING function secret first

> **Read this before generating anything.**
>
> `SYNC_CRON_SECRET` very likely already exists as an Edge Function secret from
> the original Gmail setup. **Vault being empty does not mean the function
> secret is empty.** Generating a new secret here would rotate a live value:
> the deployed `gmail-sync` would keep comparing against the old one, and every
> scheduled run would return 401 until both sides matched again.

```bash
npx supabase secrets list
```

That prints names and digests, not values.

* **If `SYNC_CRON_SECRET` is listed** — reuse it. You need its plaintext to put
  the same value into Vault. If you do not have it recorded anywhere, treat it
  as a rotation and follow step 4 for BOTH sides.
* **If it is not listed** — generate one, step 4.

## Step 4 — set the secret (only if needed)

Generate locally, without printing it:

```bash
export CRON_SECRET="$(openssl rand -base64 32)"
```

Set it as the Edge Function secret:

```bash
npx supabase secrets set SYNC_CRON_SECRET="$CRON_SECRET"
```

Then store the SAME value in Vault (SQL editor — paste the value into the
statement; do not echo it to a terminal):

```sql
select vault.create_secret(
  '<the same value as SYNC_CRON_SECRET>',
  'gmail_sync_secret',
  'Shared secret gmail-sync compares in constant time');
```

If you rotated an existing secret, redeploy so the function picks it up:

```bash
npx supabase functions deploy gmail-sync
```

## Step 5 — extensions, URL, and install the schedule

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(
  'https://cleeaaqyhmevacsfjawi.supabase.co/functions/v1/gmail-sync',
  'gmail_sync_url',
  'Gmail sync endpoint for the hourly cron job');

select public.ensure_gmail_hourly_sync();   -- expect: scheduled
```

`ensure_gmail_hourly_sync()` unschedules any existing job of the same name
before scheduling, so running it repeatedly converges on exactly one job. It is
also re-run by every future deploy, which means a drifted schedule self-heals.

## Step 6 — verify

```sql
select jsonb_pretty(public.gmail_cron_health());
```

Expect:

* `ready: true`
* `job_installed: true`, `job_active: true`
* `actual_schedule: "0 * * * *"`, `schedule_matches: true`
* `vault_url_configured: true`, `vault_secret_configured: true`

And exactly one job:

```sql
select jobname, schedule, active from cron.job where jobname = 'gmail-hourly-sync';
```

One row. If you see two, something scheduled outside
`ensure_gmail_hourly_sync()`; remove the stray one with
`select cron.unschedule(<jobid>);` and re-run step 5.

## Step 7 — household timezone

Preferred: **Settings → Household → Household timezone** in the app. The field
suggests the browser's zone when nothing is stored, validates the name, and
never overwrites an existing value without you pressing Save.

To inspect directly (non-sensitive):

```sql
select id, name, timezone from public.households order by created_at;
```

`timezone` NULL means UTC, which files a 23:40 Bogota purchase under the next
day. If exactly one household exists and its timezone is NULL:

```sql
update public.households set timezone = 'America/Bogota' where id = '<id>';
```

**If more than one household exists, do not guess** — set each from its own
Settings page, or pick deliberately by id.

## Step 8 — ledger repair, only if still needed

`supabase/repair_self_deduped_rows.sql` recovers ledger rows that an earlier
bug converted from retryable into terminal `duplicate`. STEP 1 in that file is
read-only; the script defaults to `ROLLBACK`. Change it to `COMMIT` only if the
inspected count looks right. It never touches genuine duplicates or any row
that produced an expense.

Afterwards, run a manual sync from Settings and check
`supabase/ledger_status.sql`.

---

## What "done" looks like

* `gmail_cron_health()` → `ready: true`, one job, `0 * * * *`
* Gmail imports appear without pressing Sync now
* A late-evening purchase lands on the correct local calendar day
* `supabase/ledger_status.sql` shows no rows stuck at `received` / `failed`
