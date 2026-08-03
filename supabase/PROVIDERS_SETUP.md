# Connected accounts setup (Wise)

Settings → **Connected accounts** lets each user link their own external
account. Today that means Wise, via a Wise Personal Access Token. Revolut,
PayPal and Stripe are shown as *Soon* and are wired to the same machinery.

Transaction importing is **not** part of this yet — see
[What "Sync now" does](#what-sync-now-does).

---

## 1. Database (required — do this first)

Supabase dashboard → **SQL Editor** → New query → paste the contents of
`supabase/provider_connections.sql` → **Run**.

The migration is additive only: it creates two new tables and changes nothing
that already exists.

| Table | Purpose |
|---|---|
| `provider_connections` | One row per (user, provider). Non-secret metadata only: status, account label, masked hint, timestamps. A user may `SELECT` their own rows; `INSERT`/`UPDATE`/`DELETE` are revoked, so every change must go through the Edge Function. |
| `provider_credentials` | The access token, **encrypted**. RLS on, **no policies**, all privileges revoked from `anon` and `authenticated` — the same shape as `calendar_oauth_tokens`. Never reachable from a browser. |

Then verify it, which proves the guarantees rather than assuming them:

    -- SQL Editor → paste supabase/verify_provider_connections.sql → Run
    -- Expect the notice: PROVIDER VERIFICATION PASSED

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

Optional, for testing against Wise's sandbox:

| Name | Value |
|---|---|
| `WISE_API_BASE` | `https://api.sandbox.transferwise.tech` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform — do not add them by hand.

---

## 3. Deploy the Edge Function

    supabase functions deploy provider-connect

Leave **Verify JWT ON** (the default). Every action requires a signed-in user;
unlike `calendar-feed`, there is no token-in-URL path here.

---

## 4. Using it

1. Wise → **Settings → API tokens** → create a token (read access is enough).
2. In the app: **⚙ Settings → Connected accounts → Connect** on the Wise card.
3. Paste the token and confirm.

The app calls the Edge Function, which checks the token against
`GET /v1/profiles`, stores it encrypted, and returns only metadata. The card
then shows the account name and the last four characters of the token.

To replace a token, press **Reconnect** and paste the new one — the old one is
overwritten. **Disconnect** deletes the connection and, by cascade, the stored
token.

---

## What "Sync now" does

Nothing is imported yet. `sync` decrypts the stored token, re-checks it against
the provider, and updates the connection's status and *Last checked* time. Its
response is explicit about this (`imported: 0`, `transactionSyncEnabled:
false`).

The point is that a revoked or expired token shows up in Settings as *Needs
attention* straight away, instead of silently failing later.

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
  a household member cannot see that you linked a bank account.

---

## Adding another provider later

1. `supabase/provider_connections.sql` — add the id to the `provider` CHECK
   constraint.
2. `supabase/functions/provider-connect/index.ts` — add an entry to `ADAPTERS`
   with a `verify(token)` that returns non-secret display metadata or throws.
3. `app.js` — flip `available: true` on the entry already in `PROVIDERS`.

No new table, component, query or translation key is needed.
