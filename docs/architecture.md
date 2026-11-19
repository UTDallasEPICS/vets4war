# Architecture

How the app is put together: the processes, the folders, the database tables and who writes
them, the contract between the Node server and the Python script, and the rules both follow so
that they can share one SQLite file. The reasons behind these choices are in
[adr/002_nuxt_rebuild.md](adr/002_nuxt_rebuild.md).

## The processes

There are three, and only one of them is always running.

| Process                          | Runs                                     | Does                                                                |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| The browser                      | on the person's device                   | Shows the pages. The staffing console recomputes staffing itself.   |
| The Nuxt server (Node 22, Nitro) | always                                   | Serves the pages and the whole API, reads uploads, starts retrains. |
| The retrain script (Python 3.12) | only during a run, started by the server | Trains the model and writes the forecast into the database.         |

Python never answers a request and never listens on a port. Everything a request needs is
already in the database, and the arithmetic on top of it (Erlang, staffing, the shift roll-up)
is TypeScript.

## Where things are

```
app/                      the pages and what they are made of
  pages/                  index.vue (console), auth.vue (sign-in), admin.vue (three tabs)
  components/console/     the staffing console
  components/admin/       UploadsPanel, RunsPanel, PeoplePanel and their parts
  composables/, utils/    page logic; utils/console/ holds the console's arithmetic
  middleware/auth.global.ts   page guard: signed out -> /auth, non-admins away from /admin
shared/                   code used by BOTH the pages and the server
  types/api.ts            every request and response type of the API
  utils/                  erlang.ts, staffing.ts, dates.ts, format.ts, constants.ts
server/
  api/                    one file per route; each only reads the request and calls a service
  middleware/auth.ts      the API gate (session, admin prefix, origin of writes)
  utils/env.ts            reads and checks the environment once, at start
  utils/forecast/         the read side: parameters, the stored forecast, the arithmetic
  utils/ingest/           the upload side: workbook reader, per-day plan, import
  utils/retrain/          the runner that starts and watches the Python script
  utils/users.ts          people and roles
  plugins/                what runs at server start (first admins, recovery of runs and uploads)
  tasks/retrain/tick.ts   the scheduled check
  db/schema.ts            EVERY table; db/seed.ts and db/admins.ts for the first admins
drizzle/                  the generated SQL migrations
forecast/                 the Python project
  db/                     the package: retrain.py (the script), store.py (the only module that
                          opens the database), the model, the backtest, the staffing math
  tests/                  pytest
  tools/                  generators of SYNTHETIC data and workbooks, for tests and demos
  models/                 the reference model trained on the real data before the rebuild
  docs/                   the model's research record
scripts/                  copy-from-postgres.ts, forecast-setup.sh, e2e.mjs, parity/, lib/
tests/                    unit/, server/, nuxt/ (Vitest) and parity/ (TypeScript against Python)
docs/                     these guides
```

Service code under `server/utils/` takes the database as its first argument and imports what
it needs explicitly. That is what lets the tests in `tests/server/` run each service against
an in-memory database without starting a server.

## A request, step by step

1. `server/middleware/auth.ts` runs first for every `/api/` path. The rules themselves are in
   `server/utils/access.ts`:
   - `/api/auth/**` and `/api/health` pass without a session;
   - no session: 401 `unauthorized`;
   - a path under `/api/admin/` and the person is not an admin: 403 `forbidden`;
   - a `POST`, `PUT`, `PATCH` or `DELETE` whose `Origin` header is not the origin of
     `BETTER_AUTH_URL`: 403 `forbidden`. This is the protection against another website
     using a signed-in person's cookie.
2. The route file reads the input and calls its service. Admin routes call `requireAdmin`
   again, so a route stays protected if it is ever moved.
3. Errors are thrown through `apiError()` (`server/utils/http.ts`), which gives every error
   the same JSON shape: `statusCode`, `statusMessage`, `message`, `data.code`.

Pages are guarded separately by `app/middleware/auth.global.ts`. That guard is for
navigation only; the API never relies on it.

### How a forecast answer is made

`GET /api/forecast` reads, in one read transaction, the state row, the stored hours of the
requested dates, the handle-time table and the holidays (`server/utils/forecast/store.ts`).
For each hour it then runs the staffing chain of `shared/utils/staffing.ts`:

```
predicted calls x handle time            -> load
Erlang A (or C) at the answer target     -> people needed on the phones
/ staff efficiency, rounded up           -> people to schedule
compared with the shift cap              -> flagged, never cut
```

and rolls the hours up into the three shifts (`server/utils/forecast/compute.ts`). The Erlang
arithmetic is ordinary CPU work on the server's one thread, so it is done one day at a time
and the server handles other requests between days. The accepted ranges of the parameters
(`shared/utils/constants.ts`) exist for the same reason: outside them one request could keep
the server busy for seconds per day of range.

The staffing console calls `/api/forecast` once per date range. When you move the efficiency
or the answer target, it recomputes in the browser with the same shared functions.

## The database

One SQLite file, named by `DATABASE_URL`. `server/db/schema.ts` defines every table and
`drizzle/` holds the migrations generated from it (`pnpm db:generate` after a schema change,
`pnpm db:migrate` to apply). **Python never creates or alters a table.**

Conventions:

- The four sign-in tables (`user`, `session`, `account`, `verification`) keep Better Auth's
  camelCase column names. All other tables use snake_case, because Python reads them.
- Timestamps are whole unix seconds. Booleans are 0 and 1. JSON columns hold JSON text.
- Dates are text, `YYYY-MM-DD`.
- A call's start time is text, `YYYY-MM-DDTHH:MM:SS`. It is the wall-clock time of the line
  (US Eastern), exactly as the phone system exports it, with no time zone and never
  converted. On the Sunday the clocks go forward the 02:00 hour is empty; on the Sunday they
  go back the 01:00 hour holds two hours of calls.

The tables and who writes them:

| Table                                        | Holds                                                               | Node writes                                      | Python writes                               |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `user`, `session`, `account`, `verification` | people, their role, sessions, sign-in codes                         | Better Auth, the people routes, first admins     | never                                       |
| `uploads`                                    | one row per uploaded file (or per copy from Postgres)               | yes                                              | never                                       |
| `upload_rows`                                | the calls of a file that was read but not imported yet              | yes                                              | never                                       |
| `calls`                                      | the call history the model learns from                              | on import only (insert, delete on a replacement) | never (reads it)                            |
| `replaced_calls`                             | what a day replacement removed from `calls`                         | on import                                        | never                                       |
| `data_state`                                 | one row: the data revision and the "run again" flag                 | yes                                              | never (reads it)                            |
| `holidays`                                   | the official holidays by date                                       | the copy from Postgres only                      | adds missing official holidays at each run  |
| `forecast_runs`                              | one row per retrain or refresh                                      | creates rows, records how a run ended            | its own row; creates the row of a shell run |
| `model_artifacts`                            | trained models (the model text and its description)                 | never                                            | yes                                         |
| `forecast_hours`                             | predicted calls per date and hour, with and without holidays        | never                                            | yes                                         |
| `forecast_cells`                             | handle time and real-call share per weekday and hour                | never                                            | yes                                         |
| `forecast_state`                             | one row: which run and model are being served, and from which calls | never                                            | yes                                         |

Two numbers tie the two sides together:

- `data_state.calls_revision` goes up by one with every import that changes `calls`.
- `forecast_state.calls_revision` is the revision the serving forecast was computed from.

When they differ, the forecast is behind the data. `/api/status` reports that as
`forecast.stale`, the console and the runs tab say so, and the scheduled check and the
server start use it to decide whether a retrain is owed.

The model is in the database, not on disk: a new container with the same database file
serves the same forecast. `model_artifacts` keeps the five newest models and the one being
served; older ones are deleted when a forecast is written.

## The contract between Node and Python

The server starts the script like this (`server/utils/retrain/runner.ts`):

```
<V4W_PYTHON> -m <V4W_RETRAIN_MODULE> --db <absolute path> --run-id <id> --mode <full|forecast-only>
```

- working directory `V4W_FORECAST_DIR`; the environment of the server plus
  `PYTHONUNBUFFERED=1`; no input; output and errors captured (the last 16 KB are kept on the
  run row as its log);
- in its own process group, so that stopping a run also stops the worker processes of the
  check.

Rules both sides keep:

1. **The run row is the truth.** The server creates a `forecast_runs` row with status
   `queued` and passes its id. The script claims it (`running`), and at the end writes the
   outcome on it in the same transaction as the forecast. The exit code only repeats it:

   | Exit | Row status  | Meaning                                                                    |
   | ---- | ----------- | -------------------------------------------------------------------------- |
   | 0    | `succeeded` | The forecast was written.                                                  |
   | 3    | `rejected`  | The new model did not beat the baseline.                                   |
   | 2    | `failed`    | Refused for a reason in the data or the arguments; the message says which. |
   | 1    | `failed`    | An unexpected error.                                                       |
   | 4    | none        | `--verify-reference` only: the fingerprints differ.                        |

2. **A row is run once.** The script claims only a row that is still `queued`, and writes
   only while its row is `running`. A process the server has given up on (after a restart,
   say) can therefore not overwrite the row or swap in a forecast behind a newer run.
3. **The server fills in only what the script could not.** If the script never started, was
   stopped, or died, the server records `failed` (or `interrupted` when the server itself was
   stopping) with a sentence that says which.
4. **One run at a time.** A request during a run sets a flag instead of starting a second
   process; one more retrain starts when the current run ends.
5. **Nothing the script prints contains a call record.** It prints counts, dates and the
   check table. An unexpected error is reported by its type and the place it happened, not
   by its text, because the text could quote a stored value.
6. **A run a person starts from a shell** has no row yet, so the script creates one with
   trigger `cli`. While it works it holds a lock on a small file next to the database,
   `<database file>-cli-run-<id>.lock`. The server shows the run as active as long as that
   lock is held and never stops it.

The last line the script prints is `V4W_RESULT {...}` with the run id, the status, the model
id and the model's fingerprint.

What a run does, step by step, is in [retraining.md](retraining.md#what-a-run-does). How
the two processes are started, stopped and cleaned up is in
[retraining.md](retraining.md#the-runner-and-the-script-as-processes).

## Sharing one SQLite file

Two programs write the same file. These rules keep them out of each other's way; break one
and the result is "database is locked" errors or a page that shows half of one forecast and
half of another.

- **The journal mode stays `delete`** (SQLite's default). Never switch to WAL: the file may
  sit on network storage, where WAL does not work.
- **Every connection waits for a lock instead of failing**: 15 seconds in Node
  (`server/utils/db.ts`), 30 seconds in Python (`forecast/db/store.py`).
- **A transaction that reads and then writes starts as a write transaction.** In Node that
  is `db.transaction(fn, { behavior: 'immediate' })`; in Python `BEGIN IMMEDIATE`. A
  transaction that starts with a read and asks for the write lock later is refused at once
  by SQLite when the other side holds the lock; it does not wait.
- **One answer, one read transaction.** Everything a response needs is read inside one
  transaction, so a forecast that is swapped in between two reads cannot be mixed into one
  answer.
- **The forecast is swapped in one write transaction.** Python reads the calls and the data
  revision in one read transaction, computes for as long as it needs with no transaction
  open, then writes the model, the forecast tables, the state row and its run row in a
  single `BEGIN IMMEDIATE ... COMMIT`. A reader sees the old forecast or the new one.
- **Long writes are cut into short ones.** An upload is staged 5,000 rows per transaction.
  The import itself is one transaction, so a day is never half replaced.

One thing to know about the wait: in Node it is synchronous. While a write waits for
Python's lock, the whole server waits with it. A run holds the write lock only briefly
(about a quarter of a second for the final swap, measured on synthetic data in a test
sandbox), but on slow storage every such pause is longer. See
[deployment.md](deployment.md#the-database-file).

## Time

- The line works in US Eastern time. Call times are stored as that wall-clock time.
- "Today" is the date in `America/New_York`, wherever the server runs: for the default date
  range of the API, for the rule that only finished days can be imported, and for how far
  ahead the forecast is written.
- The schedule (`V4W_RETRAIN_CRON`) is in the server's local time, which is UTC in the
  image.
- Timestamps in API answers (`created_at`, `generated_at`, ...) are ISO 8601 in UTC.

## What never leaves the server

Call records are never returned by a route, staged or stored: answers carry counts, days and
messages. Error messages about a file name the sheet, the column and the Excel row numbers,
never a cell's value. The name of an uploaded file is used for display only; on disk the
file gets a random name in a private temporary folder and is deleted as soon as it has been
read. The server log and a run's stored output follow the same rule.
