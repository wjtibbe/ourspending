# Wise Gmail import — setup

Wise emails you after every card payment. Those emails already arrive in your
own Gmail, so the app reads them there directly — no inbound domain, no MX
records, no forwarding.

    Wise card payment → Wise email lands in your Gmail
      → daily gmail-sync Edge Function (read-only, narrow search)
      → existing Wise parser → existing import core
      → one shared expense, you as payer, deduped

**Scope:** `gmail.readonly` only. Nothing is ever sent, modified, labelled or
deleted, and the search is restricted to Wise's sender address over an
eight-day window — the app never asks Gmail for, and therefore never sees,
the rest of your mailbox.

---

## 1. Database

Supabase dashboard → **SQL Editor**, in this order:

1. `supabase/email_import.sql` *(if not already applied)*
2. `supabase/expense_conversion_fields.sql` *(if not already applied)*
3. `supabase/gmail_import.sql`
4. `supabase/verify_gmail_import.sql` → expect `GMAIL IMPORT VERIFICATION PASSED`

| Table | Purpose |
|---|---|
| `email_import_connections` | Extended, not replaced. One row per user per input method. A Gmail row has `alias_token IS NULL` and carries `account_email`, `granted_scopes`, `last_checked_at`, `last_synced_at`, `last_error`. SELECT-only for its owner. |
| `email_import_credentials` | **New.** AES-256-GCM encrypted OAuth tokens. RLS on with *zero* policies and all privileges revoked — unreadable by every client, including the owner. |
| `email_import_oauth_states` | **New.** Single-use OAuth `state` + PKCE verifier, bound to one user, 15-minute expiry. Also unreadable by clients. |
| `email_import_messages` | Unchanged. The same four dedupe keys and 7-day sanitised retention now serve Gmail too, with `source = 'gmail'`. |

---

## 2. Google Cloud project

1. <https://console.cloud.google.com/> → **Select a project → New Project**.
   Name it anything (e.g. `ourspending`). No billing account is needed.
2. Note the project — everything below happens inside it.

## 3. Enable the Gmail API

**APIs & Services → Library** → search **Gmail API** → **Enable**.

Without this, OAuth succeeds but every read returns 403.

## 4. OAuth consent screen

**APIs & Services → OAuth consent screen**:

| Field | Value |
|---|---|
| User type | **External** |
| App name | OurSpending (or anything) |
| User support email | your address |
| Developer contact | your address |
| Publishing status | **start in `Testing`** while you set up and confirm the flow works |

Then **Scopes → Add or remove scopes** → add exactly:

    https://www.googleapis.com/auth/gmail.readonly

Do not add any other scope. `gmail.readonly` is a *restricted* scope, which is
why the publishing status matters — see §16, including when and how to move
from `Testing` to `In production` once you're past initial setup.

## 5. Test users

Still on the consent screen: **Audience → Test users → Add users**.

Add the Google account of **every** person who will connect — yours and each
friend's. Up to 100 addresses.

An account that is not listed here cannot complete the flow; it gets
"OurSpending has not completed the Google verification process". Adding a
person later is just adding their address here — no redeploy.

## 6. OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

* Application type: **Web application**
* Name: anything
* **Authorised redirect URIs** → add exactly this, with your project ref:

      https://<PROJECT_REF>.supabase.co/functions/v1/gmail-oauth-callback

It must match character for character — no trailing slash. Google rejects the
whole flow with `redirect_uri_mismatch` otherwise.

Copy the **Client ID** and **Client secret**.

---

## 7. Supabase secrets

    supabase secrets set GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
    supabase secrets set GOOGLE_CLIENT_SECRET=<client secret>
    supabase secrets set GOOGLE_REDIRECT_URI=https://<PROJECT_REF>.supabase.co/functions/v1/gmail-oauth-callback
    supabase secrets set APP_URL=https://<where your app is hosted>
    supabase secrets set SYNC_CRON_SECRET=<base64 of 32 random bytes>
    supabase secrets set PROVIDER_ENCRYPTION_KEY=<base64 of 32 random bytes>

`PROVIDER_ENCRYPTION_KEY` may already be set from the Wise API era — reuse it.
Generate either secret with:

    openssl rand -base64 32

Optional:

| Name | Default | Purpose |
|---|---|---|
| `GMAIL_LOOKBACK_DAYS` | `8` | Search window. The job runs once daily; 8 days gives it room to catch up after a missed run without losing a transaction. Overlap is safe (see §13). |
| `GMAIL_LABEL` | *(none)* | Restrict further to one Gmail label, e.g. `Wise Import`. |

`GOOGLE_CLIENT_SECRET` and the refresh tokens never reach a browser.

---

## 8. Deploy

    supabase functions deploy gmail-oauth-start
    supabase functions deploy gmail-oauth-callback --no-verify-jwt
    supabase functions deploy gmail-sync
    supabase functions deploy gmail-disconnect

`--no-verify-jwt` on the callback only: Google redirects the user's *browser*
there, which carries no Supabase session header. Identity comes from the
single-use, user-bound `state` row instead.

---

## 9. Daily schedule

Run once, after deploying, replacing both placeholders:

    create extension if not exists pg_cron;
    create extension if not exists pg_net;

    select cron.schedule(
      'gmail-daily-sync',
      '25 4 * * *',
      $cron$
      select net.http_post(
        url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/gmail-sync',
        headers := jsonb_build_object(
                     'Content-Type',  'application/json',
                     'x-sync-secret', '<SYNC_CRON_SECRET>'
                   ),
        body    := jsonb_build_object('trigger', 'cron'),
        timeout_milliseconds := 120000
      );
      $cron$
    );

Checks:

    select jobname, schedule, active from cron.job;
    select * from cron.job_run_details order by start_time desc limit 10;

To pause: `select cron.unschedule('gmail-daily-sync');`

---

## 10. Optional: a Gmail label

Not required — the sender+date search is already narrow. Use this if you want
an explicit allowlist you control from Gmail.

1. Gmail → **Settings → Filters → Create a new filter**, From: `noreply@wise.com`
2. Tick **Apply the label**, create one called `Wise Import`
3. `supabase secrets set GMAIL_LABEL="Wise Import"`

The app then reads only messages carrying that label. No forwarding, no
confirmation code, no password.

---

## 11. Manual end-to-end test

1. **⚙ Settings → Wise Gmail import → Connect Gmail.**
2. Google consent screen → pick the account → **Allow**. You return to the app
   with "Gmail connected."
3. Confirm the panel shows the connected address and `Waiting for first sync`.
4. Make a small real Wise card payment (or use one from the last eight days).
5. Press **Sync now**. Expect "Sync finished. 1 new expense(s) imported."
6. Overview → the expense appears: shared, you as payer, the **deducted**
   amount as the headline figure and the merchant amount as the secondary one.
7. Press **Sync now** again → "0 new expense(s)". Nothing duplicates.
8. Check the ledger:

       select received_at, source, status, skip_reason, merchant,
              amount_value, amount_currency, mapped_category
       from email_import_messages order by received_at desc limit 20;

9. **Disconnect** → confirm → the panel returns to "Not connected", and the
   grant disappears from <https://myaccount.google.com/permissions>.

---

## 12. Checking on it later

    -- what arrived and what happened to it
    select received_at, source, status, skip_reason, merchant, amount_value
    from email_import_messages order by received_at desc limit 50;

    -- anything the parser could not read (kept, never lost)
    select count(*) from email_import_messages where status = 'unparsed';

    -- connection health
    select account_email, status, enabled, last_checked_at, last_synced_at, last_error
    from email_import_connections where provider = 'gmail';

---

## 13. Why repeated syncs — and an 8-day overlap — are safe

The job runs once daily, and either half of it can occasionally fail (Gmail
OAuth, or the scheduled invocation itself). An 8-day lookback means each run
re-scans up to a week of mail it has likely already seen, on purpose, so a
missed day or two never loses a transaction. That overlap is safe only
because duplicate protection does not depend on the window being tight — it
is four independent dedupe layers, all scoped to one connection:

| Layer | Key | Catches |
|---|---|---|
| 1 | Gmail message id | the same message re-seen in the overlapping window |
| 2 | RFC 5322 `Message-ID` | the same mail arriving by two routes |
| 3 | Wise transaction reference | two mails about one transaction |
| 4 | deterministic fingerprint | everything else |

Re-scanning the same seven days of mail every day for years is therefore a
no-op, not a risk: nothing here re-imports a transaction because the window
saw it again. Only completed, outgoing Wise card payments become expenses;
declined, reversed, refunds, incoming transfers, marketing and security
alerts are recorded and skipped without creating one.

---

## 14. Rollback

Nothing is destructive, so rollback is a redeploy rather than a restore:

1. `select cron.unschedule('gmail-daily-sync');`
2. Users press **Disconnect** (or `delete from email_import_connections where provider = 'gmail';`)
3. The Resend path is still present and still tested — re-follow
   `supabase/EMAIL_IMPORT_SETUP.md` and redeploy `inbound-email`.

The `gmail_import.sql` migration is additive and idempotent; leaving it applied
costs nothing.

---

## 15. The Resend path

**Inactive, not deleted.**

| Thing | State |
|---|---|
| Settings UI | **Gone.** No forwarding address, inbound domain or Resend config renders. |
| `inbound-email` function | Source kept and still tested. Absent from these instructions. Now shares `_shared/email-import-core.ts` with Gmail, so both produce identical expenses. |
| `_shared/inbound-resend.ts` | Kept, unchanged, still covered by 127 tests. |
| `email_import.sql` | **Still required** — Gmail extends its tables. Do not drop it. |
| `EMAIL_IMPORT_SETUP.md` | Kept as the rollback guide. |

**Optional** production cleanup, once Gmail import is confirmed working — none
of this is required, and each step costs you the rollback path it supports:

* undeploy the `inbound-email` function;
* unset `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY`, `INBOUND_EMAIL_DOMAIN`;
* delete the Resend webhook endpoint and inbound domain in the Resend dashboard;
* remove the MX record for the inbound subdomain;
* `delete from email_import_connections where provider = 'wise_email';`
  (cascades to that connection's ledger rows).

Do **not** drop `email_import_messages`, `email_import_connections`, or the
retention/purge function — Gmail import uses all of them.

---

## 16. Google OAuth publishing status: Testing vs. In production

These are two stages of the **same unverified app** — nothing about the
`gmail.readonly` scope, the consent screen configuration, or the OAuth client
changes between them. Only the **Publishing status** field on the consent
screen (§4) changes. Below is what each stage means and when to move between
them.

### A. Initial testing — Publishing status = `Testing`

Use this while you are setting the app up and confirming it works, per §4–§5
of this guide:

* **Only explicitly listed test users can connect.** Anyone not added under
  **Audience → Test users** gets "OurSpending has not completed the Google
  verification process" and cannot proceed at all — not even to the unverified
  app warning.
* **Refresh tokens may expire after 7 days.** In Testing status, with a
  *restricted* scope like `gmail.readonly`, Google time-limits refresh tokens
  to about seven days regardless of use. Each user must press **Connect
  Gmail** again roughly weekly. The app handles this explicitly rather than
  failing silently: the connection flips to **Reconnect needed**, the sync
  records `reconnect_required`, no partial or wrong data is written, and
  reconnecting resumes cleanly. The default 8-day `GMAIL_LOOKBACK_DAYS`
  window (§7, §13) means even a token that expired right on schedule and is
  reconnected a day or two late still catches everything.
* Maximum 100 test users, added by hand.

Stay here only as long as you are actively testing. It is not the right
long-term state for people you expect to rely on this daily, because of the
weekly reconnect requirement above.

### B. Ongoing private use for fewer than 100 users — Publishing status = `In production`

Once testing looks good, switch **Publishing status** from `Testing` to
`In production` on the OAuth consent screen. This is **not** the same as
completing Google's verification process (§ below) — it is still the same
unverified app, just no longer gated to an explicit test-user list. Nothing
else changes: same scope, same OAuth client, same redirect URI, no code or
deployment change.

What changes in practice:

* **Any Google account can attempt to connect**, not just ones on the test-user
  list — useful once "me and a few friends" is fixed but the friend list
  might grow slightly.
* **Refresh tokens stop expiring on the 7-day Testing-mode timer.** This is
  the main reason to make this switch: it removes the weekly reconnect
  requirement. (Google can still revoke a token for the usual reasons — the
  user revokes access, the password changes, ~6 months of inactivity — the
  `reconnect_required` handling in this app covers that either way.)
* **Users still see the unverified-app warning** during consent —
  "Google hasn't verified this app" — and must click
  **Advanced → Go to OurSpending (unsafe)**. Switching to `In production`
  does not remove this; only completing verification does. Worth telling
  people in advance.
* **The app remains subject to Google's unverified-app user cap: 100 users
  total.** This is a hard ceiling enforced by Google on any unverified app in
  production, distinct from (and not to be confused with) the Testing-mode
  test-user list — it is a cap on how many distinct Google accounts can ever
  grant this app consent. It fits "me and a few friends" with room to spare,
  but it is a real limit, not a formality.

**This is still not verification, and does not substitute for it if you ever
outgrow it.** `In production` + unverified is appropriate for exactly the
scale this app targets — a private tool for you and a handful of people you
know, all willing to click past an unfamiliar-app warning. It is **not**
appropriate for, and does not remove the requirement for, genuine Google
verification if this were ever opened to the general public or scaled past
the 100-user cap. Do not treat the `In production` switch described here as
a substitute for verification in that scenario.

### Getting verified (only if you outgrow B)

Full verification for a restricted Gmail scope means a CASA security
assessment, a published privacy policy, a demo video, and an annual review —
deliberately out of scope for this deployment, and unnecessary for private
use under the 100-user cap.

### Not designed for Workspace admin

No domain-wide delegation, no service account impersonation, in either
Testing or Production. Each user authorises their own mailbox individually.
