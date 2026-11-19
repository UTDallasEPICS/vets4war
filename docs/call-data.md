# Call data: loading it, checking it, replacing a day

The forecast is only as good as the calls it learns from, so getting call records in is the
one place where the app is deliberately strict: it refuses what it does not recognise instead
of guessing, it shows what every day of a file would do before anything changes, and an
admin has to confirm.

This guide covers the upload flow, every refusal and its message, the limits, how a day is
replaced and how to put it back, the one-time copy from the old database, and what has not
been proven about real files.

## What a call record is

One row per call:

| In the workbook | Stored as      | Meaning                                                 |
| --------------- | -------------- | ------------------------------------------------------- |
| `Start_Date`    | `start_ts`     | The day the call started.                               |
| `start_time`    | `start_ts`     | The time of day it started, to the second.              |
| `InQueue`       | `in_queue_sec` | Seconds waiting in the queue.                           |
| `Agent_Time`    | `agent_sec`    | Seconds with a peer on the phone.                       |
| `Abandon_Time`  | `abandon_sec`  | Seconds until the caller hung up, when they did.        |
| `Routing_Time`  | `routing_sec`  | Seconds in routing.                                     |
| `Abandon`       | `abandoned`    | `Y` when the caller hung up before an answer, else `N`. |

Nothing that identifies a caller is read or stored. Other columns of the export (the skill
name, an hour column) are ignored.

Times are the wall-clock time of the line (US Eastern), as the phone system exports them.
They are stored without a time zone and never converted.

## Which files are understood

An `.xlsx` workbook. A sheet counts as a call-records sheet when its **first row** holds all
seven column names above, in any order and with any other columns beside them. Every such
sheet is read; all other sheets are skipped. That covers the three layouts the old tool's
tests describe: the plain export with one sheet, the workbook with summary sheets in front
of the calls, and the multi-year workbook with one sheet per year. (They were tried as
generated files in those layouts, not as real ones: see the last section.)

What a cell may hold:

- `Start_Date`: a date cell, or text like `2026-11-10` or `11/10/2026`.
- `start_time`: a time cell, or text like `8:05:00`.
- The four durations: a number, or text that is a plain number. Not empty, not negative.
- `Abandon`: `Y` or `N`, in either case.
- A formula cell is read by the value Excel last stored for it.
- A row whose seven cells are all empty is skipped (Excel leaves such rows at the end). A row
  with only some of them filled is a bad row, not a skipped one.

A sheet with a title row or an empty row above the header is not recognised as a call sheet.
In a workbook with several sheets such a sheet is skipped without a message, and only the
day counts of the report show that its calls are missing. This is one reason to read the
report before importing.

## The upload, step by step

On the admin page, tab **Call data**.

1. **Choose the file.** The browser sends it; the server answers at once and reads the file
   in the background. The page says "Reading the file. Large files take up to a minute." and
   asks every second whether it is done. Only one file is read at a time.
2. **Read the report.** Nothing has changed yet. The page shows the first and last day in
   the file, the number of calls, and for every day what importing would do:

   | The page says  | Status in the API | Meaning                                                     |
   | -------------- | ----------------- | ----------------------------------------------------------- |
   | New            | `new`             | No calls are stored for that day.                           |
   | Already loaded | `identical`       | The stored calls of that day are exactly those in the file. |
   | Different      | `conflict`        | Other calls are stored for that day.                        |

   Days in a row with the same outcome are shown as one line ("2025-01-01 to 2026-11-08
   (677 days)"); "Show all N days" lists them. A day that is Different always has its own
   line.

   Because the export has no call id, "the same calls" means: the same number of calls on
   that day, and the same set of values (start time to the second, the four durations to
   three decimals, the abandon flag).

3. **Confirm.** Type the number of rows your export has (without the header row). It must
   equal the number of calls the app read. If days are Different, tick "Replace N day(s)":
   the button stays disabled until you do.
4. **Import.** One transaction adds the new days, replaces the days you confirmed and leaves
   the days that are already loaded alone. Either all of it happens or none of it.
5. **The retrain.** A retrain starts by itself and the page follows it: "Retraining (run 5):
   12 s so far", then "Retrain (run 5): Done" with the run's message, or "Failed" with the
   reason. If a run was already working, the page says so; another retrain starts when that
   one ends and reads this file.

A file that was checked but not imported can be discarded (the **Discard** button in the
list of recent uploads). One that nobody imports is discarded automatically after 7 days.

What an upload's status means:

| On the page           | In the API  | Meaning                                                                  |
| --------------------- | ----------- | ------------------------------------------------------------------------ |
| Reading               | `parsing`   | The file is being read.                                                  |
| Checked, not imported | `ready`     | The report is there; waiting for your decision.                          |
| Cannot be imported    | `invalid`   | The file has problems; the report lists them.                            |
| Imported              | `imported`  | Its calls are in.                                                        |
| Discarded             | `discarded` | Thrown away, by hand or after 7 days.                                    |
| Could not be read     | `failed`    | Reading stopped (a damaged file, or the server restarted while reading). |

(The API also lists a status `importing`. Nothing sets it today, because an import is a
single short transaction.)

## Refusals

Each refusal names what is wrong and what to do. A message never contains a cell's value:
it names the sheet, the column and the Excel row numbers.

### When the file is sent

| HTTP | `data.code`      | Message                                                                                                   |
| ---- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| 413  | `too_large`      | The file is larger than the upload limit of 40 MB. Split it into smaller files (one year per file works). |
| 400  | `not_a_workbook` | This file is not an Excel workbook (.xlsx). Export the call records as .xlsx and try again.               |
| 422  | `validation`     | file: Choose a .xlsx file to upload.                                                                      |
| 429  | `busy`           | Another file is being read right now. Try again in a few seconds.                                         |

A file that is not a zip archive at all is refused here with `not_a_workbook`. That includes
an old `.xls` file and a password-protected workbook; the message does not say which.

Sending the same file again while it is still being read, or while it waits for your
decision, is not an error: the answer is the earlier upload.

### In the report

These appear in `report.file_errors` and at the top of the report on the page. A file with
any of them is `invalid` and cannot be imported. The parts in angle brackets vary.

- **`not_a_workbook`**: "This file is not an Excel workbook (.xlsx). Export the call records
  as .xlsx and try again." The file is an archive but not a workbook, or it is damaged.
  Export it again. One special case has its own sentence: "Two or more sheets of this
  workbook share one worksheet. Export the file again."
- **`too_large_unpacked`**: "The workbook unpacks to <N> MB; the limit is 600 MB. Split it
  into smaller files." or "The workbook holds <N> parts; the limit is 2,000. Export the call
  records again as a plain .xlsx." One year per file works.
- **`too_many_sheets`**: "The workbook has <N> sheets; the limit is 32. Remove the sheets
  that do not hold call records, or split the file."
- **`no_call_sheet`**: "No sheet in this workbook holds call records: none has the header row
  Start_Date, start_time, InQueue, Agent_Time, Abandon_Time, Routing_Time, Abandon. Check it
  is the call-records export." Look at the first row of the sheet with the calls.
- **`missing_columns`**: "Sheet "<name>" is missing the column <names>. A call-records sheet
  needs Start_Date, start_time, InQueue, Agent_Time, Abandon_Time, Routing_Time, Abandon."
  Shown when no sheet has all seven names but one has at least four of them.
- **`bad_rows`**: "Sheet "<name>": <problem> on Excel row 9." With several rows it lists them
  ("Excel rows 9, 12 and 15"), at most ten, then "and <N> more". Fix those rows in the source
  and export again.
- **`too_many_rows`**: "The file has more than 750,000 calls; the upload limit is 750,000.
  Split it into smaller files."
- **`day_out_of_range`**: "The file has calls dated before 2010-01-01 (<days>). This line has
  no calls that old, so the dates were not read as they were meant. Open the file in Excel,
  check that the Start_Date column shows the real call dates, and export it again." Do not
  work around this one: it means dates were misread.
- **`day_not_finished`**: "Only finished days can be imported; the file includes <days>.
  Export up to <yesterday>." Today is today in New York.
- **`partial_day`**: "The file starts or stops part-way through a day (<days>). Export whole
  days."
- **`day_on_two_sheets`**: "The same calls for <days> appear on more than one sheet. Remove
  the copy so each call is in the file once."

The `<problem>` of a `bad_rows` message is one of:

- `Start_Date is not a date`
- `start_time is not a time of day (H:MM:SS)`
- `InQueue is empty`, `InQueue is not a number`, `InQueue is negative` (the same three for
  `Agent_Time`, `Abandon_Time` and `Routing_Time`)
- `Abandon is empty`, `Abandon is not Y or N`
- `<column> holds an Excel error value (such as #N/A)`

How two of the checks decide:

- **A day is "part-way"** when the first day of the file has no call in its first three
  hours, or the last day has none in its last three hours. The line takes calls around the
  clock, so that pattern means the export was cut.
- **A day on two sheets** is fine when the two sheets hold different calls of that day (the
  multi-year workbook splits the turn of the year that way; the report then carries a
  warning). It is refused when the same call appears on both, because it would be stored
  twice.

### Warnings

A warning does not stop an import. Read it anyway.

- "After this import, <N> day(s) would have no calls at all: <days>. The forecast cannot be
  retrained while a day in the last 350 days of call data has no calls. Load the calls of
  these days too (in this file or another one); until then the forecast in use stays as it
  is." You may import, but the retrain that follows will fail until the missing days are
  loaded.
- "<N> date(s) have no calls recorded in this workbook: <days>. They are left untouched."
- "<N> day(s) have calls on more than one sheet and were combined: <days>."

### When the file could not be read at all

The upload ends as "Could not be read" with one of:

- "This file could not be read as call records. Check it is the call-records export and try
  again." The file is damaged, or its contents are not what a workbook should hold. The
  server log has a line `[uploads] upload <id> could not be read: <error type>`.
- "The server restarted while this file was being read. Upload it again."

### On import

All of these answer 409 with `data.code` `conflict`, and the page shows the sentence under
"Not imported":

- "The row count you typed (<N>) is not the file's (<M>)."
- "These days already hold different calls: <days>. Not confirmed: <days>. Nothing was
  changed. Confirm replacing exactly the days that differ." You must confirm exactly the
  days marked Different: not fewer and not more.
- "The stored calls changed since this file was checked. Review the new plan." Somebody
  imported another file in between. The report has been worked out again; read it and
  confirm again.
- "Every day in this file is already loaded. Nothing to import."
- "This upload is <status>. Only a checked file that is ready can be imported."

Discarding an upload that is not `ready`, `invalid` or `failed` answers 409 as well.

## Limits

| Limit                              | Value                 | Set by                |
| ---------------------------------- | --------------------- | --------------------- |
| Size of the uploaded file          | 40 MB                 | `V4W_UPLOAD_MAX_MB`   |
| Calls in one file                  | 750,000               | `V4W_UPLOAD_MAX_ROWS` |
| Size of the workbook once unpacked | 600 MB                | code                  |
| Parts inside the workbook          | 2,000                 | code                  |
| Sheets                             | 32                    | code                  |
| Files being read at the same time  | 1                     | code                  |
| Oldest day accepted                | 2010-01-01            | code                  |
| Newest day accepted                | yesterday (New York)  | code                  |
| How long a checked file is kept    | 7 days                | code                  |
| Days or rows listed in one message | 10, then "and N more" | code                  |

Most of the fixed ones are in `server/utils/ingest/limits.ts`.

The proxy in front of the app may have a lower limit on request size than the app. If large
files are refused before they reach the app, raise that limit, or load the history with the
copy script below and upload one year per file afterwards.

How long it takes, measured on synthetic data in a test sandbox: a workbook of about 388,000
calls on six yearly sheets (14.5 MB) was read and checked in about 12 seconds, during which
the server kept answering other requests. The import of all of it took about 1 second, and
for that second the server does nothing else. Your numbers will differ.

## Replacing a day, and putting it back

When a day in the file is Different from what is stored and you confirm the replacement:

1. the stored calls of that day are copied to the table `replaced_calls` (with the upload
   that replaced them and the upload they came from);
2. they are deleted from `calls`;
3. the file's calls of that day are inserted.

All three happen in the import's one transaction. Nothing is ever deleted without a copy.

To put a day back:

- **The easy way.** Upload the earlier file again. Its day now shows as Different; confirm
  the replacement. (The calls you replace this time are kept in `replaced_calls` too.)
- **Without the earlier file.** The rows are in `replaced_calls`. Stop the server (or make
  sure no retrain or import is running), back up the database file, and run this with any
  SQLite client, with your own day and the id of the upload that did the replacement
  (`replaced_by_upload_id`):

  ```sql
  BEGIN IMMEDIATE;
  DELETE FROM calls WHERE start_ts >= '2026-11-06' AND start_ts < '2026-11-07';
  INSERT INTO calls (start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned, upload_id)
    SELECT start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned, original_upload_id
    FROM replaced_calls
    WHERE replaced_by_upload_id = 5 AND start_ts >= '2026-11-06' AND start_ts < '2026-11-07';
  UPDATE data_state
    SET calls_revision = calls_revision + 1, updated_at = CAST(strftime('%s', 'now') AS INTEGER)
    WHERE id = 1;
  COMMIT;
  ```

  The last statement matters: raising the revision is what tells the app that the calls
  changed. The forecast then shows as behind the data, and the next start, the next
  scheduled check or **Retrain now** retrains on the restored calls.

There is no page to delete a day or to undo an import of new days. If wrong days were added,
a developer has to remove them from `calls` in the same careful way (and raise the
revision).

## Days without calls

The line is open around the clock, so a date with no call at all is taken to be a day that
was not reported, not a quiet day. The report lists such dates inside a file, and warns when
an import would leave one inside the last 350 days of data. The retrain refuses to run
across such a gap ("Cannot retrain: N recent day(s) have no calls at all ..."), because its
check replays those weeks. Load the missing days and retrain.

## The one-time copy from Postgres

The earlier version of this tool read its calls from a Postgres database.
`scripts/copy-from-postgres.ts` brings that history into a new SQLite database in one step.
It is the way to load the multi-year history when the workbook is too large for the proxy in
front of the app, and it also copies the `holidays` table.

```bash
pnpm db:migrate                                          # the SQLite file must exist and be empty of calls
V4W_DATABASE_URL='postgres://...' pnpm tsx scripts/copy-from-postgres.ts            # dry run
V4W_DATABASE_URL='postgres://...' pnpm tsx scripts/copy-from-postgres.ts --commit   # copy
```

`V4W_DATABASE_URL` is the old connection string; it can also stand in `.env`. `DATABASE_URL`
names the SQLite file, as everywhere. Run it while the app is stopped.

The dry run only counts. It prints what it found and what it would do:

```
Postgres: 387,921 calls on 2,138 days, first 2021-01-01T00:09:47, last 2026-11-08T23:59:01; 77 holidays (2021-01-01 to 2027-12-25).
SQLite: migrated, no calls, data revision 0.
Would create upload "postgres copy" (source postgres-copy), insert 387,921 calls, insert the 77 holidays (keeping any already present) and set the data revision to 1.
Dry run: nothing written. Run again with --commit to copy.
```

(These lines are from a run against a synthetic copy of the old database. The real counts
will be different.)

With `--commit` it copies every call and every holiday in one SQLite transaction, records
the copy as an upload named "postgres copy", and raises the data revision. Then start the
app: the server log shows `[retrain] start-up run 1 for call data no run has finished on`,
and the first forecast appears when that run ends.

It refuses, with a line that starts with `Refused:`, when

- `V4W_DATABASE_URL` is not set, or the old database cannot be read (only the error code is
  printed, never the connection string);
- the SQLite file does not exist or is not migrated (`pnpm db:migrate` first);
- the SQLite file already has calls: the copy is for an empty database only, so it cannot be
  run twice;
- the old database has no calls, a call time with a fraction of a second, or a holiday
  without a name;
- the number of calls changed while it was copying.

Things to know:

- It expects the old tables as they were: `calls` with `id`, `start_ts`, `in_queue_sec`,
  `agent_sec`, `abandon_sec`, `routing_sec`, `abandoned`, and `holidays` with `holiday_date`
  and `holiday_name`.
- Call times are read as text and stored as they are. That is only right if the old column
  holds wall-clock time without a time zone. The script does not check the column's type.
- It holds every call in memory while it copies: about 730 MB for about 388,000 calls,
  measured on synthetic data in a test sandbox.
- The holidays it copies are checked by the first retrain. A row that disagrees with the
  calendar rules makes the retrain refuse and name the row; correct or delete it in the
  database.
- It has only ever run against a synthetic copy of the old database.

## Trying it with generated data

There is no real call data in this repository, and you do not need any to see the whole flow.
The tools under `forecast/tools/` write **synthetic** calls, shaped roughly like the line but
drawn from a random generator, and workbooks in the partner's layouts. Every file they write
has SYNTHETIC in its name. Never present such numbers as facts about the real line.

```bash
pnpm forecast:setup
cd forecast
.venv/bin/python tools/gen_synthetic.py ../data/SYNTHETIC --start 2025-01-01 --end 2026-11-17
.venv/bin/python tools/make_workbooks.py ../data/SYNTHETIC
```

`data/` is ignored by git. The second command writes, under `data/SYNTHETIC/workbooks/`:

- `SYNTHETIC V4W Call Records - CY 21 - CY 26.xlsx`: the history through 2026-11-08, one
  sheet per year. Upload this first; the report shows every day as New.
- `SYNTHETIC V4W Call Records - Nov 9th 2026 thru Nov 15th 2026.xlsx`: the following week.
- `SYNTHETIC Nov 16 2026 to Nov 17 2026 - Actual Data for Validity Testing.xlsx`: two more
  days, with summary sheets in front of the calls.
- `negative/`: six files that must be refused or flagged, one per case: a last day cut
  short, days that are already loaded, one day that differs from the stored one, a bad
  abandon flag, a missing column, no call sheet at all.

The report on the page tells you the row count to type. Without `--start`, the generator
begins in 2021: the history workbook then holds about 388,000 calls (14.5 MB) and writing it
takes a few minutes. The three "already loaded", "differs" and "cut short" files make sense
once the history and the following week are in.

With `V4W_DATA_SOURCE=synthetic` the badge on the staffing page says "Synthetic data". Keep
it that way for as long as the database holds generated calls.

## What has not been proven about real files

The reader was written against the layouts the old tool's tests describe, and checked
against the old Python reader on the same generated files: both read the same calls. It was
tested with workbooks written by Python and Node libraries, by LibreOffice, and with
hand-written files in Excel's own markup. **It has never read a file written by Excel
itself or by the partner's phone system.** So for the first real file, read the report
before you confirm: first day, last day, the number of calls against your export, the days.

Known gaps:

- Files saved as "Strict Open XML Spreadsheet": only their way of writing date cells was
  tested.
- A password-protected file is refused as "not an Excel workbook"; the message does not
  mention the password.
- Hidden or filtered rows are read like any other row.
- Merged cells inside the data, external links and pivot tables were not tested.
- Text dates in other spellings ("Nov 10, 2026") are refused as "not a date".
- A time cell that rounds up to 24:00:00 is refused.
- Files with more than about 400,000 calls were not tested.
- A sheet with anything above its header row is not recognised (see "Which files are
  understood").

The reader drives internal steps of the `exceljs` library, which is pinned to version 4.4.0
in `package.json`. Do not upgrade it without running `pnpm test:parity`, which compares the
reader with the Python one file by file.
