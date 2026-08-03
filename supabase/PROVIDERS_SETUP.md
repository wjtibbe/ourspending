# Connected accounts setup (Wise)

Settings → **Connected accounts** lets each user link their own external
account. Today that means Wise, via a Wise Personal Access Token. Revolut,
PayPal and Stripe are shown as *Soon* and are wired to the same machinery.

Completed outgoing Wise transactions are imported as expenses automatically,
once an hour — see [The hourly import](#the-hourly-import).

---

## 1. Database (required — do this first)

Supabase dashboard → **SQL Editor** → New query → paste each file below and
**Run**, in this order:

1. `supabase/provider_connections.sql` — the connection + credential tables
2. `supabase/wise_transactions.sql` — the import ledger and the run log
3. `supabase/wise_cron.sql` — the hourly schedule (do this **last**, after the
   Edge Functions are deployed and the secrets are set)

The migrations are additive only: they create new tables and change nothing
that already exists. `expenses` is not altered — an imported expense is an
ordinary expense row.

| Table | Purpose |
|---|---|
| `provider_connections` | One row per (user, provider). Non-secret metadata only: status, account label, masked hint, timestamps. A user may `SELECT` their own rows; `INSERT`/`UPDATE`/`DELETE` are revoked, so every change must go through the Edge Function. |
| `provider_credentials` | The access token, **encrypted**. RLS on, **no policies**, all privileges revoked from `anon` and `authenticated` — the same shape as `calendar_oauth_tokens`. Never reachable from a browser. |
| `wise_transactions` | The import ledger: one row per Wise movement, imported or not. `unique (connection_id, wise_reference)` is what makes the hourly job idempotent. SELECT-only for its owner. |
| `provider_sync_runs` | Per-run counters. RLS on, no policies — server-side only. |

Then verify, which proves the guarantees rather than assuming them:

    -- SQL Editor → paste supabase/verify_provider_connections.sql → Run
    -- Expect: PROVIDER VERIFICATION PASSED
    -- SQL Editor → paste supabase/verify_wise_transactions.sql → Run
    -- Expect: WISE LEDGER VERIFICATION PASSED

It runs inside a transaction that ends in `ROLLBACK`, so it cannot touch real
data.

> **Note:** `supabase/multiuser.sql` depends on `public.touch_updated_at()`,
> which is created by `supabase/calendar.sql`. If you have not run
> `calendar.sql` yet, run it before `multiuser.sql`, or `multiuser.sql` will
> stop partway through. `provider_connections.sql` creates that function
> itself, so it is safe to run in any order.

---

## 2. Encryption key (required)

The token is encrypted with AES-256-GCM before it is stored. Generate a key:

    openssl rand -base64 32

Supabase dashboard → **Edge Functions** → **Secrets** → add:

| Name | Value |
|---|---|
| `PROVIDER_ENCRYPTION_KEY` | the base64 string you just generated |

Keep this key. Without it, stored tokens cannot be decrypted and every
connection has to be re-made. There is deliberately **no** plaintext fallback:
if the key is missing, connecting fails with a clear message rather than
silently storing a bare token.

The hourly job needs its own shared secret. Generate and add it too:

    openssl rand -base64 32

| Name | Value |
|---|---|
| `SYNC_CRON_SECRET` | the second base64 string |

Optional:

| Name | Value |
|---|---|
| `WISE_API_BASE` | `https://api.sandbox.transferwise.tech` for the Wise sandbox |
| `WISE_SYNC_DAYS` | statement window in days (default 14). Set to `90` for one catch-up run, then remove it. |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform — do not add them by hand.

---

## 3. Deploy the Edge Function

    supabase functions deploy provider-connect
    supabase functions deploy wise-sync --no-verify-jwt

`provider-connect` keeps **Verify JWT ON** (the default): every action requires
a signed-in user.

`wise-sync` must be deployed with **Verify JWT OFF**, because pg_cron calls it
from inside Postgres and cannot mint a user JWT. It authenticates instead on
the `x-sync-secret` header, compared in constant time. Without a valid secret it
returns 403 and does nothing.

Both share one synchronisation core (`supabase/functions/_shared/sync.ts`), so
"Sync now" and the hourly job cannot drift apart.

---

## 4. Using it

1. Wise → **Settings → API tokens** → create a token (read access is enough).
2. In the app: **⚙ Settings → Connected accounts → Connect** on the Wise card.
3. Paste the token and confirm.

The app calls the Edge Function, which checks the token against `GET /v1/me`
only — no profile listing, no balance access, no business-profile requirement,
since none of that is needed merely to prove a token works. It stores the
token encrypted and returns only metadata. The card then shows the account
name from `/v1/me` and the last four characters of the token.

A rejected token comes back as one of four distinct reasons rather than one
generic failure: `token_refused` (401 — wrong or revoked token),
`token_forbidden` (403 — the token doesn't have permission for this),
`wise_rate_limited` (429 — try again shortly), or
`wise_temporarily_unavailable` (5xx or a network failure — Wise's side, not
yours). `/v1/profiles`, balances and statements are only ever requested later,
by **Sync now** and the hourly job — never at connect time.

To replace a token, press **Reconnect** and paste the new one — the old one is
overwritten. **Disconnect** deletes the connection and, by cascade, the stored
token.

---

## The hourly import

Once `supabase/wise_cron.sql` is run (with your project ref and secret filled
in), pg_cron calls `wise-sync` at **:07 past every hour**. No browser session is
involved, and nothing is stored in localStorage.

Each run, for every connected Wise account:

1. decrypts that connection's token server-side;
2. lists the token's profiles and balances;
3. reads each balance statement for the last `WISE_SYNC_DAYS` days;
4. records every movement in `wise_transactions`, keyed by Wise's own
   `referenceNumber` (or its transaction `id` when there is no reference),
   scoped to the profile and balance it came from, so a movement is only ever
   processed once;
5. creates an expense for completed **outgoing** movements only.

Skipped, with the reason stored on the ledger row: pending, reversed,
cancelled, declined and failed statuses; incoming payments; balance
conversions and top-ups; and any balance currency the app does not support
(it holds rates for EUR, USD and COP only — an unsupported currency is
skipped as `unsupported_currency_<CUR>`, never converted with a guessed rate).

A transaction carrying **neither** a `referenceNumber` nor an `id` is never
imported: without a stable key a later run could create the same expense
twice. It is logged as `missing_stable_id`, counted, and the run carries on. If
`missing_stable_id` is ever non-zero, those few transactions need entering by
hand — check the function logs for the balance they came from.

A failure is always contained: one bad transaction does not stop the rest of
the statement, and one broken connection does not stop other users'.

**"Sync now" runs exactly the same code**, scoped to your own connection, and
reports how many expenses it imported.

### Who the expense belongs to

Imported expenses are **shared household expenses**, using the app's existing
convention: `kind = "shared"` so the household splits it, and `payer` set to
the slot of the member who owns the Wise connection. The slot is read from that
user's own profile — a `p0` owner imports with `payer = 0`, a `p1` owner with
`payer = 1`. It is never assumed: if the slot cannot be resolved the connection
is skipped rather than risk attributing the spend to the wrong member.

Every imported expense is fully editable afterwards in the normal expense
screen, so anything that should have been private can be changed there.

### Which amount is used

The expense uses **the amount actually deducted from your Wise balance**, in
that balance's currency — not what the merchant charged. When you pay a
Colombian merchant in COP from a USD balance, the expense is the USD figure;
the COP figure is kept as optional metadata on the ledger row.

Each row records `amount_source_path` — the exact payload field the figure came
from — so the choice is auditable rather than assumed:

    select amount_source_path, amount_low_confidence, count(*)
    from wise_transactions group by 1, 2;

Expect `amount` for essentially every row. Anything showing `details.amount`
(the low-confidence fallback) is worth a look.

### Categories

Wise's own category is mapped onto a category the app **already has**. Nothing
is ever copied in verbatim and no category is ever created. Matching is
case- and accent-insensitive across English, Spanish and Dutch, so `Transport`,
`Transporte`, `Vervoer`, `Taxi` and `Ride sharing` all resolve to the one
existing `transport` category. Merchant category and MCC are used next, the
description last, and anything unrecognised becomes `other`.

A category the household has switched off is never resurrected — such a
transaction lands on `other` instead. Categorisation never blocks an import.

There is **no AI in this path**. `scan-receipt` (Claude Vision) is image-only
and is untouched; Wise transactions are structured JSON and are never sent to
it.

### Checking on a run

    select started_at, trigger_source, connections_processed, transactions_fetched,
           expenses_imported, duplicates_skipped, unsupported_skipped,
           failed, missing_stable_id, category_fallbacks
    from provider_sync_runs order by started_at desc limit 20;

Why something was skipped:

    select occurred_at, import_status, skip_reason, mapped_category, category_source
    from wise_transactions order by occurred_at desc limit 50;

---

## Security model

* **The token is write-only.** After submission there is no API path, no
  policy and no column that returns it to a browser. The UI only ever shows
  the last four characters, stored separately as `secret_hint`.
* **Nothing is kept in the browser.** The token lives in one React component's
  state and is discarded when the dialog closes. It is never written to
  `localStorage` or `sessionStorage`.
* **The client cannot choose who a connection belongs to.** The Edge Function
  takes `user_id` from the verified JWT and reads `household_id` from that
  user's own `profiles` row. Neither is accepted from the request body.
* **Encrypted at rest.** The database stores ciphertext, a per-write random
  IV, and a key version. A database dump alone does not yield a usable token.
* **Service-role stays server-side.** It is used only inside the Edge
  Function, exactly as in `calendar-feed`.
* **Connections are private to the user**, not shared with the household —
  a household member cannot see that you linked a bank account. The same
  applies to `wise_transactions`: its only policy is `user_id = auth.uid()`.
* **The household is re-derived on every run** from the owner's current
  profile, never read from the connection row and never taken from a request,
  so a membership change cannot route transactions into a household the user
  has left.
* **The cron secret is not the service-role key.** `wise-sync` never receives
  the service-role key or the encryption key from the caller; it reads its own
  from Edge Function secrets. Neither ever reaches a browser.
* **Logs carry counters only** — no token, no amount, no merchant, no
  customer name.

---

## Adding another provider later

1. `supabase/provider_connections.sql` — add the id to the `provider` CHECK
   constraint.
2. `supabase/functions/provider-connect/index.ts` — add an entry to `ADAPTERS`
   with a `verify(token)` that returns non-secret display metadata or throws.
3. `app.js` — flip `available: true` on the entry already in `PROVIDERS`.

No new table, component, query or translation key is needed.
