# Loading call data: any range of whole days

This replaces the one-month rule. A file may cover one week, six weeks or
several years, may cross month boundaries, and may be followed by another
file in the same month.

## What happens to each day in a file

The import compares every calendar day in the file with what the `calls`
table holds for that day.

| The database has, for that day | Status | What an import does |
|---|---|---|
| no calls | **new** | inserts the file's calls |
| exactly these calls | **identical** | skips the day |
| different calls | **conflict** | nothing, unless the admin confirms replacing exactly that day; then the day's stored calls are deleted and the file's inserted |

"Exactly these calls" is decided by the number of rows and a fingerprint of
the day's rows (`db/day_ledger.py`); the client's export has no call id.
Proven on real data, read-only, on 2026-11-11: the client's multi-year workbook
(376,748 calls, 2,069 days) and the four later files (11,840 calls, 64 days)
all read as identical, day for day, to what the shared database stores.

The comparison is always against the live `calls` table. Rows loaded before
this existed (`db/load_week.py`, earlier loaders) take part like any others:
they do not block an import and are never duplicated.

## What is refused

| Reason (code in the report) | Meaning |
|---|---|
| `unreadable` | not a client call-records workbook, or a malformed row |
| `day_not_finished` | the file includes today or a later day (Eastern time) |
| `partial_day` | the first or last day is cut short (no call in its first or last 3 hours) |
| `day_on_two_sheets` | the same call appears on two sheets (a copied sheet, or one repeated row) |
| `too_many_rows` | more than 100,000 calls in a web upload |

Refused before anything is read (the upload itself): larger than 4 MB, more
than 32 MB once unpacked, more than 16 sheets, or sheets that share one
worksheet. These keep a small file from being made expensive to read. For a
bigger file use the command line.

Only two files are read at a time; a third request gets "try again in a few
seconds" (HTTP 429).

Warnings, not refusals: days inside the file's range that have no calls, and days
whose calls are spread over more than one sheet (they are combined; the client's
multi-year workbook does this at each year end).

## From the admin page

1. **Check without staging**: validates and shows the per-day plan. Stores nothing.
2. **Validate upload**: the same, and stages the batch for seven days. Needs `import:calls`.
3. **Import**: needs the source row count typed in, the confirmation ticked, and
   the server setting `V4W_ADMIN_IMPORTS=1`. If days differ, the button reads
   "Replace N days & import" and the request names exactly those days.

The import re-reads the database inside one transaction. If anything changed
since staging (a day that was new now holds calls, or the other way round),
it is refused and nothing is written: validate the file again.

Any admin holding `import:calls` can import a batch another admin staged;
`imported_by` records who did. Staged rows are cleared after seven days (the
next upload clears expired ones).

**What a replacement deleted is kept.** The calls removed from a replaced day
are stored as JSON in `pipeline_batches.replaced_records` of the batch that
replaced them, so a wrong replacement can be put back without restoring the
database.

Importing does not retrain the model. Retraining stays a separate manual
step: `make train`, then a deploy.

## From the command line

For files too large for the web upload, and for rehearsing.

```
python -m db.pipeline import FILE                      # dry run: reads only
python -m db.pipeline import FILE --commit             # add new days
python -m db.pipeline import FILE --commit --replace-days 2026-10-15
```

A dry run opens the database read-only. `--replace-days` must list exactly
the days the dry run reported as `conflict`.

## Database

`db/migrations/002_day_ranges.sql` changes the teammates' ledger table
`pipeline_batches` only: `month` becomes optional, `first_day` and `last_day`
are added (filled in for batches staged under the month rule), a check keeps
them in order, and `replaced_records` is added. No table is added or dropped
and `calls` is not altered.

```
python -m db.pipeline migrate --dry-run     # runs both migrations, rolls back
python -m db.pipeline migrate
```

Both migrations can be run again safely. `db/migrations/002_down.sql` undoes
002 by hand, all or nothing; it refuses while any day-range batch exists.

Imports rely on the index on `calls(start_ts)` (present in the shared database
as `calls_start_ts_idx`, checked 2026-11-11) to stay quick while `calls` is locked.

Before applying to the shared database: agree with the team, take a
schema-only backup, note the `calls` row count and last timestamp, run the
dry run, then apply.

## Testing

Database tests need a throwaway Postgres, never the shared one
(`tests/conftest.py` fails any test that reaches it through the ledger):

```
docker run -d --name v4w-test-pg -e POSTGRES_DB=pipeline_test -e POSTGRES_USER=pipeline_test \
  -e POSTGRES_PASSWORD=pipeline_test -p 127.0.0.1:55432:5432 postgres:16
V4W_TEST_DATABASE_URL=postgresql://pipeline_test:pipeline_test@127.0.0.1:55432/pipeline_test \
  .venv/bin/python -m pytest tests -q
```

Without `V4W_TEST_DATABASE_URL` those tests skip.

## What changed from the month-based pipeline

- No reporting month to pick; no "one imported batch per month".
- A second file in a month adds days. It no longer replaces the first.
- The current month can be loaded up to yesterday.
- History already in `calls` no longer blocks imports.
- Replacement is per day and explicit, not per month.
- The web upload reads the client's layouts through `db/client_files.py`
  (every call sheet in the workbook), not through an export contract.
  `db/ingest.py`, `db/prepare_history.py` and `config/export-contract.example.json`
  remain as standalone checking tools.
- Upload limit 4 MB (was 25 MB): real weekly files are about 0.1 MB.
