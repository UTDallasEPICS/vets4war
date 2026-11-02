# Ingestion ownership and integration boundary

`feature/admin-integration` combines the monthly staging/import ledger with the
admin dashboard and Auth0 authorization. `db/ingest.py` owns file validation;
`db/pipeline.py` owns database staging, imports, and provenance. Authentication,
HTTP handlers, and browser interactions remain separate from those modules.
Monitoring and forecasting retain their existing implementations. Training and
model activation are not triggered by ingestion. The old prototype remains in
commit `e73f0bb` for historical reference, not as the current implementation.

## What is retained

| File | Responsibility |
| --- | --- |
| `db/ingest.py` | Standalone workbook parsing and normalization, row-level issues, safe JSON validation reports, bounded row reading |
| `tests/test_ingest.py` | Synthetic validator tests |
| `db/pipeline.py` | Draft monthly staging, transactional import, correction rollback, upload history, staged-record expiry and data revision |
| `db/migrations/001_ingestion.sql` | Backend-only ingestion ledger tables, explicitly applied |
| `tests/test_pipeline.py` | Synthetic PostgreSQL import/rollback/history tests |
| `config/export-contract.example.json` | Unconfirmed normalized `Call Log` template; not approval of every original export layout |
| `tests/test_partner_ingest.py` | Synthetic normalized six-column workbooks, Y/N, month checks and timestamp preservation |
| `api/auth.py`, `api/admin.py` | JWT verification, safe rejection diagnostics, permission dependencies, `/api/admin/me` |
| `api/main.py` | Validation, staging, import and history HTTP routes; existing forecast API |
| `web/admin.html`, `web/admin.js` | Auth0 UI, validation/staging, import confirmation/replacement, upload history |
| `tests/test_auth.py`, `tests/test_admin_api.py`, `tests/test_admin_web.py` | Synthetic JWT, HTTP, and Node-backed admin interaction checks |

The integration retains the forecast/model baseline inherited from
`forecast-mvp`; the admin additions do not change forecast calculations or model
artifacts. No ingestion code automatically trains or activates a model. Existing
call-derived caches update after an API restart, and volume changes require
manual retraining. The ledger revision does not currently invalidate caches.

## Integrated admin workflow

The monitoring branch's admin interface is integrated. The page first verifies
`/api/admin/me`, then calls the validation/staging/import/history routes with
same-origin Bearer requests. The primary workflow is **Validate upload -> review
results -> confirm -> import**. Validate upload sends FormData directly to
`POST /api/admin/uploads`, stages a batch, and retains its ID. The page displays
counts, file errors, up to 200 row errors, truncation, missing-day coverage and
warnings. It defaults to the previous completed month, sets the maximum month,
and uses the backend's 25 MB file limit.

Validate & Import requires a validated, contract-confirmed batch, matching source
row count, explicit confirmation, and import permission. On HTTP 409, the page
refreshes history and offers Replace Current Batch when the current batch is
available. Selection requires renewed confirmation and sends `replace_batch_id`
with the retained staged batch's import request. No replacement or mutation retry
is automatic. The last-100-upload history table also has a manual refresh.

Check without staging remains a separate, optional validation-only action for
readers and importers. It does not create an importable batch. Reports/model-health
displays remain placeholders, and retraining is manual.

The HTTP routes, admin flow, and how imported rows reach the forecast are
documented in [Admin monthly upload pipeline](admin-upload-pipeline.md).
`POST /api/admin/validate` returns `parse_partner_excel(...).report()` and
stores nothing. `POST /api/admin/uploads` stages a batch;
`POST /api/admin/uploads/{id}/import` copies it into `calls`;
`GET /api/admin/uploads` returns history. `/me` and history require `read:admin`;
staging and import require both `read:admin` and `import:calls`. JWT verification
enforces RS256 signatures, issuer, audience, expiration and required claims,
with a 30-second clock-skew allowance that retains `iat`/`nbf` checks. Permissions
come from the verified token, and the development auth bypass is removed.
Normalized call records are never returned to the browser.

Tokens remain in SDK memory with refresh tokens disabled. The UI handles callback
cleanup, silent restoration and bounded recovery, and hides signed-in controls
until `/me` succeeds. Failed authorization hides admin content. A failed logout
keeps content hidden but allows another logout attempt.

## Known ingestion work remaining

Standalone `--profile partner` validation defaults to the normalized `Call Log`
sheet and its six headers, accepts Y/N and numeric seconds, and needs no source
call ID. Routing is optional. `--month YYYY-MM` optionally checks every record's
month; the admin endpoint always checks its submitted reporting month and rejects
the current/future month. Both admin validation and staging use the configured
server contract's sheet/mapping. Validation without a configured contract keeps
the standalone defaults; an invalid configured contract fails closed.

The normalized historical derivative `v4w_call_log_2021_2025.xlsx` passed 93,407
rows in a prior read-only field check. That result does not establish monthly
completeness or compatibility of Jim's original multi-sheet archive. Original
exports have split `Start_Date`/`start_time`, different duration headers, varying
sheet names and sometimes trailing blank rows. The admin parser does not yet
combine the split timestamp. Its explicit sheet must not be replaced by a silent
first-sheet fallback. Source timezone and export semantics still need confirmation.

Monthly imports now use the reporting month, batch UUID, and database-generated
row IDs. Source call IDs are not required. Six-column synthetic import tests
cover repeat files/months, explicit corrections, and transaction rollback.

1. Add a reviewed original-export normalization profile and synthetic regressions;
   keep weekly reconciliation and historical backfill separate from full-month
   replacement.
2. Review the existing database's calls schema, generated ID default, historical
   provenance, and completeness evidence before approving any production contract.
   Passing synthetic tests is not production import approval.

## Draft import service

`preview(conn, content, month, uploader, profile)` validates and stages canonical
records in PostgreSQL. Unlike standalone `parse_excel()`, staging **does write**
the ingestion ledger. Original workbooks and ignored columns are not stored.
Only a nonempty all-valid file is staged as importable. Display errors are
bounded; input limits are 25 MB compressed, 100 MB expanded, 2,000 ZIP entries and
100,000 rows. HTTP upload handlers and declared-size middleware enforce these
limits; the frontend also limits files to 25 MB.

The validation-only endpoint does not connect to a database or stage records.
Its basic report differs from staging's enriched report: only staging adds
contract confirmation, month, missing-day coverage and row-error truncation.

The example deliberately has `identifier_column: null`, `timezone: "unconfirmed"`,
and `confirmed: false`. `config/export-contract.local.json` is ignored and intended
for local configuration; it must not be committed or silently marked approved.
Both validation and monthly importing can use the normalized layout without
source IDs, but source-ID duplicate detection is then disabled. The import
profile, database setup, full-month coverage and replacement policy require
explicit approval before real imports are enabled.

`commit_import()` requires a confirmed profile, a matching
source row count, and explicit selection of the current batch for replacements.
It refuses months containing unmanaged historical records and requires the
database to generate `calls.id`. All call changes, batch-to-row links, batch state and
revision increment are committed together or rolled back. The authenticated
caller must independently confirm full-month coverage before invoking it; counts
and days without calls cannot prove completeness.

Re-uploading identical file bytes returns the existing batch. A different file
for an imported month is also blocked unless the current batch is selected
explicitly for replacement. The ledger does not infer call identity from
timestamps or durations and preserves identical rows within a file. It does
not detect individual calls repeated with altered timestamps in different
monthly exports; selected-month validation is not source reconciliation.

`history(conn)` returns ingestion history only. There are no training jobs or
report tables in this migration. The revision is available to future consumers
but does not currently invalidate the forecasting process's caches.

Staged records expire after seven days. With the prototype worker removed, an
operator/scheduler must explicitly run `python -m db.pipeline purge-expired` for
physical cleanup. Expired records cannot be imported even before cleanup.

The SQL migration is **not applied automatically**. It assumes the existing
`calls` table and its generated bigint ID already exist. It adds
`pipeline_batches`, `pipeline_call_links`, and `pipeline_state`, with RLS and no
browser policies. Use an appropriately privileged backend database role.
If someone applied the old prototype migration in a private test database,
this revised migration does not drop that database's old job/report tables.
No migration or data change was run against the shared database during cleanup.
If an old draft ledger with a `source_id` column was applied privately,
`python -m db.pipeline migrate` refuses to silently rewrite it. Review a separate
schema/data upgrade rather than dropping existing records. Fresh installations
create `pipeline_call_links(call_id, batch_id)` with database row IDs only.

## Tests

```sh
V4W_DATABASE_URL= .venv/bin/python -m pytest tests/test_ingest.py -q
V4W_DATABASE_URL= .venv/bin/python -m pytest tests/test_partner_ingest.py -q
V4W_DATABASE_URL= .venv/bin/python -m pytest tests/test_pipeline.py -q
```

For an isolated full-suite run, disable dotenv discovery and provide only a
disposable test database:

```sh
PYTHON_DOTENV_DISABLED=1 V4W_DATABASE_URL= V4W_EXPORT_CONTRACT= \
  V4W_TEST_DATABASE_URL=postgresql://pipeline_test:pipeline_test@localhost:5432/pipeline_test \
  .venv/bin/python -B -m pytest tests -q -rs -p no:cacheprovider
```

Use a disposable database at that example URL, never a production database.
`tests/test_auth.py` checks real synthetic RSA signatures, exact permissions,
safe diagnostic categories, JWKS rotation and timing boundaries. The Node-backed
admin tests cover authorization failures, logout retry, validation, staging,
confirmation, replacement and history without a live Auth0 tenant.

The PostgreSQL tests use only `V4W_TEST_DATABASE_URL` or optional `pgserver` to
start a disposable local cluster. They never use the partner database URL.
CI provides a disposable PostgreSQL service. If neither local option is
available the PostgreSQL tests skip. There is no new Supabase project requirement
for standalone or HTTP validation. Auth0 browser smoke tests and deployment
configuration checks remain separate from synthetic automated testing.
