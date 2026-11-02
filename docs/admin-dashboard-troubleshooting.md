# Admin dashboard validation and session restoration

## Worksheet configuration

The standalone partner validator defaults to the exact sheet `Call Log`.
An observed export instead uses `Call Records - Oct 14 tp Oct 20` (including
the `tp` spelling). A sheet-name mismatch fails with `missing_sheet`; the
application must not rename the original workbook or guess the first sheet.

Set `V4W_EXPORT_CONTRACT` to a server-side contract with the exact worksheet
name and verified column mapping. Both the validation endpoint and staging now
use that contract. Without a configured contract, standalone validation keeps
the original partner defaults. An invalid configured contract fails closed.
The ignored `config/export-contract.local.json` is a machine-local option;
the tracked example remains an unconfirmed template.

Restart the API after changing its environment settings. Confirm which contract
the running process uses if its environment overrides `.env`. The validation
endpoint remains public, database-free, and returns no normalized records.
Staging/import authorization and database transactions are unchanged.

Worksheet selection does not establish completeness. A weekly export does not
prove a complete monthly export, and passing row/date validation does not make
it safe to replace a month. Keep the local contract unconfirmed until the team
has verified the format and full-month replacement policy.

## Reload restoration

The SDK uses memory token storage with refresh tokens disabled. Reload therefore
requires a fresh silent authentication exchange. The SDK uses an iframe, which
can fail when the Auth0 session is unavailable, browser cookie restrictions
apply, consent is needed, or the network times out. The page reports only
allowlisted error codes; it never prints SDK errors, tokens, or callback details.

Transient token-acquisition failures receive one retry. If Auth0 reports
`login_required`, initial page restoration can make one top-level `prompt=none`
redirect to access the Auth0 session in a first-party context. A nonsecret
sessionStorage flag limits this attempt; it contains no credentials or tokens.
If storage is unavailable, automatic recovery is skipped. Failed callbacks do
not trigger another redirect. Explicit login and successful authorization clear
the guard. Consent and other interactive requirements use the login button.

Network and API failures offer a session-check retry instead of claiming the
session expired. HTTP 401 and 403 still deny access, and the dashboard is revealed
only after the backend verifies `/api/admin/me`. Uploads/imports are never
automatically retried: a lost response may follow a completed transaction, so
review history before deciding what to do next.

Synthetic regression tests cover worksheet mismatch, configured validation and
staging, unconfirmed import blocking, transient restoration, redirect loop
protection, failed callbacks, API outages, and mutation requests. A real Auth0
browser smoke test is still needed to confirm tenant and browser behavior.
