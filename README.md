# Vets4Warriors staffing forecast

The Vets4Warriors peer-support line answers calls around the clock. This tool forecasts how
many calls will arrive in each hour of each day, weeks ahead, and turns that forecast into the
number of people to put on the schedule for each hour and for each of the three shifts
(Overnight, Day, Evening).

Two kinds of people use it. Supervisors open the staffing page, pick a date range, see the
recommended staffing, try their own roster against it and export the result. Admins load new
call records (an Excel export of the phone system), which retrains the forecasting model, and
decide who may sign in.

How a number on the page is made:

1. **Call volume.** A LightGBM model learns calls per hour from the stored call history, from
   calendar facts only: hour of day, weekday, weekend, the official holidays, four more days
   the partner asked to treat like holidays (Christmas Eve, New Year's Eve, the days before
   and after Thanksgiving) and the distance to the nearest holiday. The level and the
   hour-of-day shape are then corrected from the most recent weeks. It uses no "calls last
   week" inputs, because the forecast runs weeks ahead and those numbers would not exist yet.
2. **Handle time.** The average talk time per weekday and hour, over answered calls, with
   recent calls weighted more.
3. **Caller patience.** How long callers are willing to wait, estimated from the waiting
   times of all calls and from which callers hung up.
4. **Staffing.** Queueing arithmetic (Erlang A, where callers hang up; Erlang C is available
   in the API) gives the people needed on the phones so that a target share of callers (80% by
   default) is answered within a target time (30 seconds by default). Dividing by staff
   efficiency (the share of a shift a person is free for inbound calls, 65.6% by default)
   gives the number to schedule. Each shift is staffed for its busiest hour. Numbers above
   the partner's cap (7 people per shift, 6 in the Evening) are flagged, never cut.

## How it is built

```
 browser --HTTPS--> Nuxt 4 / Nitro server (Node 22)
                      |- pages: /  (staffing console)   /auth (sign-in)   /admin (admins)
                      |- /api/forecast /staffing /planned /model /status
                      |      read the stored forecast; Erlang and staffing in TypeScript
                      |- /api/admin/uploads   .xlsx -> read -> stage -> plan per day -> import
                      |- /api/admin/runs      start and watch retrain runs
                      |- /api/admin/users     people and roles
                      '- retrain runner --starts--> python -m db.retrain --db <file> --run-id N
                                                      reads   calls, holidays
                                                      writes  the model, the forecast, its run row
                    both sides open the ONE SQLite file named by DATABASE_URL
```

- One Nuxt 4 application (the EPICS Nuxt template: Better Auth, Drizzle, SQLite, Nuxt UI,
  Vitest, pnpm) is the whole website and the whole API.
- One Python script (`forecast/db/retrain.py`) retrains the model and writes the forecast.
  The server starts it; Python never listens on a port.
- One SQLite file holds everything: people, call records, uploads, runs, the trained model
  and the forecast. It is the only state.
- Everything a request needs is computed in TypeScript (`shared/utils/`,
  `server/utils/forecast/`) from the stored forecast, so a page never waits for Python.
- People sign in with a code sent by email. A person is a `viewer` or an `admin`.

The reasons for this shape are in [docs/adr/002_nuxt_rebuild.md](docs/adr/002_nuxt_rebuild.md);
the parts and their contracts are in [docs/architecture.md](docs/architecture.md).

## Quick start

You need Node.js 22, pnpm 10, and for retraining either [uv](https://docs.astral.sh/uv/) or
Python 3.12 (macOS also needs `brew install libomp` for LightGBM).

```bash
git clone <repository-url> vets4war
cd vets4war
pnpm install
cp .env.example .env
```

Open `.env` and set `BETTER_AUTH_SECRET` to your own random text (`openssl rand -hex 32`
prints one). Everything else in the file works as it is for local work: the database is
`dev.db` in this folder, sign-in codes are printed in the server log instead of being mailed,
`admin@example.org` is the first admin, and the data is labelled synthetic.

```bash
pnpm db:migrate       # creates dev.db with every table
pnpm db:seed          # makes the V4W_ADMIN_EMAILS addresses admins (the server also does this on every start)
pnpm forecast:setup   # Python 3.12 environment for retraining, in forecast/.venv
pnpm dev              # http://localhost:3000
```

Open `http://localhost:3000`. Use `localhost`, not `127.0.0.1`: the address must be the one
in `BETTER_AUTH_URL`, or every change you try is refused. You land on the sign-in page. Type
`admin@example.org` and press **Send code**. The terminal that runs `pnpm dev` prints a line
like

```
[auth] sign-in code for admin@example.org: 301190
```

Type the six digits and press **Sign in**. The staffing page opens and says "No forecast yet.
An admin needs to load call data and run a retrain." The **Admin** button leads to the admin
page with its four tabs: **Call data**, **Forecast runs**, **Accuracy** and **People**.

To use another port, start with `pnpm dev --port 3001` and set
`BETTER_AUTH_URL=http://localhost:3001` in `.env`.

There is no real call data in this repository and none is needed to try the app: see
[Trying it with generated data](docs/call-data.md#trying-it-with-generated-data) for a
synthetic workbook you can upload.

## Signing in and the first admin

- Sign-in is by a six-digit code sent to your email address. There are no passwords.
- Sign-up is off. Only an address that an admin added (Admin, **People**) can sign in. An
  unknown address gets the same "a code is on its way" message, no mail and no account, so
  the page never reveals who has access.
- A person is a **viewer** (sees the staffing page) or an **admin** (also loads call data,
  starts retrains and manages people). Nobody can change their own role or remove themselves,
  and the last admin cannot be removed or demoted.
- The first admin comes from configuration: every address in `V4W_ADMIN_EMAILS` is created
  as an admin (or promoted to one) each time the server starts. Removing an address from the
  variable later does not demote that person.
- A session lasts 7 days and is renewed while it is used.
- Locally the code is printed in the server log (`EMAIL_TRANSPORT=console`). A production
  build refuses to start with that setting: it must send real mail (`EMAIL_TRANSPORT=smtp`
  and the `EMAIL_*` values).

Details, the sign-in rate limit and what to configure before going live:
[docs/better_auth.md](docs/better_auth.md).

## Getting the call history in

The forecast is trained on call records: one row per call with its start time, the seconds
it spent in the queue, with an agent, before abandoning and in routing, and whether the
caller hung up. Nothing that identifies a caller is stored. There are two ways in.

**The one-time copy from the old database.** The earlier version of this tool kept the calls
in Postgres. `scripts/copy-from-postgres.ts` copies every call and every holiday into an
empty SQLite database:

```bash
V4W_DATABASE_URL='postgres://...' pnpm tsx scripts/copy-from-postgres.ts            # dry run: counts only
V4W_DATABASE_URL='postgres://...' pnpm tsx scripts/copy-from-postgres.ts --commit   # copy
```

Then start the app: it sees call data that no retrain has read and starts one by itself.

**Uploading workbooks.** On the admin page, tab **Call data**, choose the call-records
export (`.xlsx`). The file is read in the background and nothing is changed yet. The page
then shows what each day of the file would do:

| The page says  | It means                                                    | On import                     |
| -------------- | ----------------------------------------------------------- | ----------------------------- |
| New            | No calls are stored for that day.                           | The day's calls are added.    |
| Already loaded | The stored calls of that day are exactly those in the file. | Nothing happens for that day. |
| Different      | Other calls are stored for that day.                        | Nothing, unless you say so.   |

A day that is **Different** is only touched when you tick "Replace" for exactly those days.
The stored calls of the day are then set aside in a table of their own, and the file's calls
take their place.

To confirm, you type the number of rows of your export; it must equal the number of calls
the app read. Only **whole, finished days** can be imported: a file that includes today, or
that starts or stops part-way through a day, is refused with a sentence that says what to
export instead. After an import a retrain starts by itself.

Every refusal and its message, the limits, how a day is replaced and how to put it back, and
the copy script in detail: [docs/call-data.md](docs/call-data.md).

## Retraining

A **retrain** fits a new model on all stored calls, checks it, and writes a new forecast. A
**forecast refresh** keeps the model in use and only moves the forecast forward (and
recomputes handle time and caller patience from the stored calls).

A run starts in one of these ways:

- **After an import.** Every import of call data starts a retrain (`V4W_RETRAIN_ON_IMPORT`).
- **On the schedule.** Once a day (08:30 server time by default) the server checks: call data
  that no run has finished on gets a retrain; a forecast older than 20 hours gets a refresh.
- **By hand.** Admin, **Forecast runs**: **Retrain now** or **Refresh forecast**.
- **At server start**, when call data is waiting that no run has finished on.
- **From a shell** (below).

Only one run works at a time. A request that arrives during a run does not start a second
one: one more retrain is queued and starts when the current one ends.

**The check against the simple baseline.** Before a new model is used, the script replays
the last 26 weeks: for each week it trains on everything before it, forecasts the following
days without seeing them, and compares the result with what happened. The same is done for a
simple baseline (for each weekday and hour, the median of the last 8 weeks). The new model is
kept only if its daily error over the next 14 days is lower than the baseline's.

How a run ends, as the admin page words it:

- **Done.** The forecast was written: with a new model (retrain) or with the model in use
  (refresh).
- **Kept the previous model.** The new model did not beat the simple baseline, so it was
  thrown away. The previous model stays in use; the forecast, handle time and caller
  patience were still refreshed from the new calls.
- **Rejected, nothing served.** The same, but there was no previous model to keep (the very
  first retrain). There is no forecast yet.
- **Failed.** The run stopped. Its message says why and what to do (for example, a day
  without any calls inside the last 350 days of data). The forecast in use did not change.
- **Interrupted.** The server stopped or restarted during the run. If call data is still
  waiting for a retrain, the next start begins one.

**Running the script yourself.** From a shell on the machine that holds the database:

```bash
cd forecast
.venv/bin/python -m db.retrain --db /absolute/path/to/dev.db                        # full retrain
.venv/bin/python -m db.retrain --db /absolute/path/to/dev.db --mode forecast-only   # refresh
```

`--db` must be an absolute path. The server may be running: it shows such a run as "Command
line" and treats it as the run in progress.

Triggers, statuses, the schedule and its time zone, timeouts, every failure message and what
to do about it: [docs/retraining.md](docs/retraining.md).

## The staffing console

The page at `/` is one screen for a supervisor.

- **Top bar.** The period shown, a badge that says what the data is (`Synthetic data` or
  `Partner data`, with the date range of the calls behind the forecast), a switch between
  **Date range** and **One day**, light or dark, three exports (a printable report, a CSV
  of every hour, an image of the grid), **Admin** for admins, **Sign out**.
- **Settings.** The dates (up to 366 days, inside the range the forecast covers), staff
  efficiency, the share of calls to answer in time and within how many seconds, which hours
  to show, and whether holiday effects are applied. Changing efficiency or the answer target
  recomputes in the browser at once.
- **With your roster.** Three sliders, one per shift, for the people actually scheduled. The
  card shows the hang-ups to expect with that roster, their share of calls and the share
  answered in time. **Current 4/4/6** puts the sliders back to 4, 4 and 6 people; **Use
  recommended** sets each shift to its recommended peak, never above the cap.
- **If staffed as recommended.** The same numbers when every hour is staffed as the grid
  says, the hang-ups with one person fewer, and hang-ups by shift for both rosters.
- **Four totals.** Predicted calls, real calls (those with more than 2 minutes of talk
  time), expected talk time, and person-hours to schedule.
- **Hang-ups day by day.** One pair of bars per day: your roster against the recommendation.
  Click a day to open it.
- **People to schedule, hour by hour.** One row per day, one column per hour, grouped into
  the three shifts. Each cell is the number of people to schedule for that hour. A cell at
  the shift cap is outlined, a cell over the cap is red and also shows the service level you
  would get at the cap. After each shift comes its **Roster** cell: the shift's peak, which
  you can overwrite with your own number (kept in this browser only). Click an hour or a day
  for the full chain behind it; drag across cells for a total.
- **One day** shows a single day hour by hour: predicted calls, the recommendation and your
  roster, with the hours that miss your answer target marked.
- **Notes.** While new call data is being processed, or when it was loaded but the forecast
  could not be updated, a note above the cards says so and says which calls the forecast
  still uses.
- **When there is nothing to show**, the page says why: there is no forecast yet, the dates
  are outside what the forecast covers, or the caller patience measured from the call data
  is implausibly short and an admin has to correct the data.

The console always uses Erlang A with the measured caller patience and the default
handle-time weighting; those are parameters of the API, not controls on the page. It loads
its font from Google Fonts in the browser; without that access it falls back to a system
font.

## The API

Every route is under `/api`. Apart from the health check and the sign-in routes, a request
needs the session cookie; without it the answer is 401. Field names are snake_case. All
types are in `shared/types/api.ts`.

| Route                                | Who       | What it does                                                                                 |
| ------------------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| `GET /api/health`                    | anyone    | `{ timestamp }`, status 200, for load-balancer probes.                                       |
| `/api/auth/**`                       | anyone    | Better Auth: ask for a code, sign in, read the session, sign out.                            |
| `GET /api/forecast`                  | signed in | One row per hour with the whole chain, the shifts of each day, and the totals of the window. |
| `GET /api/staffing`                  | signed in | The shifts of each day only. Same parameters as `/api/forecast`.                             |
| `POST /api/planned`                  | signed in | Judges a roster against the recommendation, shift by shift.                                  |
| `GET /api/model`                     | signed in | What the model in use was trained on, and its check table. 404 before the first model.       |
| `GET /api/status`                    | signed in | Who you are, what is served, whether the calls are newer than the forecast, the latest run.  |
| `GET /api/admin/runs`                | admin     | The last 30 runs, the active one, and how many calls are stored.                             |
| `GET /api/admin/runs/:id`            | admin     | One run with its check table and the end of its output.                                      |
| `POST /api/admin/runs`               | admin     | Starts a retrain or a forecast refresh. Answers 202 with the run.                            |
| `POST /api/admin/uploads`            | admin     | Takes a workbook, answers 202 and reads it in the background.                                |
| `GET /api/admin/uploads`             | admin     | The last 50 uploads.                                                                         |
| `GET /api/admin/uploads/:id`         | admin     | One upload with its per-day report. The page polls this while the file is read.              |
| `POST /api/admin/uploads/:id/import` | admin     | Imports a checked file. Answers `{ upload, run, queued }`.                                   |
| `DELETE /api/admin/uploads/:id`      | admin     | Discards a file that was checked but not imported.                                           |
| `GET /api/admin/users`               | admin     | Everyone who may sign in.                                                                    |
| `POST /api/admin/users`              | admin     | Adds a person. Answers 201.                                                                  |
| `PATCH /api/admin/users/:id`         | admin     | Renames a person or changes the role.                                                        |
| `DELETE /api/admin/users/:id`        | admin     | Removes the person and ends their sessions.                                                  |

What the write routes take:

- `POST /api/planned`: the forecast parameters below as JSON, with `start` and `end`
  required, plus `planned: [{ "date", "shift", "planned" }]` (at most 1,098 entries, each
  `planned` a whole number from 0 to 1000). Each entry comes back with the recommendation,
  the difference, a verdict (`understaffed`, `on target`, `overstaffed`,
  `exceeds capacity`) and the service level and hang-ups at the planned number.
- `POST /api/admin/runs`: `{ "mode": "full" }` (the default) or `{ "mode": "forecast-only" }`.
  While a run is active nothing new starts: the answer is that run with `queued: true`, and
  one more run follows it: a retrain if any request (or an import) asked for one, else a
  refresh. `GET /api/admin/runs` shows it as `queued` (`mode`, `trigger`, `requested_by`).
- `POST /api/admin/uploads`: a multipart form with one part named `file`. The same file
  sent again while it is still being read, or while it waits for a decision, answers 200
  with the earlier upload.
- `POST /api/admin/uploads/:id/import`: `{ "total_rows": 1313, "replace_days": [] }`. The
  row count must be the file's, and `replace_days` must be exactly the days the report
  marks as different.
- `POST /api/admin/users`: `{ "email", "role", "name"? }`; `PATCH`: `{ "name"?, "role"? }`.

No route returns call records: only counts, days and messages.

Parameters of `GET /api/forecast` and `GET /api/staffing`:

| Parameter          | Accepted                                                | Default                                   |
| ------------------ | ------------------------------------------------------- | ----------------------------------------- |
| `start`, `end`     | a real calendar date, `YYYY-MM-DD`                      | today and today + 29 days (New York time) |
| `efficiency`       | 0 to 1                                                  | `0.65625`                                 |
| `target_pct`       | greater than 0, at most 0.999                           | `0.8`                                     |
| `target_sec`       | 0 to 300                                                | `30`                                      |
| `queue_model`      | `erlang_a` or `erlang_c`                                | `erlang_a`                                |
| `patience_sec`     | 10 to 3600                                              | the patience measured from the calls      |
| `recency`          | `equal`, `weighted` or `recent` (handle-time weighting) | `weighted`                                |
| `include_holidays` | `true` or `false`                                       | `true`                                    |

A window may be at most 366 days and must lie inside the range the forecast covers: from the
first day of call data to 800 days past the day the forecast was last written (or past the
last call day, if that is later).

An error is always JSON with `statusCode`, `statusMessage`, `message` (a sentence for a
person) and `data.code` (what a program should branch on):

| Status | `data.code`            | When                                                                                                      |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`         | No session.                                                                                               |
| 403    | `forbidden`            | Not an admin on an `/api/admin/` route, or a change sent from another site.                               |
| 422    | `validation`           | A field is missing, mistyped or out of range. `data.issues` lists every problem.                          |
| 400    | `end_before_start`     | `end` is before `start`.                                                                                  |
| 400    | `range_too_long`       | More than 366 days.                                                                                       |
| 400    | `outside_horizon`      | The dates are outside what the forecast covers. `data.horizon` says what it covers.                       |
| 400    | `unreachable_target`   | No staffing level up to 1,000 people meets the answer target in some hour.                                |
| 400    | `efficiency_zero`      | `/api/planned` with efficiency 0: there is no roster to judge.                                            |
| 400    | `outside_window`       | `/api/planned`: a roster entry is not inside the requested dates.                                         |
| 400    | `not_a_workbook`       | The uploaded file is not an `.xlsx` workbook.                                                             |
| 404    | `not_found`            | Unknown id, or `/api/model` before the first model.                                                       |
| 409    | `conflict`             | The state does not allow it; the message says why (see the guides).                                       |
| 413    | `too_large`            | The upload is over `V4W_UPLOAD_MAX_MB`.                                                                   |
| 429    | `busy`                 | Another file is being read right now. `Retry-After: 5`.                                                   |
| 500    | `internal`             | The stored forecast is incomplete; run a retrain.                                                         |
| 503    | `no_forecast`          | No forecast yet: load call data and run a retrain.                                                        |
| 503    | `implausible_patience` | The caller patience measured from the calls is under 10 seconds: the waiting times in the data are wrong. |

Until the data behind an `implausible_patience` answer is fixed, a request that sends its
own `patience_sec`, or `queue_model=erlang_c`, is still answered.

## Environment variables

`.env.example` lists every variable with a comment. `pnpm dev` reads `.env`; a production
build does not: give it real environment variables, or start it with `pnpm start`, which
passes `.env` to it. (With the `.env` of the quick start `pnpm start` refuses to run,
because printing sign-in codes to the log is allowed under `pnpm dev` only.)

| Name                        | Default                | Meaning                                                     |
| --------------------------- | ---------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`              | `file:./dev.db`        | The SQLite file.                                            |
| `BETTER_AUTH_SECRET`        | required               | Signs session cookies. Long random text.                    |
| `BETTER_AUTH_URL`           | required               | The address people type in the browser, exactly.            |
| `EMAIL_TRANSPORT`           | `smtp`                 | `smtp` mails the sign-in code; `console` logs it.           |
| `EMAIL_HOST`                | required with `smtp`   | The mail server.                                            |
| `EMAIL_USER`, `EMAIL_PASS`  | required with `smtp`   | Its login.                                                  |
| `EMAIL_FROM`                | required with `smtp`   | The sender address.                                         |
| `EMAIL_PORT`                | `587`                  | Its port.                                                   |
| `EMAIL_SECURE`              | `false`                | `true` = TLS from the first byte.                           |
| `V4W_ADMIN_EMAILS`          | empty                  | Addresses made admins on every server start.                |
| `V4W_DATA_SOURCE`           | not set                | `partner` or `synthetic`: what the badge says the data is.  |
| `V4W_FORECAST_DIR`          | `./forecast`           | Where the Python project is.                                |
| `V4W_PYTHON`                | see below              | The Python that runs the retrain script.                    |
| `V4W_RETRAIN_MODULE`        | `db.retrain`           | The module the server starts. Leave it alone.               |
| `V4W_RETRAIN_ON_IMPORT`     | `true`                 | Start a retrain after every import.                         |
| `V4W_RETRAIN_SCHEDULE`      | `on`                   | `off`: the scheduled check does nothing.                    |
| `V4W_RETRAIN_CRON`          | `30 8 * * *`           | When the scheduled check runs. Read at build time.          |
| `V4W_RETRAIN_TIMEOUT_MIN`   | `60`                   | Minutes (1 to 1440) after which a run is stopped as failed. |
| `V4W_GATE_WORKERS`          | see below              | Worker processes of the check against the baseline.         |
| `V4W_HORIZON_DAYS`          | `800`                  | How many days ahead the forecast is written.                |
| `V4W_HOLIDAYS_THROUGH_YEAR` | see below              | Last year of official holidays kept in the database.        |
| `V4W_UPLOAD_MAX_MB`         | `40`                   | Largest upload, in MB.                                      |
| `V4W_UPLOAD_MAX_ROWS`       | `750000`               | Most calls in one file.                                     |
| `PORT`, `HOST`              | `3000`, all interfaces | Where the server listens.                                   |
| `V4W_DATABASE_URL`          | none                   | The old Postgres database, for the one-time copy.           |
| `V4W_DEV_API_PROXY`         | not set                | `pnpm dev` only. Leave it unset.                            |

- `DATABASE_URL`: a relative path starts at the folder the server starts in.
- `BETTER_AUTH_URL`: when the browser's address is another one, people can still sign in
  and read, but every change and signing out are refused with 403. So it must be the public
  address, with `https` in a deployment.
- `EMAIL_TRANSPORT=console` is accepted by `pnpm dev` only; a production build refuses to
  start with it.
- `V4W_ADMIN_EMAILS`: comma-separated; also what `pnpm db:seed` reads. It never demotes or
  removes anyone.
- `V4W_DATA_SOURCE`: anything else, or nothing, makes the badge say "Data source not set
  (V4W_DATA_SOURCE)". The app never guesses.
- `PORT` is read by `pnpm dev` and by a production build; `HOST` matters for a production
  build, which listens on all interfaces unless told otherwise.
- `V4W_PYTHON`: by default `forecast/.venv/bin/python` when that file exists, else `python3`
  from `PATH`.
- `V4W_RETRAIN_CRON`: a cron line in the server's local time (UTC in the image). It is read
  when the app is built (`pnpm build`), not when it starts; for the image it is a build
  argument.
- `V4W_GATE_WORKERS`: by default 4, or the number of CPUs when there are fewer.
  `V4W_HOLIDAYS_THROUGH_YEAR`: by default the year after the one the forecast ends in.
  These two and `V4W_HORIZON_DAYS` are read by the Python script. The server hands its own
  environment to the script; a run started from a shell needs them in that shell.

A value the server cannot use (a missing required one, a wrong choice, a number out of
range) stops the start with a message that names the variable.

## Tests

```bash
pnpm lint              # ESLint
pnpm typecheck         # the app and the server
pnpm typecheck:tests   # the test folders and scripts
pnpm test              # unit and component tests; needs no .env, no database, no Python
pnpm forecast:test     # the Python suite (needs pnpm forecast:setup)
pnpm test:parity       # TypeScript against Python, same inputs, same answers (needs forecast/.venv)
pnpm e2e               # builds the app and drives it from an empty database to a served forecast
```

Every test runs on generated data. CI (`.github/workflows/test.yml`) runs all of them on
each pull request and on pushes to `dev`, `stage` and `prod`. What each layer covers, how to
write a test, and how the old app was used to prove the rebuild:
[docs/testing.md](docs/testing.md).

## Deployment

The app ships as one container image: the built Nuxt server plus a Python 3.12 environment
for the retrain script. A push to the `stage` or `prod` branch runs the EPICS pipeline
(`.github/workflows/deploy.yml`): build the image, run the database migrations, push the
image, restart the service. A failed migration stops the pipeline before the image ships.

Three things to know before the first deploy:

- **The SQLite file is the only state.** The trained model lives in it too. It must sit on
  storage that survives a redeploy, and it must be backed up. Lose it and the call history,
  the people and the model are gone.
- **The deployment needs real settings**: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `DATABASE_URL`, the mail server (`EMAIL_*`), `V4W_ADMIN_EMAILS`, `V4W_DATA_SOURCE`.
- **The sign-in rate limit depends on what stands in front of the app.** It tells clients
  apart by the `X-Forwarded-For` header. Behind two proxy hops all visitors share one
  allowance of three code requests per minute, so one person can lock everyone out; if the
  app's port can be reached directly, a client can sidestep the limit by inventing
  addresses. It has to be configured for the platform before going live.

The image, the variables, the volume, backups, the migration bundle, the rate limit, the
first-deploy checklist and how to size the task: [docs/deployment.md](docs/deployment.md).

## What must never be committed

- `.env` and any other file with a secret or a connection string.
- A database (`*.db`, its `-journal` file, the `*-cli-run-*.lock` file of a shell retrain).
- Call data in any form: `*.xlsx`, `*.xls`, `*.csv`, `*.csv.gz`, `*.parquet`, anything under
  `data/`. No call export, extract or caller detail belongs in this repository, synthetic or
  real.
- Screenshots or logs that show real numbers of the line.

`.gitignore` blocks exactly these names: `.env` and `.env.<anything>` except `.env.example`,
the three kinds of database file, the five data file types, and every folder called `data`.
So keep every file with secrets under a name that starts with `.env.`, for example
`.env.deploy`. Git does not know a settings file called `deploy.env`, an export packed some
other way such as `calls.zip` outside a `data` folder, or a screenshot: those are up to you,
so read `git status` before every commit. Test data is generated when a test runs. The one
data-like file that is committed,
`tests/server/forecast/fixtures/SYNTHETIC-legacy-golden.json`, holds answers of the old API
computed from synthetic data and no call record.

## Before you rely on it

**No real call data has passed through this app.** It was built and tested on generated
(synthetic) data only, in a sandbox without the real database, the real mail server or the
real hosting platform. The list below is what that leaves unproven, and what to do about
each point. Work through it before anyone schedules people from these numbers.

### The data

1. **The copy from the old Postgres database has only run against a synthetic copy of it.**
   Run it without `--commit` first and compare the counts it prints with what you expect. It
   reads call times as text and takes them to be stored without a time zone, as Eastern
   wall-clock time: confirm that for the real table before you copy.
2. **Nobody knows whether the real `holidays` table agrees with the calendar rules the
   retrain checks.** Run a retrain after the copy. If it refuses with "the holidays table
   has N row(s) that disagree with the calendar rules", correct or delete those rows in the
   database. There is no page for holidays.
3. **The rebuilt pipeline has reproduced the old pipeline's model on synthetic data only,
   never on the real data.** After the real history is in, run
   `.venv/bin/python -m db.retrain --db <file> --verify-reference` in `forecast/`. `MATCH`
   means the same model as the committed one. `DIFFERENT` on another kind of CPU is not a
   fault: see
   [Comparing models across machines](docs/deployment.md#comparing-models-across-machines).
4. **The upload reader has never read a file written by Excel itself or by the partner's
   phone system.** Its test files were written by Python and Node libraries, by LibreOffice
   and by hand. Read the first real upload's report before you confirm it: first day, last
   day, the number of calls against your export, the list of days. If the dates or counts
   look wrong, do not import; keep the file and fix the reader. The known gaps are listed in
   [docs/call-data.md](docs/call-data.md#what-has-not-been-proven-about-real-files).
5. **The forecast under the real handle times, waiting times and hang-up behaviour has not
   been looked at in this app.** After the first real retrain, compare a few days of the
   staffing page with the old tool, or with what the line actually staffed.

### The deployment

6. **Real mail delivery.** Only a local test mail server was used. Set the `EMAIL_*`
   values and sign in once from outside. A mail that cannot be sent shows only in the
   server log: the page says that a code is on its way either way.
7. **Where the database file lives on the platform, whether it survives a redeploy, and how
   it is backed up.** Ask the platform owner, point `DATABASE_URL` at that storage, make a
   backup and restore it once.
8. **SQLite on network storage.** The server and the script wait for each other's locks,
   and the server waits on its one thread, so slow storage makes every pause longer. Prefer
   local or block storage. If it must be a network filesystem, watch how long the health
   check takes during a retrain.
9. **The request-size limit in front of the app.** The multi-year workbook is about 15 MB.
   Ask the platform owner, then upload a large synthetic workbook. If it is refused before
   it reaches the app, use the copy script for the history and one file per year afterwards.
10. **The sign-in rate limit behind the real proxy.** It depends on the client-address
    header (`X-Forwarded-For`). Configure it and run the checks in
    [docs/deployment.md](docs/deployment.md#the-sign-in-rate-limit-and-the-client-address).
    Never let the app's port be reached directly.
11. **The image on the real platform.** It was built and run for amd64 only, in a test
    sandbox whose network made a few extra build lines necessary, so the `Dockerfile`
    exactly as committed has not been built yet. For arm64, which the pipeline deploys, the
    build has not completed anywhere: in that sandbox, under emulation, the step that builds
    the app hung. The first complete arm64 build is the pipeline's own. Watch it, and watch
    the first real retrain: how much memory and CPU it needs there is not known. Start with
    the sizes in [docs/deployment.md](docs/deployment.md#how-big-a-task), which were
    measured on synthetic data in a test sandbox.
12. **The same model from the same data on a different kind of CPU.** On synthetic data the
    model came out identical on amd64 and on arm64 emulated on the same machine. Real ARM
    hardware with the real data has not been tried. If `--verify-reference` answers
    `DIFFERENT` there, that is not a fault by itself: compare the check table instead.
13. **Two server instances on one database file**, even for a moment during a redeploy.
    Run one instance: the retrain runner assumes it is the only server on its database.
14. **Time.** The daily schedule over real days, a session ending after 7 days and the
    forecast range moving with the calendar were driven by hand or with a clock set in
    tests. Look at the Forecast runs tab after the first few days: there should be one
    "Scheduled" refresh per day.
15. **Browsers other than Chromium, a real phone, screen readers.** Open the pages on the
    devices people will use.
16. **Two admins loading files at the same moment.** One admin at a time was tested. Agree
    who loads data. The app refuses a second file while one is being read, and refuses an
    import when the stored calls changed since the file was checked.
17. **Development on macOS.** The retrain script ties its worker processes to their parent
    with a Linux feature, and the server finds leftover processes through `/proc`. On a
    Mac, if a retrain is killed, check for leftover `python` processes yourself.

## The reference model: accuracy on the real data, measured before the rebuild

The numbers in this section belong to the model that was trained on the real call data on
2026-11-11 by the earlier, Python-only version of this tool, and that is committed under
`forecast/models/` (`metadata.json` says what it was trained on). They were measured before
the rebuild, on real data that this repository does not contain. Nothing in this section was
measured by the rebuilt app. This README and the guides quote no accuracy number measured on
synthetic data: such a number would say nothing about the real line.

Weekly rolling-origin backtest: the model is trained on everything up to a day, forecasts the
next 28 days with no access to them, and the origin then moves back one week. 104 origins,
test weeks Nov 2024 to Nov 2026:

| model                                               | daily error, 1 to 14 days ahead | 15 to 28 days ahead | hourly MAE | week-to-week spread of accuracy |
| --------------------------------------------------- | ------------------------------- | ------------------- | ---------- | ------------------------------- |
| this model                                          | 9.29%                           | 9.67%               | 2.70 calls | 2.74 points                     |
| Oct 28 2026 model                                   | 9.91%                           | 10.27%              | 2.72       | 3.00                            |
| seasonal naive (same weekday-hour, last 8 weeks)    | 10.33%                          | 10.78%              | 2.87       | 3.38                            |
| hindsight oracle (knows the weeks before AND after) | 9.22%                           | 9.14%               | 2.83       | 2.80                            |

"Daily error" is the mean absolute % error of the day total; the client's "accuracy" is 100
minus it, so about 90.7% on average. On 52 older weeks (Nov 2023 to Nov 2024) the same
comparison is 10.78% vs 10.95% (1 to 14 days, too small to tell from chance), 11.32% vs
11.87% (15 to 28 days), spread 2.72 vs 3.31, worst week 83.5% vs 76.8%.

Calls arrive at random, so accuracy has a ceiling: with about 180 calls a day, a forecast
that knew every weekly total in advance would still average 92.1% daily accuracy, and single
weeks swing about 3 points either way. Hourly error is close to its noise level; any one cell
is plus or minus one person.

Whether the rebuilt pipeline gives this same model from the real data has not been checked
(see "Before you rely on it"). `--verify-reference` is the check.

## Where the model's research record lives

`forecast/docs/final-run/` holds the record of how the model was chosen: `REPORT.md` (what
was tried, kept and rejected, and why), `ledger.json` (every experiment), `incumbent.json`
(the configuration that won) and `HANDOFF.md`. The plan and the scoring rules that were fixed
before any result was seen are in `forecast/docs/superpowers/plans/`. These files describe
the earlier Python tool: paths and commands in them (`make train`, `db.tune`, a Postgres
database) are from that time. `docs/archive/` holds older notes about the first versions of
the staffing page.

## Guides

- [docs/architecture.md](docs/architecture.md): the processes, the tables and who writes
  them, the contract between Node and Python, the rules for sharing the database.
- [docs/call-data.md](docs/call-data.md): the upload flow, every refusal, limits, replacing
  a day, the copy from Postgres.
- [docs/retraining.md](docs/retraining.md): triggers, statuses, the schedule, timeouts, what
  to do when a run fails, running by hand.
- [docs/deployment.md](docs/deployment.md): the image, variables, the database volume,
  backups, the first-deploy checklist.
- [docs/better_auth.md](docs/better_auth.md): sign-in, roles, the rate limit.
- [docs/testing.md](docs/testing.md): the test layers and how to add a test.
- [docs/mcp.md](docs/mcp.md): documentation servers for AI coding assistants.
- [docs/adr/002_nuxt_rebuild.md](docs/adr/002_nuxt_rebuild.md): why the app was rebuilt
  this way.
- [requirements.md](requirements.md): the requirements register.
