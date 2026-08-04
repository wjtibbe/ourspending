# Tests

No build step and no dependencies: these run the exact `.ts` modules the Edge
Functions import, using Node's native type stripping (Node 22.6+).

    node --experimental-strip-types tests/categories.test.ts
    node --experimental-strip-types tests/sync.test.ts
    node --experimental-strip-types tests/wise-connect.test.ts
    node --experimental-strip-types tests/wise-sync-client.test.ts
    node --experimental-strip-types tests/import-core.test.ts
    node --experimental-strip-types tests/inbound-email.test.ts

`categories.test.ts` covers the mapping layer: multilingual aliases, MCC codes,
resolution priority, deactivated household categories, and the guarantee that
an unknown value always lands on an existing app category rather than inventing
one.

`sync.test.ts` drives `_shared/sync.ts` — the same core used by both the hourly
cron job and the "Sync now" button — against a fake PostgREST and a fake Wise
API. It covers idempotency, the pending/reversed/cancelled/declined/failed and
incoming skips, the balance-vs-merchant amount choice under currency
conversion, and isolation of a failing transaction or a failing connection.

`wise-connect.test.ts` drives `verifyWiseToken()` in `_shared/wise.ts` — the
only place Connect/Reconnect checks a token — against a fake fetch. It proves
the request is exactly `GET {base}/v1/me` with `Authorization: Bearer
<trimmed token>`, that whitespace around a pasted token is stripped before the
call, that `/v1/profiles`/balances/statement are never requested at connect
time, that a 200 marks the connection `connected` (via `buildConnectionRow` in
`provider-connect/index.ts`), that 401/403/429/5xx/network map to distinct
`token_refused` / `token_forbidden` / `wise_rate_limited` /
`wise_temporarily_unavailable` codes, and that nothing beyond a name and an id
ever leaves `verifyWiseToken` — no token, no raw response, no email, phone,
address or date of birth.

`wise-sync-client.test.ts` drives `createWiseClient()` in `_shared/wise.ts` —
the client the hourly job and "Sync now" use to actually read data — against a
fake fetch. It proves profile listing is exactly `GET {base}/v2/profiles`
(not `/v1/profiles`, which requires broader permissions than a plain Personal
Access Token carries and rejected a real, confirmed-valid token), that
`balances()`/`statement()` are unchanged, that a PERSONAL profile is accepted
with no business-profile requirement, that 401/403/429 map to three distinct
`WiseAuthError` codes (`invalid_token` / `insufficient_permissions` /
`wise_rate_limited`) rather than being collapsed into one, that a 5xx or a
network failure is deliberately NOT a `WiseAuthError` (so it maps to
`provider_unreachable` upstream in `_shared/sync.ts`), and that Connect
(`verifyWiseToken`, `/v1/me`) and Sync (`createWiseClient`, `/v2/profiles`)
never cross-call each other's endpoint.

`import-core.test.ts` drives `_shared/import-core.ts` — the provider-neutral
importer shared by every input method. It proves the rules that must hold no
matter where a transaction came from: household and payer slot resolved from
the database (never a payload, never defaulted), shared expenses with the
owner as payer, EUR conversion identical to `app.js`, EUR/USD/COP enforced,
declined/reversed/refund/incoming never imported, disabled household
categories not resurrected, and per-user isolation.

`inbound-email.test.ts` covers the inbound plumbing that does not depend on
any bank's template: Svix signature verification (tampering, wrong secret,
missing headers, replay via old and future timestamps, multi-signature key
rotation), alias resolution, sender authenticity including lookalike domains,
locale-aware money parsing (`45.000` → 45000, the Colombian 1000x trap), HTML
reduction, and fingerprint dedupe bucketing. It also covers the 7-day
retention layer: sanitisation removing scripts/styles/images/remote URLs and
redacting emails, card numbers and IBANs while KEEPING amounts, merchants and
references (the parse targets), the size cap, the exact 7-day expiry, and that
the stub parser records an `unparsed` message without ever creating an
expense.

## Database-level verification

Run in the Supabase SQL editor. Each wraps itself in a transaction that ends in
`ROLLBACK`, so production data is never modified.

    supabase/verify_rls.sql                  -> VERIFICATION PASSED
    supabase/verify_provider_connections.sql -> PROVIDER VERIFICATION PASSED
    supabase/verify_wise_transactions.sql    -> WISE LEDGER VERIFICATION PASSED
    supabase/verify_email_import.sql         -> EMAIL IMPORT VERIFICATION PASSED

`verify_email_import.sql` additionally proves the retention contract: the
default expiry is seven days, the purge leaves unexpired content alone, an
expired purge clears the body while preserving ids, hashes, status, metadata
and the linked expense, the purge is idempotent, and neither the owner nor any
other user can read `raw_text`/`raw_html` or execute the purge.
