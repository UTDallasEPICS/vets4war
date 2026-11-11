# Admin monthly upload pipeline

The current example contract accepts the actual partner export: `Skill_Name`,
`Start_Date`, `start_time`, `InQueue`, `Agent_Time`, `Abandon_Time`, `Routing_Time`,
`Abandon`. It combines the native Excel date and clock, ignores fully blank rows,
and finds exactly one call-data worksheet by its required headers. Extra columns
and reference tabs are allowed. Multiple matching tabs require an explicit
`sheet` in the contract; they are never silently combined by the monthly uploader.
Existing explicitly configured six-column contracts remain supported.

`InQueue` already includes `Routing_Time`; both are retained without adding them.
`Agent_Time` measures talk time, not after-call work. Timestamps remain naive
wall-clock values; confirm the source timezone before production use.

For the multi-year workbook, use the separate read-only audit/preparation tool:

```sh
.venv/bin/python -m db.prepare_history /path/to/history.xlsx
# Optional: create a NEW directory of monthly files plus a hash/count manifest.
.venv/bin/python -m db.prepare_history /path/to/history.xlsx --output-dir /path/to/monthly-files
```

This reads all call-data tabs, skips `Definitions`, validates every populated
row, preserves repeated records, and publishes no files if validation fails.
It never connects to the database. Prepared months still require completeness,
source-row-count, and existing-database overlap review before explicit import.
The 25 MB/100,000-row monthly upload limits and month replacement rules remain.
Changing the configured layout invalidates staged batches; validate again.

**Cross-month testing:** the admin's **Check without staging** action omits the
reporting month and validates format/rows across all dates, including the current
month. Its report includes `validation_scope: "format_only"` and `months_found`
(timestamp-bearing row counts per month). It never creates an importable batch.
API clients can still supply `month` to `/api/admin/validate` for strict completed-
month validation. **Validate upload**, staging, and import remain single-month
operations; a format-only pass does not establish full-month completeness.

How a partner admin goes from signing in, to uploading a monthly Excel
file, to that data reaching the forecast. This is the team handoff for
the `feature/admin-integration` work.

Related docs: [Excel validation](ingestion.md), [ingestion ledger](ingestion-integration.md).

## Four stages

```
1. Sign in          Auth0 in the browser; API verifies token and permissions
2. Validate/review  Validate upload stages a batch and shows its results
3. Confirm/import  Confirm the source row count, then import the batch
4. Forecast         Some numbers update on restart; volume needs make train
```

Upload does **not** change the forecast. Import changes `calls`. Retraining
the model is a separate, manual step.

## Stage 1: Sign in

The admin opens `/admin.html` and logs in with Auth0. Auth0 returns an
access token (audience `https://api.vets4warriors.admin`). That token is
proof of who they are.

The frontend sends the access token as `Authorization: Bearer <token>` to
the same-origin API. `api/auth.py` verifies RS256 signatures using cached
Auth0 JWKS, the configured issuer/audience, expiration, and required claims
(`exp`, `iss`, `aud`, `sub`). The subject must be nonempty. JWT validation
allows 30 seconds of clock skew; `iat`, `nbf`, and expiration checks remain
enabled. Rejection logs contain only allowlisted categories/class labels.

`GET /api/admin/me` in `api/admin.py` and upload history require
`read:admin`. Staging and import additionally require `import:calls`.
Permissions come from the verified token's `permissions` array; roles or
scope strings do not substitute for it. There is no development auth bypass.
Configure `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` on the server, and enable RBAC
and permissions in access tokens for the Auth0 API.

The signed-in header and admin content appear only after `/api/admin/me`
succeeds. Tokens stay in SDK memory with refresh tokens disabled. Reload
attempts silent token acquisition; transient acquisition errors get one retry,
and `login_required` can trigger one guarded top-level silent redirect.
Failed callbacks do not loop. API 401/403 responses keep admin content hidden.
If logout fails, content stays hidden and Log out becomes usable for a retry.
See [Dashboard troubleshooting](admin-dashboard-troubleshooting.md).

`POST /api/admin/validate` does not require sign-in. It stores nothing.

## Stage 2: Upload (staging)

The admin picks a **completed** reporting month (`YYYY-MM`) and one `.xlsx`
file. The page defaults to the previous completed month and sets it as the
maximum selectable month. **Validate upload** sends FormData containing `file`
and `month` directly to `POST /api/admin/uploads`, using an Auth0 Bearer access
token. This primary action validates and stages a batch; there is no separate
Stage upload button. It stores the validation report and, for a valid batch,
normalized staged records, but does not change `calls`.

The server then:

1. Verifies `read:admin` and `import:calls` (`require_import`).
2. Rejects the current month and any future month using the Eastern calendar.
3. Rejects empty files, files over 25 MB, non-`.xlsx` archives, and
   workbooks that expand past 100 MB / 2,000 ZIP entries / 100,000 rows.
4. Reads the explicitly configured sheet using the export contract mapping, and
   checks every row (timestamps, Y/N abandon, numeric seconds, all calls
   inside the selected month).
5. Writes a **batch** to `pipeline_batches`: who uploaded, the month, a
   file fingerprint, the validation report, and (if every row is valid)
   the cleaned rows. The original workbook is never stored.

Response: `{id, status, validation}` where `status` is `validated` or
`invalid` for a new batch; repeat uploads can return an existing batch's state.
`validation` extends the basic validation report: `ok`, `summary` (valid /
invalid / duplicate counts), `file_errors`, `row_errors` (capped at 200),
`month`, `contract_confirmed`, `days_without_calls`, and `warnings`.
The page retains the returned batch ID for import and displays valid, invalid,
and duplicate counts, file errors, up to 200 row-error entries, the
`row_errors_truncated` notice, `days_without_calls`, and warnings. Warnings and
coverage notices remain visible even when the row-error limit is reached.
The upload badge reports the actual validation/batch state. Normalized call
records are never sent back to the browser.

At this point **`calls` is unchanged**. A batch that is not imported
within 7 days expires. Re-uploading the exact same bytes for the same
month returns the existing batch.

**Check without staging** is an optional, separate action that calls
`POST /api/admin/validate`; it checks archive limits and rows across all dates
without storing a batch or connecting to a database. It remains available to
signed-in readers without import permission. Passing this optional check does
not enable import: an importer must use **Validate upload** to obtain a batch.
It uses the same configured sheet/mapping as staging; without a configured
contract it uses the standalone `Call Log` partner defaults. An invalid
configured contract fails closed. Unlike staging, this route returns the
basic parser report and does not add the staging completeness/contract fields.
Neither validation success nor date coverage proves a complete monthly export.

## Stage 3: Import

The normal workflow is **Validate upload -> review results -> confirm -> import**.
After reviewing the report, the admin enters the authoritative source export's
row count and checks the completeness/row-count confirmation box. The
**Validate & Import** button is enabled only when the retained batch has
`status === "validated"`, the server contract is confirmed, the entered count
matches `validation.summary.total_rows`, and the user has import permission.
Invalid, expired, imported, and superseded batch states cannot enable this button.

Clicking it sends `POST /api/admin/uploads/{id}/import` using the retained batch
ID and JSON `{expected_rows, replace_batch_id?}`. It does not upload the file
again. A changed file or reporting month clears the browser's batch/confirmation
state and requires validation again. No import is sent automatically after
validation, and mutation requests are never automatically retried.

The server refuses unless all of these hold:

- the export contract has `"confirmed": true` and a nonempty `confirmed_by`
- the batch is `validated`, not expired, and was checked with the current
  contract
- `expected_rows` matches the batch exactly
- no other import is running
- the month does not already contain rows loaded outside this pipeline
- if the month was already imported, the request names that batch as
  `replace_batch_id`

Then, in **one transaction**, it removes the old rows for that month (if
replacing), inserts the new rows into `calls`, records which batch each
row came from in `pipeline_call_links`, marks the batch `imported`, and
increments `pipeline_state.revision`. If anything fails, all of it is
undone.

### Replacement and upload history

An import HTTP 409 does not trigger automatic replacement. The page refreshes
history, clears the confirmation, and displays the server's conflict detail.
When history contains the selected month's current imported batch, it offers
**Replace Current Batch**. Selecting this offer populates the replacement batch
selector; it does not send a write request. The admin must review the current
batch, verify the row count, and confirm again. The import action then reads
**Replace Current Batch** and sends the new staged batch's import request with
the selected existing batch ID as `replace_batch_id`. The server remains
authoritative for contract, overlap, expiry, count, and replacement checks.

The history table uses `GET /api/admin/uploads` and shows the last 100 batches:
month, status, uploader, importer, and batch ID. It refreshes after sign-in,
validation/staging, successful import, and import conflicts; a Refresh history
button also reloads it. The admin never types their name or email; the server
records `uploader` and `imported_by` from the verified JWT subject. Review this
history after a lost import response before deciding whether another action
is necessary.

### Two different switches

| | Import button | `"confirmed"` in the contract |
| --- | --- | --- |
| Who | Partner admin | This team, once |
| Where | `admin.html` | `config/export-contract.json` on the server |
| How often | Every monthly upload | Once |
| What it does | Copies that month into `calls` | Allows the Import button to work at all |

The example file `config/export-contract.example.json` is an unconfirmed
template for the normalized six-column `Call Log` format. Copy it to a
reviewed server-side contract and point `V4W_EXPORT_CONTRACT` at that file.
For local testing, `config/export-contract.local.json` is gitignored.
The contract is read from disk; the browser never supplies it. Keep
`confirmed: false` and `confirmed_by` empty during unapproved testing.
Only after team approval should an operator record confirmation and enable
imports. Setting a worksheet name is not partner approval.

Leave `"confirmed": false` on the real project until the team agrees that
imports are safe. Uploading and validating still work while it is false.

Changing the contract after a file was uploaded invalidates that batch
("The export contract changed. Validate the file again."). Upload it
again.

## Stage 4: How the forecast uses new data

Importing does **not** retrain the model. Nothing does that automatically.

| Number on the dashboard | Uses new `calls` rows? | When it updates |
| --- | --- | --- |
| Predicted calls per hour | Only through retraining. The model predicts from dates and holidays. | After someone runs `make train` |
| Handle time, caller patience, quick hang-ups, data date range | Yes, read from `calls` | Next API server restart |

After an import:

1. Without retraining, the next restart updates handle time and patience.
   Staffing recommendations shift a little; predicted volume stays the same.
2. With retraining, someone runs `make train` (~30 seconds). It retrains
   on all of `calls`, tests against the last 12 months, and refuses to
   save if the new model is worse than seasonal naive. The API reloads
   the model on the next request.

`pipeline_state.revision` is incremented on every successful import, but
nothing reads it yet. The "Model retraining" card on the admin page is a
placeholder.

Open questions for the team (do not flip `"confirmed"` on the real
project until these are answered):

1. Is it OK for imports to change handle time and patience on the next
   restart, without a retrain?
2. How often should the model be retrained (monthly, when numbers drift,
   never)?
3. Who runs `make train`, and how?
4. Should the server pick up new data without a restart (read `revision`)?

## API

The ingestion routes live in `api/main.py`; `/me` is registered from
`api/admin.py`. All resolve before the static-file mount.

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| `POST` | `/api/admin/validate` | No | multipart `file`; optional `month=YYYY-MM` for strict month checking | validation report with months found |
| `GET` | `/api/admin/me` | `read:admin` | none | verified subject and permissions |
| `POST` | `/api/admin/uploads` | `read:admin` + `import:calls` | multipart `file` + `month=YYYY-MM` | `{id, status, validation}` (201) |
| `POST` | `/api/admin/uploads/{id}/import` | `read:admin` + `import:calls` | JSON `{expected_rows, replace_batch_id?}` | `{id, status: "imported"}` |
| `GET` | `/api/admin/uploads` | `read:admin` | none | last 100 batches |

The frontend sends the Auth0 access token with its API requests.
Error responses use `{"detail": "..."}` with the pipeline's status:

| Code | Meaning |
| --- | --- |
| 400 | Bad month, not a valid `.xlsx` |
| 401 | Missing or invalid access token; client detail remains generic |
| 403 | Required permissions missing |
| 404 | Batch not found |
| 409 | Invalid/expired batch, wrong row count, month already imported, contract unconfirmed or changed, unmanaged overlap |
| 413 | Empty or larger than 25 MB |
| 503 | Database/export contract/authentication configuration unavailable, or JWKS connection failure |

Frontend and backend file limits are both 25 MB. Oversized declared request
bodies can receive 413 from middleware before route authentication/parsing.

## Database tables

The migration `db/migrations/001_ingestion.sql` assumes `calls` already
exists with a database-generated `bigint` `id`. It adds:

- `pipeline_batches` — staged and imported uploads
- `pipeline_call_links` — which `calls.id` came from which batch
- `pipeline_state` — a singleton `revision` counter

Row-level security is on with no browser policies. The backend connects
as a privileged role via `V4W_DATABASE_URL` (Supabase **session pooler**,
port 5432, not the transaction pooler on 6543).

Months containing records loaded outside this ledger, including through
`db/load_week.py`, are blocked as unmanaged overlap. Reconcile their provenance
before a separate backfill/correction process; do not remove this safeguard.

Apply explicitly:

```sh
.venv/bin/python -m db.pipeline migrate
```

Check first (read-only):

```sql
SELECT column_name, data_type, column_default, is_identity
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'calls'
ORDER BY ordinal_position;

SELECT date_trunc('month', start_ts)::date AS month, count(*)
FROM calls GROUP BY 1 ORDER BY 1;

SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'pipeline_%';
```

After migrating: `SELECT * FROM pipeline_state;` should show one row with
`revision` 0.

Uploading (staging) on the real project only writes `pipeline_batches`.
Test **imports** on a throwaway database first. Keep `"confirmed": false`
on the real project until the team signs off.

## Local try

```sh
# Configure Auth0 and an unconfirmed server export contract in local .env.
# The database is unnecessary for validation-only requests.
.venv/bin/uvicorn api.main:app --reload

curl -F month=2026-09 -F file=@calls.xlsx http://127.0.0.1:8000/api/admin/validate
```

Validate needs no database. The other three routes need the migration.
Import still refuses until the contract is confirmed.

Never commit partner `.xlsx` files; `.gitignore` already blocks `*.xlsx`,
`*.csv`, and `data/`.

## Status and owners

| Piece | Status | Owner |
| --- | --- | --- |
| Merge onto `feature/admin-integration` | Done | Backend |
| Upload / validate / import / history routes | Done (`api/main.py`, `tests/test_admin_api.py`) | Backend |
| Auth0 token and permission checks | Implemented (`api/auth.py`, `api/admin.py`) | Backend / Auth0 |
| `admin.js` validation, staging, confirmation, replacement, history | Connected | Frontend |
| Supabase migration | Explicit operator action; deployment status must be checked | Backend + Supabase owner |
| Production contract approval | Separate team decision; never inferred from a test | Team decision |
| Retrain after import | Manual `make train` | Model owner |

Current frontend behavior:

- Defaults the upload month to the previous completed month.
- Validates/stages through `/api/admin/uploads` with FormData and a Bearer token;
  Check without staging remains an optional `/api/admin/validate` action.
- Displays counts, file errors, up to 200 row errors, truncation, coverage,
  warnings, and dynamic upload/import status badges.
- Enables Import only for a validated, contract-confirmed batch with a matching
  source row count and explicit user confirmation.
- On a 409 conflict, refreshes history and requires explicit replacement
  selection and renewed confirmation. The replacement request includes
  `replace_batch_id`; it never automatically repeats an import.
- Displays pipeline error details and distinguishes API rejection from SDK
  session-restoration errors. Reports/model-health cards remain unconnected.

## Source-format boundary

The normalized `Call Log` format expects a combined timestamp and headers
`Call Date/Time`, `Inqueue Time`, `Routing Time`, `Agent Time`, `Abandon`, and
`Abandon Time`. Routing is optional in the validator. Jim's original exports
instead use split `Start_Date`/`start_time`, underscore-based duration headers,
and varying record-sheet names. Changing the sheet alone does not normalize
those exports. The admin parser currently cannot compose two timestamp fields.

Weekly exports do not establish full-month completeness. Historical multi-sheet
workbooks and overlapping weekly files require a separate reviewed normalization
and backfill/reconciliation workflow. Never feed a partial week into whole-month
replacement or silently select a summary/pivot worksheet.
