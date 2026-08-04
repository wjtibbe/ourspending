# Tests

No build step and no dependencies: these run the exact `.ts` modules the Edge
Functions import, using Node's native type stripping (Node 22.6+).

    node --experimental-strip-types tests/categories.test.ts
    node --experimental-strip-types tests/sync.test.ts
    node --experimental-strip-types tests/wise-connect.test.ts
    node --experimental-strip-types tests/wise-sync-client.test.ts
    node --experimental-strip-types tests/import-core.test.ts
    node --experimental-strip-types tests/inbound-email.test.ts
    node tests/expense-display.test.js

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

It also covers the authoritative-amount/merchant-metadata rules for
converted-currency imports (the Éxito Express example: deducted 19.76 EUR,
merchant charged 71,362 COP): the deducted amount is always what is stored as
`amount_orig`/`currency`, the merchant amount is retained separately in
`merchant_amount`/`merchant_currency` and flagged via
`had_currency_conversion` only when the two currencies genuinely differ, a
later household rate change never rewrites either stored figure, a
direct-currency payment (or one with no merchant amount at all) never
invents a conversion, and `createExpense` still creates exactly one expense
per transaction. `amount_authority` is asserted to be set unconditionally —
it records a fact of the `NormalizedTransaction` contract itself, not
something a caller opts into — while `source_provider`/`conversion_source`
are asserted to default to `null` when a caller (like every pre-existing
test in this file) does not pass them.

`inbound-email.test.ts` covers the inbound plumbing that does not depend on
any bank's template: Svix signature verification (tampering, wrong secret,
missing headers, replay via old and future timestamps, multi-signature key
rotation), alias resolution, sender authenticity including lookalike domains,
locale-aware money parsing (`45.000` → 45000, the Colombian 1000x trap), HTML
reduction, and fingerprint dedupe bucketing. It also covers the 7-day
retention layer: sanitisation removing scripts/styles/images/remote URLs and
redacting emails, card numbers and IBANs while KEEPING amounts, merchants and
references (the parse targets), the size cap, the exact 7-day expiry, and that
a non-matching message is recorded as `unparsed` without ever creating an
expense.

It also covers the one template implemented so far — the completed
card-payment email ("You spent 71,362 COP at Éxito Express." / "This used
19.76 EUR from your account.") — against both a plain-text and an
HTML-reduced fixture built from the same real anonymised sample: the deducted
account amount becomes the expense amount, the merchant amount is kept only
as metadata, no reference or date is invented, and mail that does not match
this exact template (declined/reversed/refunds, anything else) still falls
through to `unparsed` / `parser_awaiting_samples` rather than being guessed
at. An end-to-end case then runs that extracted transaction through
`import-core.ts` and asserts the resulting expense row: one expense created,
the deducted EUR amount stored as `amount_orig`, the merchant COP amount
stored separately, and `had_currency_conversion` true.

`expense-display.test.js` drives `expense-display.js` — the pure function
`app.js` uses to decide what an expense row's large/small amounts show. It
proves: a display currency matching the deducted amount shows that amount
exactly with the merchant amount as the secondary line; a display currency
matching the merchant amount shows *that* exactly instead, with the deducted
amount as secondary; a genuine third currency is the only case that calls the
app's normal EUR-based conversion; a stale/updated rate cannot affect the two
exact-match branches, because they never call the conversion function at all;
a direct (unconverted) payment and a plain manual expense both behave exactly
as they did before this module existed, with no secondary line when the
currencies already match.

## Database-level verification

Run in the Supabase SQL editor. Each wraps itself in a transaction that ends in
`ROLLBACK`, so production data is never modified.

    supabase/verify_rls.sql                        -> VERIFICATION PASSED
    supabase/verify_provider_connections.sql       -> PROVIDER VERIFICATION PASSED
    supabase/verify_wise_transactions.sql          -> WISE LEDGER VERIFICATION PASSED
    supabase/verify_email_import.sql               -> EMAIL IMPORT VERIFICATION PASSED
    supabase/verify_expense_conversion_fields.sql  -> EXPENSE CONVERSION FIELDS VERIFICATION PASSED

`verify_email_import.sql` additionally proves the retention contract: the
default expiry is seven days, the purge leaves unexpired content alone, an
expired purge clears the body while preserving ids, hashes, status, metadata
and the linked expense, the purge is idempotent, and neither the owner nor any
other user can read `raw_text`/`raw_html` or execute the purge.

`verify_expense_conversion_fields.sql` proves the six new `expenses` columns
exist and stay optional (a pre-existing plain expense gets
`had_currency_conversion = false` and no invented merchant amount), that a
Wise-style conversion row stores both exact amounts and the right flags, that
a simulated later household rate change leaves an already-stored row
untouched, and that exactly one expense exists per import (no double
counting). Verified on real PostgreSQL 16.
