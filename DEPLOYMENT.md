# Deployment

Production deploys are automated. You review and merge a pull request; GitHub
Actions does the rest.

```
Claude pushes a feature branch
        ↓
  PR opened → .github/workflows/pr-checks.yml   (tests, type check, migration hygiene)
        ↓
  You review and merge into main
        ↓
  .github/workflows/deploy.yml  →  Supabase migrations + Edge Functions
        ↓
  Vercel deploys the frontend from main (separate, unchanged)
```

---

## What happens on a pull request

`.github/workflows/pr-checks.yml` runs three parallel jobs. It holds **no
Supabase credentials**, so it cannot deploy anything.

| Job | What it does |
|---|---|
| **Node tests** | Runs every `tests/*.test.ts` and `tests/*.test.js` (757 assertions) |
| **Edge Function type check** | `deno check` on the six active functions |
| **Migration hygiene** | Filenames match `<14-digit-timestamp>_<snake_case>.sql`, timestamps unique and ascending, and no rollback-style `verify_*.sql` has leaked into `supabase/migrations/` |

A failure blocks the merge. Nothing is deployed from a PR.

## What happens after merge to `main`

`.github/workflows/deploy.yml` runs, but only when the merge touched
`supabase/migrations/**`, `supabase/functions/**`, `supabase/config.toml`, or
the workflow itself. A docs-only or frontend-only merge does not spend a
production deploy.

1. **Tests** run again against the merged commit.
2. **Link** to the Supabase project non-interactively (no `supabase login`).
3. **`supabase migration list --linked`** prints local-vs-remote state into the
   log *before* anything is applied.
4. **`supabase db push --linked`** applies **only** migrations not already
   recorded in `supabase_migrations.schema_migrations`. Already-applied files
   are skipped, never re-run.
5. **Edge Functions** deploy from an explicit allowlist of six.

If step 4 fails, step 5 never runs — the schema and the code cannot drift apart
silently. If the tests fail, the deploy job never starts at all.

`concurrency: supabase-production-deploy` with `cancel-in-progress: false`
means two merges cannot deploy at once, and an in-flight deploy is never
interrupted between the migration and the function steps.

---

## Required GitHub Secrets

Create these at **Settings → Secrets and variables → Actions → New repository
secret** in `wjtibbe/ourspending`.

| Secret | Value | Why it is needed |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | A Supabase **personal access token** | Authenticates the CLI to the Management API (function deploys, project link) |
| `SUPABASE_PROJECT_ID` | `cleeaaqyhmevacsfjawi` | Which project to deploy to |
| `SUPABASE_DB_PASSWORD` | Your project's Postgres password | **`db push` opens a direct Postgres connection.** The access token authenticates the *Management API*, not SQL — applying migrations needs real database credentials |

Generate the access token at
**https://supabase.com/dashboard/account/tokens → Generate new token**.
Find or reset the database password at
**Project Settings → Database → Database password**.

The workflow passes all three through the `env:` block only. None is
interpolated into a command line (which would expose it in the runner's process
list), and GitHub masks registered secrets in logs.

### Optional: a `production` environment

`deploy.yml` declares `environment: production`. If you create that environment
under **Settings → Environments** you can add a required reviewer, turning
every production deploy into a second manual approval. Leave it uncreated and
deploys proceed automatically — the workflow works either way.

### Rotating `SUPABASE_ACCESS_TOKEN`

1. Generate a new token at https://supabase.com/dashboard/account/tokens
2. Update the `SUPABASE_ACCESS_TOKEN` secret in GitHub
3. Revoke the old token in the same dashboard
4. Re-run the last deploy (below) to confirm the new token works

Nothing in the repository has to change.

---

## One-time setup you must perform

CI is safe to merge before you do these — `db push` simply has nothing pending
it is allowed to apply until the history is reconciled.

### 1. Reconcile migration history (required, once)

`supabase/migrations/` now contains the eleven historical migrations, but the
production database has **no record** of them: they were applied by hand in the
SQL Editor, long before this migration history existed. Without reconciliation
`db push` would try to run all eleven again.

Run this locally once, with the CLI installed and logged in:

```bash
supabase link --project-ref cleeaaqyhmevacsfjawi
supabase migration list --linked      # shows Local vs Remote side by side
```

Then, for **each migration you have already applied in production**, record it
as applied *without executing it*:

```bash
supabase migration repair --status applied 20260713231102   # groceries
supabase migration repair --status applied 20260727214607   # calendar
supabase migration repair --status applied 20260728035836   # upgrade_weekday_and_colors
supabase migration repair --status applied 20260729012421   # multiuser
supabase migration repair --status applied 20260803034033   # provider_connections
supabase migration repair --status applied 20260803035849   # wise_transactions
supabase migration repair --status applied 20260804002220   # email_import
supabase migration repair --status applied 20260804202613   # expense_conversion_fields
supabase migration repair --status applied 20260805182726   # gmail_import
```

**Deliberately not in that list:**

| Migration | Status |
|---|---|
| `20260806211500_email_import_ledger_fix` | Probably **not** applied in production |
| `20260806215948_merchant_category_rules` | Almost certainly **not** applied |

Both were written but never deployed. Leaving them unrepaired means the first
CI deploy applies them for you — which is exactly the Gmail-sync backlog that
has been sitting undeployed.

**Check before you decide.** `supabase migration list --linked` is the
authority on what production actually has. If it shows either of the last two
as already present, repair them too. If it shows one of the first nine as
*missing*, do not repair that one — let `db push` apply it.

Both pending migrations are additive and idempotent (`create table if not
exists`, `add column if not exists`) and were verified against real
PostgreSQL 16, so applying them is safe either way.

### 2. Verify `verify_jwt` matches the dashboard (recommended, once)

`supabase/config.toml` now declares JWT verification per function, and the next
deploy makes the dashboard match the file. Compare them once at
**Edge Functions → (function) → Details** before merging:

| Function | Declared | Reason |
|---|---|---|
| `gmail-oauth-start` | `true` | Browser-called, user-authenticated |
| `gmail-disconnect` | `true` | Browser-called, user-authenticated |
| `scan-receipt` | `true` | **Has no internal auth.** The gateway is its only protection — `false` would make it an open proxy that burns your `ANTHROPIC_API_KEY` |
| `gmail-oauth-callback` | `false` | Google's redirect cannot carry a JWT; auth is the single-use `state` row |
| `gmail-sync` | `false` | The cron job sends only `x-sync-secret`; the function verifies both that and the browser JWT itself |
| `calendar-feed` | `false` | Calendar apps cannot send a JWT; auth is the per-household URL token |

If any currently differs, that difference is what the next deploy will change.

---

## Routine tasks

### Add a database migration

```bash
supabase migration new add_something_useful
# creates supabase/migrations/<timestamp>_add_something_useful.sql
```

Write additive, idempotent SQL (`if not exists`, `add column if not exists`).
Commit it on a feature branch. Merging applies it. Never edit a migration that
has already been applied in production — write a new one that corrects it.

### Add an Edge Function

1. Create `supabase/functions/<name>/index.ts`
2. Add a `[functions.<name>]` block to `supabase/config.toml` with an explicit
   `verify_jwt`
3. Add `<name>` to the deploy allowlist in `.github/workflows/deploy.yml`
4. Add it to the `deno check` list in `.github/workflows/pr-checks.yml`

The allowlist is intentional: `--all` would revive the obsolete functions
listed below.

### Change `verify_jwt`

Edit the function's block in `supabase/config.toml` and merge. The change is
reviewable in the PR diff rather than being a silent dashboard edit.

Only set `false` for a function that authenticates callers itself.

### Manually trigger a deploy

**Actions → Deploy to Supabase (production) → Run workflow → Branch: main.**
Use this after rotating a secret, or to redeploy unchanged code.

### Roll back a bad deploy

**Functions** — revert the commit and merge; the deploy redeploys the previous
code. For an emergency, deploy a known-good commit locally:

```bash
git checkout <last-good-sha>
supabase functions deploy <name> --project-ref cleeaaqyhmevacsfjawi
```

**Migrations** — there is no automatic down-migration, by design: an automated
rollback of a schema change is how data gets destroyed. Write a new forward
migration that undoes the change, and merge it. Every migration in this repo is
additive, so "undo" is usually dropping a newly added column or index — review
that by hand before merging.

---

## Verification scripts

`supabase/verify_*.sql` are **not** migrations and CI never runs them. Each
wraps itself in a transaction ending in `ROLLBACK`, so it proves a security or
schema property without modifying data. Run them by hand in the SQL Editor when
you want to confirm RLS, retention, or household isolation still holds. See
`tests/README.md` for what each one proves.

`supabase/wise_cron.sql` is marked **OBSOLETE — DO NOT RUN**. It is kept for
history only and is deliberately not a migration.

---

## Optional cleanup list

Nothing here is done automatically. Production functions are never deleted by
CI — review each and act only if you agree.

| Item | Why it is a candidate | Suggested action |
|---|---|---|
| `provider-connect` function | Header: *"OBSOLETE — NOT PART OF THE CURRENT SETUP. DO NOT DEPLOY."* Nothing in `app.js` calls it | If still deployed, delete in the dashboard |
| `wise-sync` function | Same OBSOLETE header. The hourly Wise API sync was retired — personal Wise accounts cannot read balance statements | If still deployed, delete in the dashboard |
| `inbound-email` function | Header: *"INACTIVE — retained as a future/alternate inbound adapter."* Superseded by Gmail OAuth polling | Keep the source for rollback parity; delete the deployed function if you do not want the endpoint live |
| `calendar-feed` in the allowlist | Active (external calendar apps subscribe to it) but not referenced from `app.js` | Confirm you still use the iCal feed; if not, remove it from the allowlist in `deploy.yml` |
| `SYNC_CRON_SECRET` / Wise secrets | Only `gmail-sync` still uses `SYNC_CRON_SECRET`. Wise API tokens are unused since the retirement | Keep `SYNC_CRON_SECRET`; consider revoking unused Wise credentials |
| `i18n.js` "run `supabase/<file>.sql`" hints | Four EN + four ES strings still point at the old paths, now under `supabase/migrations/` | Cosmetic. Reword when convenient — changing user-facing copy in two languages is its own change |

---

## Repository layout

```
supabase/
  config.toml              project ref + per-function verify_jwt
  migrations/              production schema history (CI applies these)
    20260713231102_groceries.sql
    ...
    20260806215948_merchant_category_rules.sql
  functions/               Edge Functions (CI deploys the allowlisted six)
  verify_*.sql             manual/debug only, roll back, never run by CI
  wise_cron.sql            OBSOLETE, kept for history
.github/workflows/
  pr-checks.yml            runs on PRs to main, no credentials
  deploy.yml               runs on merge to main, holds the secrets
```
