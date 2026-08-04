# Wise email import — setup

Transactions arrive as Wise notification emails instead of via the Wise API
(personal Wise accounts cannot read balance statements). Gmail forwards those
emails to a per-user address; Resend receives them and calls an Edge Function,
which parses the transaction and creates a shared expense.

    Wise card payment → Wise email → Gmail filter+forward
      → Resend inbound (MX) → inbound-email Edge Function
      → parsed → shared expense, correct payer, deduped

**One template is implemented: the completed card payment.** Other Wise
emails (declined, reversed, refunds, converted-currency) still need real
samples — until then those messages are recorded with `status = 'unparsed'`
and no expense is created, nothing is lost, and those rows can be replayed
once each template lands. See §10 at the bottom.

---

## 1. Database

Supabase dashboard → **SQL Editor**, in this order:

1. `supabase/email_import.sql`
2. `supabase/verify_email_import.sql` → expect `EMAIL IMPORT VERIFICATION PASSED`

| Table | Purpose |
|---|---|
| `email_import_connections` | One inbound alias per user. `alias_token` is 20 CSPRNG bytes as hex (160 bits) and encodes nothing — no user id, no household id. SELECT-only for its owner; every write goes through a `SECURITY DEFINER` RPC. |
| `email_import_messages` | The ledger and audit trail. Four partial unique indexes give four independent dedupe layers, plus a **sanitised body retained for 7 days** to diagnose parser failures (see §9). |

---

## 2. DNS

Resend inbound is **catch-all on a domain or subdomain** — any address there
arrives at your webhook. Because your root domain already points at Gmail, use
a **subdomain**, or you will break your normal mail.

| Type | Host | Value | Priority |
|---|---|---|---|
| MX | `inbound.yourdomain.com` | *(value shown in the Resend dashboard)* | must be the **lowest** number present |

If the MX priority is not the lowest, mail will not route to Resend.

---

## 3. Resend configuration

1. Resend → **Domains** → add `inbound.yourdomain.com`, enable receiving, add the MX record above, wait for verification.
2. Resend → **Webhooks** → add an endpoint:
   `https://<PROJECT_REF>.supabase.co/functions/v1/inbound-email`
   subscribed to the **`email.received`** event.
3. Copy the webhook's signing secret (`whsec_…`).
4. Resend → **API Keys** → create a key (`re_…`). This is needed because
   Resend's webhook carries **metadata only**; the body is fetched separately.

---

## 4. Supabase secrets

    supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...
    supabase secrets set RESEND_API_KEY=re_...
    supabase secrets set INBOUND_EMAIL_DOMAIN=inbound.yourdomain.com

Optional:

| Name | Default | Purpose |
|---|---|---|
| `INBOUND_ALIAS_PREFIX` | `wise` | Alias shape. `wise` → `wise-<token>@…`; set to `""` for a bare `<token>@…`. |
| `RESEND_API_BASE` | `https://api.resend.com` | Override for testing. |

The two Resend secrets are **different things**: the webhook secret proves a
request really came from Resend; the API key authorises reading the body.
Neither ever reaches a browser.

---

## 5. Deploy

    supabase functions deploy inbound-email --no-verify-jwt

`--no-verify-jwt` is required: an email provider cannot present a user JWT.
Authenticity comes from the Svix signature instead, which is verified against
the raw request body before anything else is read.

---

## 6. Gmail forwarding — one-time manual setup

This is done **once, by hand**. The app deliberately does not automate Gmail's
confirmation handshake.

1. In the app: **⚙ Settings → Wise email import**. Copy
   your address, e.g. `wise-a1b2c3…@inbound.yourdomain.com`.
2. Gmail → **Settings → Forwarding and POP/IMAP → Add a forwarding address** →
   paste it → **Next → Proceed**.
3. **Gmail now emails a confirmation code to that address.** That code arrives
   at the webhook, not at any inbox you can open — so retrieve it one of these
   ways, easiest first:

   **A. Resend dashboard (simplest).** Resend → **Emails → Received**. Open the
   message from `forwarding-noreply@google.com` and read the code, or click its
   confirmation link directly. Nothing extra to set up.

   **B. Confirm against a normal mailbox first (avoids the problem entirely).**
   Before step 2, add a plain mailbox you control as the forwarding address and
   confirm that. Then create the filter in step 5 pointing at your inbound
   alias. Gmail requires confirmation **per destination address**, so this only
   works if you forward to the confirmed mailbox — use A or C for the alias
   itself.

   **C. Read it from the ledger.** The confirmation is recorded like any other
   message. It is from Google, not Wise, so it is stored as
   `status = 'skipped'`, `skip_reason = 'sender_not_recognised'` — and because
   it failed sender authenticity, its sanitised body is retained for 7 days.
   As the project owner, in the SQL editor:

       select raw_text
       from email_import_messages
       where from_address like '%google.com'
       order by received_at desc
       limit 1;

   The code is in that text. Note this query only works from the SQL editor
   (service role): the app itself cannot read `raw_text` at all.

4. Paste the code back into Gmail and confirm.
5. Gmail → **Settings → Filters → Create a new filter**:
   - **From:** `noreply@wise.com`
   - (optionally narrow further once you know which subjects Wise uses)
   - → **Create filter** → tick **Forward it to:** your inbound alias.

Choose **"Keep Gmail's copy in the Inbox"** so forwarding never deletes your
own mail.

---

## 7. Security model

* **The alias is a bearer secret.** Anyone who learns it can attempt to inject
  expenses — so the function additionally requires the message to come from a
  Wise sending domain (`wise.com`, `transferwise.com`, or a subdomain). Knowing
  the alias alone is not enough. Rotate the alias from Settings at any time.
* **The signature is checked first**, against the raw body, with a 5-minute
  timestamp tolerance so a captured request cannot be replayed later.
* **The user is resolved only from the alias token.** No user id, household id
  or amount is ever taken from the payload.
* **Household and payer are re-derived** from the owner's current profile by
  `import-core.ts` — never from the message, never from a stale row.
* **An unknown alias and a disabled connection return the same response**, so
  the endpoint cannot be used to discover which aliases exist.
* **Logs carry counters only** — no addresses, merchants or amounts.

---

## 8. Checking on it

    -- what has arrived, and what happened to it
    select received_at, status, skip_reason, merchant,
           amount_value, amount_currency, mapped_category
    from email_import_messages
    order by received_at desc limit 50;

    -- anything the parser could not read
    select count(*) from email_import_messages where status = 'unparsed';

---

## 9. Data retention

A **sanitised** copy of each email body is kept for **7 days**, purely so a
parser failure can be diagnosed during rollout. It is constrained three ways:

**Sanitised before storage.** `<script>`, `<style>`, `<iframe>`, and **every
`<img>`** (tracking pixels included) are removed, along with all remote URLs
(`href`/`src`/`srcset`/`url()`), inline event handlers and HTML comments.
Email addresses become `[email]`, card-length digit runs become `[number]`,
IBANs become `[iban]`. Amounts, merchants, dates and references are kept
deliberately — they are the parse targets, and redacting them would defeat the
purpose. Attachments and binary content are **never** stored.

**Unreadable by the app.** Column-level grants omit `raw_text` and `raw_html`,
so no client query can return them — not even the owner's. Privileges are
checked before RLS, so a policy mistake cannot expose them either.

**Cleared automatically.** A successful import purges its body *immediately*
(a message that parsed needs no diagnosis), so in practice only failures
occupy retention at all. Everything else expires after 7 days:

    create extension if not exists pg_cron;
    select cron.schedule(
      'purge-email-raw-content',
      '20 3 * * *',
      $cron$ select public.purge_expired_email_raw_content(); $cron$
    );

Purging removes **only** the body. Message ids, hashes, parsed metadata,
parsing status, the linked expense and the safe error summary all survive — so
history and dedupe are unaffected and a purged message can never re-import.

To purge everything now, regardless of expiry:

    update email_import_messages
       set raw_text = null, raw_html = null, raw_content_expires_at = null
     where raw_text is not null or raw_html is not null;

---

## 10. Current status

| Piece | State |
|---|---|
| Migrations + RLS + 4-layer dedupe | **Done**, verified on PostgreSQL 16 |
| 7-day sanitised retention + purge job | **Done**, verified on PostgreSQL 16 |
| Settings UI (address, copy, status, rotate, disable) | **Done** |
| Wise API path retired from the app | **Done** — see §11 |
| Provider-neutral import core | **Done**, 58 tests |
| Svix signature verification | **Done**, 73 tests incl. replay and tampering |
| Resend adapter (envelope + body fetch) | **Done** |
| Alias resolution / sender authenticity | **Done** |
| Locale-aware money parsing (`45.000` → 45000) | **Done** |
| Wise email field extraction — completed card payment | **Done** |
| Wise email field extraction — declined / reversed / refund / converted-currency | **Not started — needs real anonymised samples** |

The completed-payment template ("You spent *amount currency* at *merchant*."
/ "This used *amount currency* from your account.") is implemented in
`wiseEmailParser` in `supabase/functions/_shared/parse-wise-email.ts`. The
deducted account amount becomes the expense amount; the merchant's own amount
is kept only as metadata. Any other Wise email — declined, reversed, a
refund, a converted-currency notice — still records as `unparsed` until a
real anonymised sample of that template is supplied. To extend the parser,
add a new template branch next to `extractCompletedPayment()`, against:

1. a declined payment email,
2. a reversed/refunded payment email,
3. a converted-currency payment (e.g. COP merchant charged to a USD balance).

Both the plain-text and HTML parts are useful — in Gmail, **⋮ → Show original**.

---

## 11. The old Wise API path

Retired, but **not deleted** — nothing was removed from your Supabase project.

| Thing | State |
|---|---|
| Token field, Connect, Reconnect, Sync now | **Gone from the app.** No UI renders them and nothing calls `provider-connect`. |
| `wise-sync` function | Source kept, marked `OBSOLETE` in its header. Absent from these instructions. |
| `wise_cron.sql` | Source kept, marked `OBSOLETE`. Not part of setup. |
| `PROVIDERS_SETUP.md` | Marked **SUPERSEDED**, kept for rollback. |
| `provider_connections`, `provider_credentials`, `wise_transactions` | Untouched in the database. |
| `PROVIDER_ENCRYPTION_KEY`, `SYNC_CRON_SECRET`, `WISE_SYNC_DAYS` | Untouched. |

An explicit **optional** production cleanup list will be supplied once email
import is confirmed working end to end. Nothing is removed before then, so
rollback stays a redeploy rather than a restore.
