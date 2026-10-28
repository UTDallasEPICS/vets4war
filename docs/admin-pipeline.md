# Monthly administration workflow

The application now serves an admin portal at `/admin`, a login screen at
`/login`, and the existing forecast dashboard at `/`. All use the same FastAPI
backend and organization sign-in. This is one application with separate screens;
a second independently hosted website is not required.

Monthly flow: validate an Excel export, review errors, confirm its source row
count and complete-month coverage, import the whole month, and follow its
training/report job in the history table. The original workbook and ignored
columns are never stored. The dashboard checks for changes every 15 seconds and
when its tab becomes visible.

## Confirm the sponsor contract

Jimmy and the people he trains can all be authorized uploaders. They should use
the same export format as the five-year historical dataset. No sponsor workbook
is tracked in this repository, so its headers and business semantics have not
been independently confirmed here.

1. Copy `config/export-contract.example.json` to the gitignored
   `data/export-contract.json`.
2. Compare a sanitized historical export with Jimmy's current monthly export.
   Record the worksheet, exact column names, timestamp format, and a stable
   **call** identifier. Confirm that the ID is unique across months, is stored
   as text when needed, and does not identify a caller.
3. Confirm one row represents one inbound call, not multiple legs or outbound
   activity. Confirm abandonment is represented by the supported true/false or
   1/0 values. Other codes or multi-leg exports need a verified adapter first.
4. Confirm durations are numeric seconds, not Excel time cells or duration
   strings. The current adapter accepts only seconds. Confirm timestamps match
   the existing naive Eastern wall-clock convention (`America/New_York`),
   including its historical DST treatment. Other units/timezones require an
   explicit adapter; changing the JSON label does not convert values.
5. Confirm a file contains one complete, closed calendar month. The portal
   rejects records outside the selected month and current/future months. It
   shows days without calls, but zero calls do not prove missing data. The
   uploader must independently confirm export coverage and source row count.
6. Review the proposed correction rule: replace a **previously managed** month
   using a complete corrected export and its current batch ID. Partial patches
   are not supported. A correction can change or remove source IDs, provided
   the new IDs do not collide with any other active month.
7. Set `confirmed: true` and `confirmed_by` after the rules have been verified.
   Changing the contract requires a new validation before importing.

Unconfirmed contracts allow validation but block imports. Changing the contract
or choosing a different month permits another validation of the same file.
Re-uploading an already imported file returns its existing batch and cannot
silently insert the same calls again.

## Database setup

The application never automatically migrates the shared database. Review
`db/migrations/001_admin_pipeline.sql` and apply it explicitly to the intended
environment after confirming the existing schema:

```sh
.venv/bin/python -m db.pipeline migrate
```

The migration adds pipeline tables and indexes. It does not rewrite historical
calls or change `calls.id`. The destination `calls` table must already have the
columns used by the validator and a verified generated default/identity for its
bigint `id`. Imports fail if that default is absent. An operator must verify the
existing ID generator is correctly positioned for existing records; source call
IDs are never substituted for database IDs.

The pipeline tables have row-level security enabled with no browser access
policies. The backend database role must own them or have an explicitly managed
RLS bypass. Do not use browser/anonymous Supabase credentials for the API worker.

Existing historical records have no pipeline links. Overlapping such records is
rejected, including months containing a mix of linked and unlinked records.
Reconcile those records and their provenance separately before attempting a
replacement. A file hash alone cannot deduplicate overlapping historical data
without reliable source IDs.

New months cannot jump over intervening months after the latest existing call
month; fill those months first so training does not mistake missing data for
zero call volume. Historical source coverage must still be verified separately.

An import transaction holds the pipeline advisory lock and a write-excluding
lock on `calls`; it checks overlap and duplicate IDs, replaces an explicitly
selected prior batch if requested, inserts calls and their source links, clears
staged records, creates a job, and increments the data revision. Any error rolls
back the entire transaction, including deletions during a correction. Read
queries continue while an import holds the table lock.

## Sign-in configuration

Set these environment variables using the selected provider's app registration:

| Variable | Value |
| --- | --- |
| `V4W_PUBLIC_URL` | Canonical HTTPS origin, without a path |
| `V4W_OIDC_METADATA_URL` | Provider's OpenID Connect discovery URL |
| `V4W_OIDC_CLIENT_ID`, `V4W_OIDC_CLIENT_SECRET` | App credentials |
| `V4W_SESSION_SECRET` | Stable random secret of at least 32 characters, shared by all API instances |
| `V4W_ADMIN_EMAILS` | Comma-separated verified emails for Jimmy and authorized uploaders |
| `V4W_VIEWER_EMAILS` | Comma-separated verified emails for dashboard viewers |
| `V4W_COOKIE_SECURE` | `true` for HTTPS deployments |
| `V4W_REQUIRE_AUTH` | `true` protects the main dashboard and APIs; admin always requires sign-in |

Register exactly `V4W_PUBLIC_URL/auth/callback` with the provider. The OIDC client
uses authorization code flow, S256 PKCE, state, nonce and validated ID tokens.
It requires an `email_verified: true` claim and an exact allowlisted email.
Provider-specific UPN or preferred-username claims are not treated as verified
email. Confirm the selected provider issues this claim; if it does not, add an
explicit issuer/subject-based account mapping before using that provider.
Tokens are not saved in browser cookies. Cookies contain a signed identity and
CSRF value; they expire after eight hours. Roles are recalculated on each request,
so removing an account from the allowlist revokes its access. Logout clears the
local application cookie; it does not log the user out of the identity provider.

For loopback development, use `V4W_PUBLIC_URL=http://127.0.0.1:8000` and
`V4W_COOKIE_SECURE=false`. To exercise the existing dashboard without provider
credentials locally, `V4W_REQUIRE_AUTH=false` leaves dashboard access open while
the admin portal remains protected. There is no development admin bypass.

The OAuth integration follows [Authlib's web-client documentation](https://docs.authlib.org/en/latest/oauth2/client/web/).

## Run the API and worker

Install the pinned requirements, apply the migration, set
`V4W_EXPORT_CONTRACT` to the confirmed JSON path, and set
`V4W_PIPELINE_ENABLED=true`. Run these processes with the same database settings:

```sh
make serve PYTHON=.venv/bin/python
make worker PYTHON=.venv/bin/python
```

For a scheduled runner, `.venv/bin/python -m db.worker --once` processes at most
one job. The continuous worker polls every five seconds. Training runs after
each successful monthly import/correction; there is no blind calendar retrain
when no new data arrived. Multiple workers are serialized with a PostgreSQL
session advisory lock. If a worker crashes, the next worker resumes its running
job. Imports return a retryable conflict while monthly processing holds the lock.
The session lock requires a direct PostgreSQL connection or **session-mode**
pooler; do not use a transaction-mode pooler for the worker or training CLI.

Jobs distinguish import success, training success/rejection/failure, and report
status. A failed/rejected current batch can be retried from the portal. Pending
jobs for superseded batches are skipped. Run the worker under a process manager
that restarts it if its database connection fails.

Set `V4W_MODEL_DIR` to the same persistent writable filesystem on the worker and
every API instance. The worker writes an isolated model/metadata pair under
`versions/<version>/`, validates it, then atomically replaces `active.json`.
The original checked-in pair remains a fallback until the first activation.
Rejected or failed candidates do not replace the active model. Both `make train`
and the worker use the same lock, training gate and activation convention.
Retain old versions for rollback; deployment must not overwrite the shared
volume. Candidate directories that failed before activation can be removed by
an operator after confirming they are not referenced by `active.json`.

`compose.pipeline.yml` provides API/worker services sharing a model volume for
local/self-hosted use. Example, after configuring `.env` and the contract:

```sh
docker compose -f compose.pipeline.yml build
docker compose -f compose.pipeline.yml run --rm api python -m db.pipeline migrate
docker compose -f compose.pipeline.yml up -d
```

The container user (UID 10001) must have write access to the model volume. On
AWS, configure an equivalent worker service and shared filesystem plus secrets
and the contract mount. Existing deployment workflows have not been provisioned
with these resources by this change. Do not enable the pipeline on isolated,
ephemeral API/worker filesystems.

## Reports and retention

Each processed month has a stored JSON report and CSV download: offered,
answered and abandoned calls, abandonment rate, positive answered-call mean
handle time, mean answer wait, daily totals, and training/backtest outcome.
The initial actuals report is saved before training, so a failed retrain still
has a report. A superseded month's report remains associated with its original
batch; the corrected batch gets a separate report.

Reports contain actuals for the uploaded month. They do not label predictions
from a model trained on that month as prospective forecast accuracy. Comparing
past predictions to actuals requires stored pre-month forecasts, which this
implementation does not create.

Uploads are limited to 25 MB compressed, 100 MB expanded, 2,000 ZIP entries,
and 100,000 call rows. Only canonical timing/outcome fields and source call IDs
are staged in PostgreSQL. Ignored columns and original workbooks are discarded.
Validation displays at most 200 row errors with the full counts. Staged records
expire after seven days and are purged by the worker; imported staged records
are removed immediately. Batch history and aggregate reports are retained.
Public errors exclude original data and database exception text.

## Verification

```sh
V4W_DATABASE_URL= V4W_REQUIRE_AUTH=false .venv/bin/python -m pytest tests -q -rs
```

CI starts a disposable PostgreSQL 16 service using `V4W_TEST_DATABASE_URL`.
The new integration tests create independent synthetic schemas and never use
the application database URL. Locally, either supply a **disposable test**
database URL or install optional `pgserver` to start a temporary cluster.
Without either, database integration tests skip. Existing partner-database
tests still skip without `V4W_DATABASE_URL`.

Auth tests use a mock OIDC issuer with real signed ID tokens to verify login,
PKCE, state/audience validation, verified email, allowlists, expiry, role checks,
and CSRF. Pipeline tests cover atomic replacement/rollback, duplicates, locks,
reports, retry/recovery, real LightGBM candidate loading, a synthetic rolling
backtest, and the upload/import/report HTTP flow. Real provider sign-in and the
historical export mapping must still be verified with the chosen configuration.
