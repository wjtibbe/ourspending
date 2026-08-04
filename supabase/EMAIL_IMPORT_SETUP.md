# Wise email import — setup

Transactions arrive as Wise notification emails instead of via the Wise API
(personal Wise accounts cannot read balance statements). Gmail forwards those
emails to a per-user address; Resend receives them and calls an Edge Function,
which parses the transaction and creates a shared expense.

    Wise card payment → Wise email → Gmail filter+forward
      → Resend inbound (MX) → inbound-email Edge Function
      → parsed → shared expense, correct payer, deduped

**The parser is not implemented yet.** Everything else is. Until real Wise
email samples exist, messages are recorded with `status = 'unparsed'` and no
expense is created — nothing is lost, and those rows can be replayed once
extraction lands. See "Current status" at the bottom.

---

## 1. Database

Supabase dashboard → **SQL Editor**, in this order:

1. `supabase/email_import.sql`
2. `supabase/verify_email_import.sql` → expect `EMAIL IMPORT VERIFICATION PASSED`

| Table | Purpose |
|---|---|
| `email_import_connections` | One inbound alias per user. `alias_token` is 20 CSPRNG bytes as hex (160 bits) and encodes nothing — no user id, no household id. SELECT-only for its owner; every write goes through a `SECURITY DEFINER` RPC. |
| `email_import_messages` | The ledger and audit trail. Four partial unique indexes give four independent dedupe layers. **No raw email body is stored** — only extracted fields, so there is no retention job and nothing to leak beyond what the expense already shows. |

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

1. In the app: **⚙ Settings → Connected accounts → Wise email import**. Copy
   your address, e.g. `wise-a1b2c3…@inbound.yourdomain.com`.
2. Gmail → **Settings → Forwarding and POP/IMAP → Add a forwarding address** →
   paste it → **Next → Proceed**.
3. **Gmail now emails a confirmation code to that address.** It arrives at the
   webhook, not at a mailbox you can read, so retrieve it from the Edge
   Function logs:

       Supabase dashboard → Edge Functions → inbound-email → Logs

   The confirmation message is recorded with `skip_reason =
   'sender_not_recognised'` (it is from Google, not Wise). To read the code,
   temporarily use Resend's dashboard → **Emails → Received**, open the Gmail
   confirmation, and copy the code or click the confirmation link.

   > If you would rather not hunt for it: before step 2, point the forwarding
   > address at a normal mailbox you control, confirm it, and only then switch
   > the Gmail filter to the inbound alias. Gmail only requires confirmation
   > per destination address.

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

## 9. Current status

| Piece | State |
|---|---|
| Migrations + RLS + 4-layer dedupe | **Done**, verified on PostgreSQL 16 |
| Provider-neutral import core | **Done**, 58 tests |
| Svix signature verification | **Done**, 73 tests incl. replay and tampering |
| Resend adapter (envelope + body fetch) | **Done** |
| Alias resolution / sender authenticity | **Done** |
| Locale-aware money parsing (`45.000` → 45000) | **Done** |
| **Wise email field extraction** | **Blocked — needs real anonymised samples** |
| Settings UI showing the address | Not started |
| Retiring the Wise API path | Not started |

To finish the parser, only `extract()` in
`supabase/functions/_shared/parse-wise-email.ts` has to be written, against:

1. a successful Wise card payment email,
2. a declined payment email (if available),
3. a converted-currency payment (e.g. COP merchant charged to a USD balance).

Both the plain-text and HTML parts are useful — in Gmail, **⋮ → Show original**.
