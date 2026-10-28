# Ingestion ownership and integration boundary

This branch owns Excel validation and the draft monthly staging/import ledger.
It does not own the admin page, authentication, accuracy reports, monitoring,
training, model activation, or dashboard forecast calculations. Those prototype
components were removed from this branch. The complete old prototype remains
in commit `e73f0bb` for reference.

## What is retained

| File | Responsibility |
| --- | --- |
| `db/ingest.py` | Standalone workbook parsing and normalization, row-level issues, safe JSON validation reports, bounded row reading |
| `tests/test_ingest.py` | Synthetic validator tests |
| `db/pipeline.py` | Draft monthly staging, transactional import, correction rollback, upload history, staged-record expiry and data revision |
| `db/migrations/001_ingestion.sql` | Backend-only ingestion ledger tables, explicitly applied |
| `tests/test_pipeline.py` | Synthetic PostgreSQL import/rollback/history tests |
| `config/export-contract.example.json` | Observed sheet/header mapping and seconds; import approval and source-ID policy remain unconfirmed |
| `tests/test_partner_ingest.py` | Synthetic six-column partner workbooks, Y/N, month checks and timestamp preservation |

The model, its artifacts, forecast API and staffing dashboard match
`origin/forecast-mvp` at `37aca07`. No ingestion code automatically trains or
activates a model. Existing model/data caches are unchanged; coordinate how a
committed import becomes visible with the model/dashboard owner before enabling
live imports.

## Combining with feature/admin-monitoring

The teammate's `web/admin.html` and `web/admin.js` are the chosen UI ownership
boundary. They are not copied here: merge reviewed changes through the team's
integration branch rather than maintain two competing copies. Their preview
currently checks local file selection/extension/size; it does not parse Excel.
Their `db/monitor.py` and monitoring/accuracy code remain theirs.

For the first integration, the UI should send a workbook and selected reporting
month to a **validation-only** backend endpoint. That endpoint is not yet
implemented in this trimmed branch. It should call
`parse_partner_excel(binary_stream, month=selected_month)` and return
`result.report()`. Do not send normalized call records back to
the browser. This step needs no database connection or migration.

Agree on the final route and request/response format with the frontend owner
before wiring their page. Authentication for any database-writing endpoint is
a separate shared integration responsibility. This branch deliberately exposes
no new unauthenticated import, history, or migration HTTP route.

## Known ingestion work remaining

Partner validation is implemented: `--profile partner` selects the actual
`Call Log` sheet and six headers, accepts Y/N and seconds, and needs no call ID.
`--month YYYY-MM` optionally enforces a selected month. Timestamps are preserved;
their source timezone remains unconfirmed. The provided historical workbook
passed all 93,407 rows in a read-only check.

1. Implement/test the agreed complete-month duplicate/replacement policy without
   assuming timestamps or generated database IDs identify the same source call.
   Current source-ID import tests do not establish this future behavior.
2. Add the validation-only HTTP boundary and connect the teammate's UI.
3. Review the existing database's calls schema, generated ID default and
   historical provenance; then test imports in an agreed isolated environment.
   Real database importing must not be enabled solely because synthetic tests pass.

## Draft import service

`preview(conn, content, month, uploader, profile)` validates and stages canonical
records in PostgreSQL. Unlike standalone `parse_excel()`, staging **does write**
the ingestion ledger. Original workbooks and ignored columns are not stored.
Only a nonempty all-valid file is staged as importable. Display errors are
bounded; input limits are 25 MB compressed, 100 MB expanded, 2,000 ZIP entries and
100,000 rows. The caller must enforce the compressed request limit before reading
an HTTP body; no upload HTTP implementation is supplied here.

The example now deliberately has `identifier_column: null` and
`timezone: "unconfirmed"`. Both the standalone partner validator and draft
staging service can validate without IDs, but `commit_import()` explicitly
blocks such profiles until month-based importing is implemented. Changing
`confirmed` to true alone does not enable importing this six-column file.

`commit_import()` requires a confirmed profile, stable source IDs, a matching
source row count, and explicit selection of the current batch for replacements.
It refuses months containing unmanaged historical records and requires the
database to generate `calls.id`. All call changes, source links, batch state and
revision increment are committed together or rolled back. The authenticated
caller must independently confirm full-month coverage before invoking it; counts
and days without calls cannot prove completeness.

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

## Tests

```sh
V4W_DATABASE_URL= .venv/bin/python -m pytest tests/test_ingest.py -q
V4W_DATABASE_URL= .venv/bin/python -m pytest tests/test_partner_ingest.py -q
V4W_DATABASE_URL= .venv/bin/python -m pytest tests/test_pipeline.py -q
```

The PostgreSQL tests use only `V4W_TEST_DATABASE_URL` or optional `pgserver` to
start a disposable local cluster. They never use the partner database URL.
CI provides a disposable PostgreSQL service. If neither local option is
available the PostgreSQL tests skip. There is no new Supabase project requirement
for the standalone validator or eventual stateless preview endpoint.
