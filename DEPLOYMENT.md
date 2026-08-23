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

> **Production deploys are OFF until you turn them on.** The deploy workflow is
> gated behind a repository variable so that merging this CI setup is not the
> same event as arming it. See [First deploy](#first-deploy-arming-the-pipeline).

---

## What happens on a pull request

`.github/workflows/pr-checks.yml` runs three parallel jobs. It holds **no
Supabase credentials**, so it cannot deploy anything.

| Job | What it does |
|---|---|
| **Node tests** | Every `tests/*.test.ts` and `tests/*.test.js` — 978 assertions |
| **Edge Function type check** | `deno check` on the six active functions |
| **Migration hygiene** | Filenames match `<14-digit-timestamp>_<snake_case>.sql`, timestamps unique and ascending, and no rollback-style `verify_*.sql` has leaked into `supabase/migrations/` |

A failure blocks the merge. Nothing is deployed from a PR.

## What happens after merge to `main`

`.github/workflows/deploy.yml` runs, but only when the merge touched
`supabase/migrations/**`, `supabase/functions/**`, `supabase/config.toml`, or
the workflow itself. A docs-only or frontend-only merge does not spend a
production deploy.

| Job | Behaviour |
|---|---|
| **guard** | Reads the `PRODUCTION_DEPLOY_ENABLED` repository variable. Always runs; never fails the build |
| **test** | Always runs, guard or no guard, so `main` keeps a green/red signal |
| **deploy** | Runs only if `guard` says enabled **and** `test` passed |

The deploy job, in order:

1. Check out the exact merged commit (`ref: github.sha`)
2. Install the Supabase CLI (`supabase/setup-cli@v1`)
3. `supabase link --project-ref …` — non-interactive, no `supabase login`
4. `supabase migration list --linked` — records local-vs-remote state in the log
5. `supabase db push --linked --dry-run` — prints what *would* apply
6. `supabase db push --linked` — applies **only** migrations not already
   recorded in `supabase_migrations.schema_migrations`
7. `supabase functions deploy <name> --project-ref …` for six named functions

If any step fails, the remaining steps are skipped — so **a migration failure
stops the function deploy**, and the database is never left behind code that
assumes it. If the tests fail, the deploy job never starts.

`concurrency: supabase-production-deploy` with `cancel-in-progress: false`
prevents two merges from deploying at once and never interrupts a run between
the migration and function steps.

Deploying never deletes anything: a function that exists in the project but not
in the allowlist is left untouched.

---

## Required GitHub Secrets

**Settings → Secrets and variables → Actions → Secrets tab → New repository
secret**, in `wjtibbe/ourspending`.

| Secret | Value | Where to get it |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token | https://supabase.com/dashboard/account/tokens → **Generate new token** |
| `SUPABASE_PROJECT_ID` | `cleeaaqyhmevacsfjawi` | Your project ref (already known) |
| `SUPABASE_DB_PASSWORD` | Project Postgres password | Dashboard → **Project Settings → Database → Database password** (reset it there if unknown) |

These three are **sufficient**. Nothing else is needed.

### Is `SUPABASE_DB_PASSWORD` really required?

Yes, in this setup.

`SUPABASE_ACCESS_TOKEN` authenticates the **Management API** — that is what
`functions deploy` uses. It does not grant SQL execution. `supabase db push`
opens a **direct PostgreSQL connection** to run migration SQL, which needs real
database credentials. `supabase link` also asks for the password so `db push`
can reuse it in the same job.

Both are supplied through the `env:` block. Neither is ever interpolated into a
command line (which would expose it in the runner's process list), and GitHub
masks registered secrets in log output.

### The one repository VARIABLE

**Settings → Secrets and variables → Actions → Variables tab → New repository
variable.** This is a *variable*, not a secret — it holds no sensitive value.

| Variable | Value | Effect |
|---|---|---|
| `PRODUCTION_DEPLOY_ENABLED` | `true` | Arms production deploys |

The guard is fail-closed: only the exact lowercase string `true` arms it.
Unset, empty, `false`, `TRUE` and `1` all leave deploys off. Afterwards it stays
a kill switch — set it to anything else to halt production deploys immediately,
with no code change and no revert.

### Optional: a `production` environment

`deploy.yml` declares `environment: production`. If you create that environment
under **Settings → Environments** you can add a required reviewer, making every
production deploy a manual approval. Leave it uncreated and deploys proceed
automatically — the workflow works either way.

### Rotating `SUPABASE_ACCESS_TOKEN`

1. Generate a new token at https://supabase.com/dashboard/account/tokens
2. Update the `SUPABASE_ACCESS_TOKEN` secret in GitHub
3. Revoke the old token in the same dashboard
4. **Actions → Deploy to Supabase (production) → Run workflow** to confirm

Nothing in the repository changes.

---

## One-time setup

Do these in order. Until step 4, production is untouched no matter what you
merge.

### Step 1 — Find out what production actually has

`supabase/migrations/` holds eleven migrations that were originally applied **by
hand** in the SQL Editor, so the project has no record of them.
`supabase migration list` will therefore report all eleven as local-only, and
**cannot** tell you which are genuinely already applied.

Run **`supabase/baseline_status.sql`** in the Supabase SQL Editor. It is pure
`SELECT` — it creates, alters and drops nothing, and is safe on production. For
each migration it checks whether that migration's distinctive schema object
exists, and prints a verdict plus the exact command to run:

| verdict | meaning | what to do |
|---|---|---|
| `APPLIED` | the object exists — production already has this migration | repair it as applied |
| `PENDING` | the object is missing | leave it; `db push` will apply it |

Row 10 (`email_import_ledger_fix`) is checked more precisely than the others:
`email_import.sql` already created an index of that name but **partial**, which
is the bug that made every Gmail message fail. So "applied" there means the
index exists *and has no `WHERE` predicate*. Verified against PostgreSQL 16 in
both states.

**Expected outcome**, based on the repository history — confirm against the
script's real output rather than trusting this table:

| # | Version | Migration | Expected |
|---|---|---|---|
| 1 | `20260713231102` | groceries | APPLIED |
| 2 | `20260727214607` | calendar | APPLIED |
| 3 | `20260728035836` | upgrade_weekday_and_colors | APPLIED |
| 4 | `20260729012421` | multiuser | APPLIED |
| 5 | `20260803034033` | provider_connections | APPLIED |
| 6 | `20260803035849` | wise_transactions | APPLIED |
| 7 | `20260804002220` | email_import | APPLIED |
| 8 | `20260804202613` | expense_conversion_fields | APPLIED |
| 9 | `20260805182726` | gmail_import | APPLIED |
| 10 | `20260806211500` | email_import_ledger_fix | APPLIED — Gmail imports were working, which this fix is required for |
| 11 | `20260806215948` | merchant_category_rules | **PENDING** — written but never deployed |
| 12 | `20260819120000` | email_import_retry_state | **PENDING** — new, adds retry diagnostics |

### Step 2 — Repair the already-applied migrations

Locally, with the CLI installed:

```bash
supabase link --project-ref cleeaaqyhmevacsfjawi
```

Then run one `repair` per migration the script marked **APPLIED**. This records
it as applied **without executing it**:

```bash
supabase migration repair 20260713231102 --status applied   # groceries
supabase migration repair 20260727214607 --status applied   # calendar
supabase migration repair 20260728035836 --status applied   # upgrade_weekday_and_colors
supabase migration repair 20260729012421 --status applied   # multiuser
supabase migration repair 20260803034033 --status applied   # provider_connections
supabase migration repair 20260803035849 --status applied   # wise_transactions
supabase migration repair 20260804002220 --status applied   # email_import
supabase migration repair 20260804202613 --status applied   # expense_conversion_fields
supabase migration repair 20260805182726 --status applied   # gmail_import
supabase migration repair 20260806211500 --status applied   # email_import_ledger_fix
```

**Do not repair `20260806215948` (merchant_category_rules).** Leaving it
unrepaired is what lets the first deploy apply it — it is the learned-merchant
categorisation table that has been sitting undeployed.

If the script marked any of the ten above as `PENDING`, drop that line and let
`db push` apply it instead. If it marked `20260806215948` as `APPLIED`, add it.
**The script's output wins over this list.**

> Why this matters concretely: `20260713231102_groceries.sql` is the one
> migration that is *not* idempotent — it uses a bare `create policy`, so
> re-running it against a database that already has it fails with
> `policy "Members can read groceries" for table "groceries" already exists`.
> That failure is safe (it aborts, it does not destroy anything) but it would
> break a deploy. Repairing it correctly is what prevents that.

### Step 3 — Verify the baseline

```bash
supabase migration list --linked
```

Expected: every repaired migration now shows a version in **both** the Local and
Remote columns; only the genuinely pending one is local-only.

```bash
supabase db push --linked --dry-run
```

Expected: it lists **only** the pending migration(s) — normally just
`20260806215948_merchant_category_rules.sql`. If the dry run lists anything you
believe is already applied, stop and re-check Step 1; do not proceed.

### Step 4 — Arm production deploys

Only after Step 3 looks right:

**Settings → Secrets and variables → Actions → Variables → New repository
variable** → name `PRODUCTION_DEPLOY_ENABLED`, value `true`.

Then either merge a change, or trigger it by hand:
**Actions → Deploy to Supabase (production) → Run workflow → Branch: main.**

The run's own log shows `migration list` and a `db push --dry-run` before it
applies anything, so you get one final look.

### Step 5 — Check `verify_jwt` (recommended)

`supabase/config.toml` now declares JWT verification per function, and the first
deploy makes the project match the file.

| Function | Declared | Reason |
|---|---|---|
| `gmail-oauth-start` | `true` | Browser-called, user-authenticated |
| `gmail-disconnect` | `true` | Browser-called, user-authenticated |
| `scan-receipt` | `true` | **Has no internal auth.** The gateway is its only protection — `false` would make it an open proxy that burns your `ANTHROPIC_API_KEY` |
| `gmail-oauth-callback` | `false` | Google's redirect cannot carry a JWT; auth is the single-use `state` row |
| `gmail-sync` | `false` | See below |
| `calendar-feed` | `false` | Calendar apps cannot send a JWT; auth is the per-household URL token |

**`gmail-sync` is a deliberate change from how production was set up.**
`GMAIL_SETUP.md` §8 deployed it with JWT verification **on**, but the daily
`pg_cron` job posts only `Content-Type` and `x-sync-secret` — no `Authorization`
header at all. The gateway therefore rejects every scheduled run with 401 before
the function is reached, which is why automatic Gmail syncing stopped while the
manual "Sync now" button (a browser call, which does carry a JWT) kept working.

This does not weaken authentication. `gmail-sync` authenticates both of its
callers itself: a constant-time comparison of `x-sync-secret` for cron, and
`currentUser()` for the browser. Both return 401 before touching data.

---

## Routine tasks

### Add a database migration

```bash
supabase migration new add_something_useful
# creates supabase/migrations/<timestamp>_add_something_useful.sql
```

Write additive, idempotent SQL (`create table if not exists`,
`add column if not exists`, and `drop policy if exists` before `create policy` —
see the groceries note above). Commit it on a feature branch. Merging applies
it. Never edit a migration that has already been applied in production; write a
new one that corrects it.

### Add an Edge Function

1. Create `supabase/functions/<name>/index.ts`
2. Add a `[functions.<name>]` block to `supabase/config.toml` with an explicit
   `verify_jwt`
3. Add `<name>` to the deploy allowlist in `.github/workflows/deploy.yml`
4. Add it to the `deno check` list in `.github/workflows/pr-checks.yml`

The allowlist is intentional. A bare `supabase functions deploy` with no name
deploys *every* folder under `supabase/functions/`, including three whose own
headers say they must not be deployed.

### Change `verify_jwt`

Edit the function's block in `supabase/config.toml` and merge. The change shows
up in the PR diff instead of being a silent dashboard edit. Only set `false` for
a function that authenticates callers itself.

### Manually trigger a deploy

**Actions → Deploy to Supabase (production) → Run workflow → Branch: main.**
Requires `PRODUCTION_DEPLOY_ENABLED` to be `true`.

### Roll back a bad deploy

**Functions** — revert the commit and merge; the deploy redeploys the previous
code. For an emergency, from a known-good commit locally:

```bash
git checkout <last-good-sha>
supabase functions deploy <name> --project-ref cleeaaqyhmevacsfjawi
```

To stop all further automatic deploys immediately, set
`PRODUCTION_DEPLOY_ENABLED` to `false`.

**Migrations** — there is no automatic down-migration, by design: an automated
rollback of a schema change is how data gets destroyed. Write a new forward
migration that undoes the change, and merge it. Every migration in this repo is
additive, so "undo" is usually dropping a newly added column, index or table —
review that by hand before merging.

---

## The Gmail discovery diagnostic

A read-only probe on `gmail-sync`. It claims and writes no ledger row, creates
no expense, and touches neither categorisation, retry state nor the parser. It
asks Gmail one deliberately literal question — `from:noreply@wise.com
newer_than:2d`, hard-coded and NOT derived from the production query — so the
answer cannot be blamed on the query's own sender list or lookback.

Invoke it from the browser console while signed in to the app:

```js
const { data, error } = await window.db.functions.invoke("gmail-sync", {
  body: { mode: "diagnose" },
});
console.log(error ?? data);
```

It requires a signed-in user's JWT and reports only that user's own
connection. The cron path refuses it with `diagnose_requires_user_auth`,
because on that path the connection list is everyone's and the report names a
mailbox address.

### Reading the result

| Field | Meaning |
|---|---|
| `profileEmailAddress` | The mailbox Gmail says the stored token belongs to (`users.getProfile`) |
| `accountMatchesProfile` | Whether the stored `account_email` still matches it. `null` = nothing stored to compare |
| `queryUsed` | Always `from:noreply@wise.com newer_than:2d` |
| `gmailResultSizeEstimate` | Gmail's own total for that query |
| `gmailMessagesListed` | Ids actually fetched |
| `gmailPagesFetched` | List calls made |
| `gmailMoreAvailable` | True only if the page cap truncated the run |
| `newestMatchingInternalDate` | ISO timestamp of the most recent match, or `null` |
| `oldestMatchingInternalDate` | ISO timestamp of the oldest match, or `null` |
| `error` | `reconnect_required`, `no_credential`, or a sanitised code |

What the combinations mean:

* **`accountMatchesProfile: false`** — the token belongs to a different mailbox
  than the one being watched. That alone explains missing mail; nothing else
  needs to be true.
* **`gmailMessagesListed: 0`, `gmailResultSizeEstimate: 0`** — for this token,
  Gmail has nothing from `noreply@wise.com` in two days. The mail is not
  reachable through this credential.
* **`newestMatchingInternalDate` older than the messages you can see** — Gmail
  is serving a stale or partial view to the API.
* **listed > 0 and recent** — discovery is healthy, and the problem is
  downstream of it.

No subject, body, merchant, amount, message id or token is returned. Message
dates are read with `format=minimal`, so no header or body is ever fetched;
tests assert that a body snippet planted in the Gmail response cannot appear in
the report.

---

## Verification scripts

`supabase/verify_*.sql` are **not** migrations and CI never runs them. Each
wraps itself in a transaction ending in `ROLLBACK`, so it proves a security or
schema property without modifying data. Run them by hand in the SQL Editor to
confirm RLS, retention or household isolation still holds. See `tests/README.md`
for what each proves.

`supabase/baseline_status.sql` is read-only introspection, used once for the
baseline above. It is also safe to re-run any time you want to confirm which
migrations production has.

`supabase/ledger_status.sql` is read-only introspection of the email import
ledger: how many messages sit in each state, which of them will be retried on
the next sync versus which are terminal, how many are retryable but have aged
out of the Gmail lookback window, and which keep failing. It returns only
counts and states — never a subject, merchant, amount or token. Run it when a
sync reports imports you did not expect, or no imports at all.

### Replaying messages stuck before the retry fix

Ledger rows left at `received`, `failed` or `unparsed` are retried
automatically by the next sync — no SQL, and no rows are deleted or rewritten.
The only limit is the Gmail search window: `gmail-sync` asks Gmail for
`newer_than:8d`, so a stuck message older than that is not re-fetched and
therefore not retried.

`ledger_status.sql` reports exactly that count as
`retryable_but_outside_lookback`. If it is greater than zero and you want those
recovered, widen the window for one run:

1. Set the `GMAIL_LOOKBACK_DAYS` secret on the project to cover the age of the
   oldest stuck row (e.g. `30`).
2. Run a manual sync from the app, or
   **Actions → Deploy to Supabase (production) → Run workflow**.
3. Confirm with `ledger_status.sql` that the stuck counts have dropped.
4. Set `GMAIL_LOOKBACK_DAYS` back to `8`.

Nothing is deleted at any point, and re-running is safe: a message that did
import is terminal from then on.

`supabase/wise_cron.sql` is marked **OBSOLETE — DO NOT RUN**. It is kept for
history and is deliberately not a migration.

---

## Known limitation: the repo cannot rebuild a database from scratch

`households`, `profiles`, `expenses` and `budgets` were created by hand in the
dashboard early on and were never committed. All eleven migrations are
increments on top of that uncommitted base.

Confirmed empirically: applying all eleven to an empty PostgreSQL 16 database
fails, because they reference base tables and the `supabase_realtime`
publication that nothing in the repo creates.

Consequences:

* PR checks validate migration **hygiene**, not a full fresh-database replay.
* You cannot stand up a new environment from this repo alone.

To close the gap when convenient, capture the current schema once:

```bash
supabase db dump --linked -f supabase/migrations/<earlier-timestamp>_baseline.sql
```

…then repair that baseline as applied too. Not required for the CI/CD pipeline
to work.

---

## Optional cleanup list

Nothing here is automatic. CI never deletes a production function — review each
and act only if you agree.

| Item | Why it is a candidate | Suggested action |
|---|---|---|
| `provider-connect` function | Header: *"OBSOLETE — NOT PART OF THE CURRENT SETUP. DO NOT DEPLOY."* Not called from `app.js` | If still deployed, delete in the dashboard |
| `wise-sync` function | Same OBSOLETE header. The hourly Wise API sync was retired — personal Wise accounts cannot read balance statements | If still deployed, delete in the dashboard |
| `inbound-email` function | Header: *"INACTIVE — retained as a future/alternate inbound adapter."* Superseded by Gmail OAuth polling | Keep the source for rollback parity; delete the deployed function if you do not want the endpoint live |
| `calendar-feed` in the allowlist | Active — external calendar apps subscribe to it — but not referenced from `app.js` | Confirm you still use the iCal feed; if not, remove it from the allowlist |
| Wise API credentials | Unused since the Wise API sync was retired. `SYNC_CRON_SECRET` is still used by `gmail-sync` | Keep `SYNC_CRON_SECRET`; consider revoking unused Wise tokens |
| `i18n.js` setup hints | Four EN + four ES strings still say "run `supabase/<file>.sql`" with pre-move paths | Cosmetic. Reword when convenient — user-facing copy in two languages is its own change |

---

## Repository layout

```
supabase/
  config.toml              project ref + per-function verify_jwt
  migrations/              production schema history (CI applies these)
    20260713231102_groceries.sql
    …
    20260806215948_merchant_category_rules.sql
  functions/               Edge Functions (CI deploys the allowlisted six)
  baseline_status.sql      read-only: which migrations production already has
  verify_*.sql             manual/debug only, roll back, never run by CI
  wise_cron.sql            OBSOLETE, kept for history
.github/workflows/
  pr-checks.yml            runs on PRs to main, holds no credentials
  deploy.yml               runs on main, guarded, holds the secrets
```
