# Monthly call-file validation (phase 1)

This phase reads and validates `.xlsx` workbooks only. It never loads `.env`,
connects to Supabase, inserts records, or trains a model. CSV, upload endpoints,
and deployment changes are outside this phase.

## How `db/ingest.py` works

Ingestion eventually means getting new call records into the application's
database. This file implements the first part: reading an Excel file and checking
whether its records meet our input rules. A successful dry-run means the file
passed these checks; nothing has been imported into Supabase.

```text
CLI arguments or a future backend call
    -> parse_excel(): open the workbook and read the headers
    -> validate_rows(): map columns, check each call, flag repeated IDs
    -> ValidationResult: retain normalized records and validation errors
    -> report(): produce a summary safe to display
```

`main()` handles the terminal interface. It reads options such as `--file`,
`--column-map`, and `--identifier-column`, calls `parse_excel()`, prints the JSON
report, and returns an exit code. It does not contain the row-validation rules,
so a future FastAPI endpoint can call the same parser without running the CLI.

`parse_excel()` accepts either a file path or a binary stream, which is useful
for a future upload endpoint. It uses `openpyxl` to open the workbook in read-only
mode, selects the first or requested worksheet, and treats Excel row 1 as the
header. Data rows start at Excel row 2. It passes those rows to `validate_rows()`
and closes the workbook afterward. Unreadable workbooks, missing sheets, and
empty files produce file-level errors. Formulas are not evaluated.

`validate_rows()` first checks the header mapping. For example,
`{"start_ts": "Call Start"}` means "read the Excel column called Call Start into
the normalized start_ts field." It then checks each row using these helpers:

| Helper | Responsibility | Example |
|---|---|---|
| `_blank()` | Recognizes missing values and whitespace-only text | A blank timestamp becomes a required-value error |
| `_timestamp()` | Parses a native Excel datetime or explicitly supported text format | `2026-09-01 13:45:00` becomes a Python `datetime` |
| `_duration()` | Converts numeric seconds to a finite, nonnegative float | Text `"120"` becomes `120.0`; `-5` is rejected |
| `_abandoned()` | Converts supported outcome values to a boolean | `"false"` becomes `False`, meaning answered |
| `_identifier()` | Normalizes a configured source identifier for duplicate checking | Text `"00123"` keeps its leading zeroes |

After checking individual fields, `validate_rows()` checks which durations are
required for the call's outcome. It also groups rows by source identifier when
duplicate detection is configured. Every occurrence of a repeated ID is flagged,
including rows whose other values differ. Duplicate checking is within this
workbook only; it does not query the database.

The three result classes keep data separate from error reporting:

| Class | What it holds |
|---|---|
| `ValidationIssue` | A normalized field name, machine-readable error code, and readable explanation |
| `ValidatedRow` | The original Excel row number, fields successfully normalized, optional source ID, and errors |
| `ValidationResult` | All checked rows, file-level errors, summary counts, and duplicate-check status |

Use `result.rows` to inspect individual outcomes. An invalid row may have only
part of its record normalized; do not treat that partial record as accepted.
`result.valid_records` filters out invalid and duplicate rows, and is empty when
file-level errors exist. It can still contain valid rows from a mixed file, so
any future whole-file import must check **`result.ok` first**. That property is
true only for a nonempty file with no file errors and every row classified valid.

For example, suppose a synthetic file has these outcomes:

| Excel row | Situation | Classification |
|---|---|---|
| 2 | Complete answered call with unique ID A | Valid |
| 3 | Missing timestamp, unique ID B | Invalid |
| 4 | Otherwise valid call with ID C | Duplicate |
| 5 | Another otherwise valid call with ID C | Duplicate |

The summary is `total_rows=4`, `valid_rows=1`, `invalid_rows=1`, and
`duplicate_rows=2`; `result.ok` is false. If a repeated-ID row also has a bad
timestamp, it counts as invalid while retaining both errors. Each row contributes
to exactly one summary category.

Finally, `result.report()` returns only counts, flags, warnings, and errors with
Excel row numbers. It leaves out normalized records and source identifiers, so
the printed report does not expose call values. The Python result object still
contains data and should not be logged wholesale.

## What is known about the existing system

There is no tracked schema/migration or sample Excel/CSV export in this checkout.
The README says calls are imported outside this repository; comments referencing
`db/load_calls.py` refer to a file that is absent.

An earlier read-only inspection in this conversation (October 20, 2026) found
the following `public.calls` structure. It was **not queried again for this
implementation**, so defaults, identifier provenance, and any subsequent schema
changes remain unverified.

| Column | Observed PostgreSQL type | Observed constraint | Validator input |
|---|---|---|---|
| `id` | bigint | Primary key, not null | Not assigned; source ID meaning is unknown |
| `start_ts` | timestamp without time zone | Not null | Required timestamp |
| `abandoned` | boolean | Not null | Required true/false or 1/0 |
| `in_queue_sec` | double precision | Nullable | Required header; value required for answered calls |
| `agent_sec` | double precision | Nullable | Required header; value required for answered calls |
| `abandon_sec` | double precision | Nullable | Required header; value required for abandoned calls |
| `routing_sec` | double precision | Nullable | Optional header and value |

That inspection found a primary key on `id` and an index on `start_ts`; no other
call-table constraints were returned. It does not establish whether `id` is
generated or is a stable export ID. Current database contents/provenance are not
reverified here. A source label cannot prove that records are real or synthetic.

Existing code uses `psycopg.connect()` with `V4W_DATABASE_URL`, loaded by
`python-dotenv`. `api/main.py:_connection()` opens request connections;
`db/train.py:main()` opens the training connection. The new validator imports
neither module and does not need credentials.

`db/features.py:load_hourly()` aggregates calls directly using SQL: offered,
answered, abandoned, answered within 30 seconds, and agent seconds per hour.
`db/train.py:complete_hourly_grid()` fills absent hours with zero calls.
`build_features()` expects datetime `hour_start` and a nonempty holiday table
with `holiday_date`; it creates calendar/holiday features and preserves input
rows. It is shared by training and prediction and is not a raw-file cleaner.

`db/aht.py:estimate_aht()` uses answered calls with positive agent time;
zero-agent-time calls must still count toward volume. `db/patience.py` uses
`abandon_sec` for abandoned calls and `in_queue_sec` for answered calls.
These computations can be reused after a future import. No existing raw-file
parsing or cleaning function was found to reuse in this phase.

## Input contract and unknown export mappings

Default headers are the normalized names above, **not claimed sponsor headers**.
Unknown extra columns are ignored and never copied into normalized records.
The five required headers are `start_ts`, `abandoned`, `in_queue_sec`,
`agent_sec`, and `abandon_sec`. Relevant durations are required per call outcome
as a validation policy for downstream estimates; the database itself permits
null durations. Zero durations are allowed, including zero agent time.

* Numeric durations, including numeric text, mean **seconds**. They must be
  finite and nonnegative. No unverified maximum call length is imposed.
  Excel time-of-day cells, duration strings such as `00:05:00`, formulas, and
  other units require an agreed adapter; they are not guessed or evaluated.
* Native Excel datetime cells or ISO text such as `2026-09-01 13:45:00` are
  accepted. Other text formats require `timestamp_format`. Date-only text and
  unformatted numeric serial dates are rejected.
* The README defines timestamps as naive Eastern local wall-clock time.
  Timezone-aware values are rejected, not silently shifted or stripped.
  This phase does not change the existing daylight-saving convention or verify
  whether the sponsor exports timestamps in that convention.
* Abandonment accepts booleans, numeric 0/1, or case-insensitive text
  `true`, `false`, `0`, `1`. Missing or other labels are rejected. Additional
  outcome relationships cannot be inferred until export semantics are known.
* Header names must be unique text on row 1. Blank data rows within the
  worksheet are retained as invalid. Completely empty and header-only files
  fail validation. The first worksheet is used unless selected explicitly.

Duplicate detection runs only when `identifier_column` is explicitly selected
as reliable. Every occurrence of a repeated normalized ID is flagged; no row
is silently chosen as a winner. Missing IDs are errors when checking is enabled.
IDs are trimmed, numeric integer IDs become text, and long numeric IDs must
be supplied as text to avoid Excel precision loss. Leading zeroes in text IDs
are preserved. Source IDs are retained separately, never assigned to `calls.id`.
No comparisons with existing database records occur.

The summary categories are mutually exclusive: valid, invalid, or duplicate.
A row with another validation error counts as invalid even if its ID repeats;
both errors remain available. File-level structural errors make all data rows
invalid. Reports contain canonical field names, Excel row numbers, codes, and
generic messages, never source values or caller information. The Python result
retains normalized data for future use and should not be logged wholesale.

## Run locally

Install the updated pinned requirements into the existing environment:

```bash
uv pip install --python .venv/bin/python -r requirements.txt
uv run python -m db.ingest --file data/monthly_calls.xlsx --dry-run
uv run python -m pytest tests/test_ingest.py -q
```

No database credentials are needed. Workbooks in `data/` remain gitignored.
The validator writes only its JSON report to stdout. Exit codes: 0 for a valid
file, 1 for validation failure (including duplicates), 2 for invalid CLI usage.
A valid report without an identifier still warns that duplicates were not
checked; it does not certify that the data is safe to insert.

For different headers, create a local JSON object mapping normalized fields to
actual headers. For example, **illustrative only**:

```json
{"start_ts": "Call Start", "abandoned": "Was Abandoned"}
```

Unspecified fields keep their normalized header names. Then run:

```bash
uv run python -m db.ingest --file data/monthly_calls.xlsx --dry-run \
  --column-map data/column-map.json --identifier-column "Source Call ID" \
  --timestamp-format "%m/%d/%Y %H:%M:%S" --sheet "Calls"
```

For a future backend, call `parse_excel(binary_stream, column_map=..., ...)`
or `validate_rows(headers, rows, ...)` directly. `result.report()` is suitable
for error display; `result.rows` retains each row and its issues;
`result.valid_records` contains schema-shaped records excluding invalid and
duplicate rows. Always check `result.ok` before any future batch operation.

## How `tests/test_ingest.py` checks the validator

The tests create invented call records rather than reading sponsor files.
`HEADERS` defines a sample header row and `CALL` defines one valid answered call.
Each test can copy that row and change one value to exercise a particular rule.

`workbook_bytes()` uses `openpyxl.Workbook` to build a small Excel workbook,
saves it into an in-memory `BytesIO` stream, and rewinds the stream. Passing that
stream to `parse_excel()` exercises actual `.xlsx` reading and validation
together. The tests do not mock Excel parsing. One test calls `validate_rows()`
directly for timezone-aware datetimes, which Excel cannot normally store.

Most tests follow three steps: prepare a synthetic input, call the validator,
and use `assert` to check the result. For instance,
`test_valid_excel_normalizes_only_database_fields()` verifies that a valid call
passes, durations become floats, the source ID is retained separately, and no
database `id` is invented.

| Test area | Examples in the file | What a failure would reveal |
|---|---|---|
| Structure and empty inputs | `test_missing_required_column_reports_field_and_preserves_counts()`, `test_empty_workbook_or_header_only()` | A missing header or empty file is being accepted, or counts are misleading |
| Dates and durations | `test_invalid_or_missing_timestamps()`, `test_invalid_durations()` | Malformed dates, negative durations, nonnumeric text, or formulas are passing validation |
| Call outcomes | `test_malformed_abandonment()`, `test_durations_required_for_call_outcome()` | An unsupported outcome or missing relevant duration is being accepted |
| Allowed edge cases | `test_abandoned_call_nullable_durations_and_zero_agent_time_are_preserved()` | Valid blanks or zero agent time are being incorrectly rejected |
| IDs and summaries | `test_duplicate_identifiers_flag_every_occurrence_including_conflicts()`, `test_summary_is_disjoint_and_blank_rows_are_not_silently_dropped()` | Repeated calls are escaping detection or rows are being lost/miscounted |
| Configurable exports | `test_configurable_mapping_format_and_optional_routing()` | Alternate headers/date formats no longer normalize correctly |
| Safe errors and CLI | `test_report_does_not_expose_cell_values()`, `test_cli_dry_run_json_exit_codes_and_mapping()` | Reports reveal source values or command output/exit codes are wrong |

`@pytest.mark.parametrize` runs a test repeatedly with different inputs. For
example, the duration test checks six invalid values against four duration
fields, producing 24 cases from one test function. The suite currently has
74 cases; the count is larger than the number of test functions for this reason.

CLI tests call `main()` directly with argument lists. Pytest's `tmp_path` fixture
provides a temporary directory for sample workbooks and mapping files;
`capsys` captures printed output for JSON and privacy checks. One assertion checks
that the workbook's bytes are unchanged after validation. These are validator
tests, not Supabase insertion or model-training tests.

Run this focused suite from the repository root:

```bash
uv run python -m pytest tests/test_ingest.py -q
```

No database credentials, server, or real call records are needed. A passing suite
confirms the implemented input contract; a sanitized sponsor sample is still
needed to confirm that the eventual column mapping and business rules are right.

## Needed before insertion

Obtain a sanitized real export and confirm sheet/header names, timestamp format
and timezone/DST handling, duration units/blank conventions, and abandonment
codes. Confirm whether files contain one row per call or multiple legs, whether
they include outbound calls, and how to identify a complete month. Establish a
stable source ID and its relationship to `calls.id`, then agree on overlapping
exports, corrections, and duplicate conflict handling. Confirm destination data
provenance and database defaults/constraints before implementing writes.
