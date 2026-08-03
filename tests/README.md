# Tests

No build step and no dependencies: these run the exact `.ts` modules the Edge
Functions import, using Node's native type stripping (Node 22.6+).

    node --experimental-strip-types tests/categories.test.ts
    node --experimental-strip-types tests/sync.test.ts
    node --experimental-strip-types tests/wise-connect.test.ts

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

## Database-level verification

Run in the Supabase SQL editor. Each wraps itself in a transaction that ends in
`ROLLBACK`, so production data is never modified.

    supabase/verify_rls.sql                  -> VERIFICATION PASSED
    supabase/verify_provider_connections.sql -> PROVIDER VERIFICATION PASSED
    supabase/verify_wise_transactions.sql    -> WISE LEDGER VERIFICATION PASSED
