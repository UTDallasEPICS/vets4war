# Retraining

A **run** is one execution of the Python script `forecast/db/retrain.py`. It comes in two
kinds:

- A **retrain** (`full`) fits a new model on all stored calls, checks it against a simple
  baseline, and writes a new forecast.
- A **forecast refresh** (`forecast-only`) keeps the model in use, recomputes handle time,
  real-call share and caller patience from the stored calls, and writes the forecast again
  so that it reaches further into the future.

This guide covers what starts a run, what a run does, how it can end, the schedule, stopping
and timeouts, what to do when a run fails, and how to run the script by hand.

## What starts a run

| Started by   | On the page ("Started by") | When                                                                                  |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| An import    | After an import            | Every import of call data starts a retrain, unless `V4W_RETRAIN_ON_IMPORT=false`.     |
| The schedule | Scheduled                  | Once a day; see [The schedule](#the-schedule).                                        |
| An admin     | By hand                    | **Retrain now** or **Refresh forecast** on the Forecast runs tab.                     |
| The server   | Server start               | At start, when call data is waiting that no run has finished on.                      |
| A shell      | Command line               | Somebody ran the script; see [Running a retrain by hand](#running-a-retrain-by-hand). |

**Only one run works at a time.** When a run is asked for while another is working (a second
import, a second click), nothing new starts. The answer names the run in progress, and one
more run is queued: it starts by itself when the current run ends, and it reads everything
that was imported in the meantime. However many requests arrive during a run, exactly one
extra run follows. It is the run that was asked for, with who asked for it:

- a retrain wins over a refresh: a refresh asked for first becomes a retrain if a retrain
  is asked for later;
- an import always queues a retrain (after an import), so the new calls are learned;
- otherwise the first request keeps its place, and later ones are covered by it.

The queued run is kept in `data_state` (`rerun_mode`, `rerun_trigger`,
`rerun_requested_by`) and shown on the Forecast runs tab ("One more retrain is queued"),
also after a reload, until it starts. `GET /api/admin/runs` returns it as `queued`.

## What a run does

A retrain:

1. **Reads** every call and the data revision in one read transaction, then marks its run row
   `running` with what it read (number of calls, first and last day).
2. **Checks the holidays.** Every row of the `holidays` table must agree with the calendar
   rules of the 11 official holidays (see [The holidays table](#the-holidays-table)). Then it
   adds the official holidays that are missing, from the first year of data through the year
   after the forecast ends.
3. **Checks the data.** No day inside the last 350 days of call data may be without calls,
   and there must be enough history for the check below (26 weeks plus 56 days of training
   data before them).
4. **Checks the model against the simple baseline.** It replays the last 26 weeks. For each
   week it trains on everything up to that week, forecasts the next 28 days without seeing
   them, and measures the error. The simple baseline (for each weekday and hour, the median
   of the previous 8 weeks) is measured the same way. The model passes when its daily error
   over days 1 to 14 is lower than the baseline's. This step is most of a run's time and
   uses several worker processes (`V4W_GATE_WORKERS`).
5. **Fits the model** on all the data, if the check passed. If it did not, the new model is
   thrown away and the previous model is used for the rest of the run.
6. **Measures** handle time and real-call share per weekday and hour, caller patience and
   quick hang-ups from the same calls.
7. **Forecasts** every hour from the first day of data through 800 days past the later of
   today and the last call day (`V4W_HORIZON_DAYS`), once with and once without holiday
   effects.
8. **Writes everything in one transaction**: the new model (if there is one), the forecast,
   the measured numbers, and the outcome on its run row. Until that moment the old forecast
   is served, unchanged; after it, the new one. There is no in-between.

A forecast refresh does steps 1 and 2, loads the model in use, and continues with 6 to 8.

The run's output (the check table, the counts, the last line `V4W_RESULT {...}`) is kept on
the run and shown under **Details** on the Forecast runs tab, together with the check table:
eight measures for the model next to the simple baseline.

## How a run ends

| Status in the API | On the page              | Meaning                                                                                              |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `queued`          | Running                  | Created; the script has not claimed it yet.                                                          |
| `running`         | Running                  | The script is working.                                                                               |
| `succeeded`       | Done                     | The forecast was written.                                                                            |
| `rejected`        | Kept the previous model  | The new model did not beat the baseline. The previous model stays; the forecast was still refreshed. |
| `rejected`        | Rejected, nothing served | The same on the very first retrain: there was no previous model, so there is no forecast.            |
| `failed`          | Failed                   | The run stopped. Its message says why. The forecast in use did not change.                           |
| `interrupted`     | Interrupted              | The server stopped or restarted during the run.                                                      |

"Kept the previous model" is not a fault. It means the safety check did its job: a model
that is no better than "the same as recent weeks" is not put in front of supervisors. The
message gives both error figures. If it keeps happening after new data arrives, look at the
check table under Details and at what changed in the data.

The messages of the four good outcomes:

- "Retrained on 133,132 calls through 2026-11-15. The new model beat the simple baseline in
  the check and is now in use."
- "Retrained on 133,132 calls through 2026-11-15. The retrained model is identical to the one
  in use (model 3), which stays in use; the forecast was refreshed." The same calls give the
  same model byte for byte, so a retrain on unchanged data stores no second copy of it
  ("New model: No" under Details).
- "The retrained model did not beat the simple baseline on daily error (<model>% against
  <baseline>%), so the previous model stays in use. Handle time, caller patience and the
  data range were refreshed."
- "Forecast refreshed from the model in use; data through 2026-11-15."

(The call counts and dates in these examples come from synthetic test data.)

## Where you can see the state

- **Forecast runs tab.** How many calls are stored and from when to when; what is being
  served ("Serving the forecast of run 3, made ... Model 3 was trained on calls through
  2026-11-15; the forecast's handle time and caller patience use calls through
  2026-11-15."); the run in progress; and a warning when the stored calls are newer than the
  forecast, naming the retrain that left them out.
- **Call data tab.** After an import, the outcome of the retrain it started.
- **The staffing console.** A note while new call data is being processed, and a note when
  it was loaded but the forecast could not be updated. Otherwise nothing.
- **`GET /api/status`.** `forecast.stale` is true when the stored calls are newer than the
  forecast; `run` is the run in progress, or else the latest one.

## The schedule

A scheduled check runs once a day. The time is a cron line, `V4W_RETRAIN_CRON`, default
`30 8 * * *`.

- It is in the **server's local time**. The image runs in UTC, so the default is 08:30 UTC,
  which is 03:30 or 04:30 in New York depending on daylight saving.
- It is read when the app is **built**, not when it starts. Changing it means building
  again with the variable set: in `.env` for a local `pnpm build`, as the build argument
  `V4W_RETRAIN_CRON` for the image. Without it the default applies.
- `V4W_RETRAIN_SCHEDULE=off` (read at start) makes the check do nothing.

What the check decides, in this order, with the reason it writes to the server log (as
`[retrain] scheduled tick: <action> (<reason>)`):

1. The schedule is off: nothing. "The schedule is off (V4W_RETRAIN_SCHEDULE)."
2. A run is in progress: nothing. "A run is in progress."
3. There are no calls: nothing. "There is no call data yet."
4. The calls are newer than the forecast, and no run has finished on them: **a retrain
   starts**. "The call data (revision N) is newer than the forecast."
5. The calls are newer than the forecast, and a run on them already ended failed or
   rejected: nothing. "The call data (revision N) is newer than the forecast, and run M on
   it ended failed; an admin decides what next."
6. The forecast is current but more than 20 hours old: **a refresh starts**. "The forecast
   is more than 20 hours old."
7. Otherwise: nothing. "The forecast is up to date."

Two of these deserve a word.

**Why a failed retrain is not tried again by the schedule.** A run that failed for a reason
in the data would fail the same way every night. So after a failure on the newest calls the
schedule waits for a person: fix the cause (the message says what) and press **Retrain
now**.

**Why the schedule does not refresh the forecast in that situation either.** A refresh would
compute the forecast from the new calls with the old model and mark the forecast as up to
date, which would hide that the retrain on those calls never succeeded. The forecast in use
keeps being served; with the 800-day range it stays usable for a long time. An admin can
still press **Refresh forecast** on purpose; the runs tab then says that the model is older
than the data.

At **server start** the same question is asked once: if calls are waiting that no run has
finished on, a retrain starts ("Server start").

## Stopping, timeouts and restarts

- **Timeout.** A run that is still going after `V4W_RETRAIN_TIMEOUT_MIN` minutes (default 60,
  at most 1440: the server refuses to start with more, which its timer could not hold) is
  stopped: first asked to stop, and killed 10 seconds later if it has not. It ends as
  Failed, "Stopped after 60 minutes (V4W_RETRAIN_TIMEOUT_MIN). The forecast in use did not
  change."
- **The server stops** (a redeploy, for example). The run is stopped with it and recorded as
  Interrupted, "The server stopped during this run." Nothing of the run is kept.
- **The server was killed** without a chance to clean up. The script notices that its parent
  is gone and stops. At the next start the server stops anything that is still left of
  earlier runs on its database, marks the run Interrupted ("The server restarted during this
  run.") and starts a new retrain if one is owed.
- **The script is killed** (by a person, or by the system when memory runs out). The server
  sees it exit and records Failed, "The retrain script was stopped by SIGKILL before it
  reported a result. The forecast in use did not change." Its worker processes die with it.

In all of these the forecast in use is untouched, because a run writes only in its last
step, in one transaction.

Under `pnpm dev`, stopping the dev server does not give the app the chance to record the
stop: the run stays "Running" until the next start, which marks it Interrupted. A
production build records it at once.

## The runner and the script as processes

The server's side of a run is the retrain runner (`server/utils/retrain/runner.ts`). It is
the one place in the server that creates run rows and starts the script. What the two sides
promise each other about the database is in
[architecture.md](architecture.md#the-contract-between-node-and-python); this section is
about the processes.

- **Start.** The runner creates the run row (`queued`) and starts

  ```
  <V4W_PYTHON> -m <V4W_RETRAIN_MODULE> --db <absolute path> --run-id <id> --mode <full|forecast-only>
  ```

  in the folder `V4W_FORECAST_DIR`, with part of the server's environment, no input, and
  its output captured. It passes no other option: workers, range and holidays come from the
  environment. The script gets only `PATH`, `HOME`, the temp folder (`TMPDIR`, `TMP`,
  `TEMP`), `LANG`, `LC_*`, `TZ`, `PYTHON*`, `OMP_*`, `OPENBLAS_*`, `MKL_*`,
  `V4W_GATE_WORKERS`, `V4W_HORIZON_DAYS` and `V4W_HOLIDAYS_THROUGH_YEAR`
  (`retrainEnv` in `server/utils/retrain/runner.ts`); the server's secrets never reach it. The script runs in a process group of its own, together with the worker
  processes of the check.

- **End.** A run is over when the script **exits**. The runner then gives the output one
  more second to arrive, stores the exit code and the last 16 KB of output on the row, and
  kills whatever is still left in the process group. If the row still says `queued` or
  `running` at that point, the script did not report: the runner writes `failed` (or
  `interrupted` while the server is shutting down) with a sentence that says how it ended.
- **Stop.** To stop a run the runner signals the whole group: `SIGTERM`, then `SIGKILL` after
  10 seconds (a timeout) or 2 seconds (a shutdown).
- **The script's part.** On `SIGTERM`, `SIGINT` or `SIGHUP` it kills its workers at once,
  rolls back an open write and ends by that same signal. Each worker asks the operating
  system to kill it when the script dies, and a script the server started asks to be stopped
  when the server dies. So no process of a run outlives it. (These two requests are a Linux
  feature; on other systems the runner's group kill still covers stops and restarts.)
- **Start-up.** A server that starts has not started any run yet. Every process of the
  script that works on its database with a `--run-id` is therefore a leftover of an earlier
  server: it is killed with its workers, and its row is marked `interrupted`. Runs started
  from a shell are never touched.
- **Still exiting counts as running.** The script commits its result a moment before it
  exits. Until the runner has seen the exit, a new request is treated as arriving during
  the run.

The tests of the runner use a stand-in for the script,
`tests/server/retrain/fixtures/fake-python.mjs`. It stands in for the script as a
**process**: it takes the same arguments, claims and finishes the run row the same way, and
can be told to succeed, be rejected, refuse, crash, hang, or leave stubborn worker processes
behind. What it writes into the forecast tables is a placeholder, never a forecast.

## When a run fails

Open the run under **Details**: the message says what happened, and "Output (last part)"
shows the end of what the script printed.

- **"Cannot retrain: N recent day(s) have no calls at all (A to B) ..."** A day inside the
  last 350 days of data was never loaded. Load the calls of those days on the Call data tab,
  then press **Retrain now**.
- **"Cannot retrain: there is not enough call history for the accuracy check ..."** There is
  less history than the check needs (about 8 months). Load more history.
- **"Cannot retrain: the holidays table has N row(s) that disagree with the calendar rules
  ..."** See [The holidays table](#the-holidays-table).
- **"Cannot retrain: the caller patience measured from the calls is X s ... below the floor
  of 10 s ..."** The waiting times in the loaded calls are wrong: a wrong unit or a wrong
  column. Check `InQueue` and `Abandon_Time` in the files that were loaded and replace the
  wrong days. (The script never stores such a number. If one is in the database anyway, the
  read API answers 503 `implausible_patience` instead of computing with it.)
- **"Cannot retrain: there are no calls in the database ..."** Load call data.
- **"Cannot refresh the forecast: no model has been trained yet ..."** A refresh was asked
  for before the first retrain succeeded. Run a full retrain.
- **"The retrain script could not be started (ENOENT)."** The server did not find the Python
  interpreter. Run `pnpm forecast:setup`, or set `V4W_PYTHON`. In the image, check
  `V4W_PYTHON` and `V4W_FORECAST_DIR`.
- **"The retrain script stopped without reporting a result (exit code 1)."** The script
  crashed at its start. Read the output: a `ModuleNotFoundError` means the Python
  environment is incomplete; run `pnpm forecast:setup`.
- **"Unexpected error: <type> (its text is not shown ...)"** A bug, or a stored value the
  script cannot read. The output shows the file and line where it happened. The error's own
  text is left out on purpose, because it could quote a stored value.
- **"Stopped after N minutes (V4W_RETRAIN_TIMEOUT_MIN) ..."** The run took longer than the
  limit. Give the task more CPU, or raise the limit. See
  [deployment.md](deployment.md#how-big-a-task).
- **"The retrain script was stopped by SIGKILL before it reported a result ..."** Something
  killed it. On a small task this is often the system reclaiming memory. Give the task more
  memory, or lower `V4W_GATE_WORKERS`.
- **"The run started from a shell (process N) ended without reporting a result ..."** A run
  somebody started by hand was killed. Run it again.

Two refusals come from the API before any run exists: `POST /api/admin/runs` answers 409
"There is no call data yet. Load a call-records file first." on an empty database, and 409
"The server is stopping. Ask again once it is back." during a shutdown.

After a failure the forecast in use is the one from before. The runs tab and the console
both say that the stored calls are newer than the forecast until a retrain on them succeeds.

## The holidays table

The model treats holidays differently from ordinary days, so the `holidays` table has to be
right. It holds the 11 official holidays of each year, each on its calendar date (not the
weekday it is observed on), under exactly these names:

New Year's Day, MLK Day, Presidents Day, Memorial Day, Juneteenth, Independence Day, Labor
Day, Columbus Day, Veterans Day, Thanksgiving, Christmas.

Before each run the script compares every row with the rule for its name and year. A row
with another name, or with a date the rule does not give, stops the run. The message lists
up to three such rows in the form "<name> <year>: table <date>, rule <date>". Nothing is
guessed and nothing is corrected for you: fix or delete the row in the database, then run
again. Rows that are missing are added by the script itself, so an empty table is fine.

Four more days are treated like holidays by the model (Christmas Eve, New Year's Eve, the
day before and the day after Thanksgiving). They are worked out in code and are not rows of
the table.

The API tells a page when a requested date range runs past the last holiday in the table
(`holiday_coverage` in the forecast answer). With the default settings the table reaches
past the end of the forecast, so that note does not appear.

## Running a retrain by hand

You can run the script yourself, on the machine (or in the container) that holds the
database file. It is the same script the server starts.

```bash
cd forecast
.venv/bin/python -m db.retrain --db /absolute/path/to/app.db                        # retrain
.venv/bin/python -m db.retrain --db /absolute/path/to/app.db --mode forecast-only   # refresh
make retrain DB=/absolute/path/to/app.db                                            # the same as the first line
```

From the repository root of a local checkout, `--db "$PWD/../dev.db"` (typed inside
`forecast/`) names the default database.

Inside a running container the same script is started like this. Use the environment's
Python, not the plain `python` of the image (that one has none of the packages), and run it
in `/app/forecast`:

```bash
docker exec -w /app/forecast <container> /app/forecast/.venv/bin/python -m db.retrain --db /data/app.db --mode forecast-only
```

- `--db` must be the **absolute** path of an existing database file. A relative path is
  refused: "Cannot retrain: --db must be the absolute path of an existing database file".
- Python does not read `.env`. Settings come from the flags below or from variables in your
  shell.
- The exit code says how it ended: 0 the forecast was written, 3 the new model was rejected,
  2 refused (the message says why), 1 an unexpected error.

**The server may be running.** A run from a shell creates its own row, shown as "Command
line". While it works:

- the server shows it as the run in progress and does not start another one; a click or an
  import in that time is queued and starts when your run ends;
- the server never stops a run it did not start: no timeout applies to it;
- the script holds a lock on a small file next to the database, named
  `<database file>-cli-run-<run id>.lock` (with a `-journal` file beside it). The lock is how
  the server knows your run is alive. The script removes the file when it ends. If the
  script is killed, the operating system drops the lock at once; the server then records the
  run as Failed and removes the file. If no server is running at that moment, the file
  stays until one starts. It is ignored by git; deleting it by hand is harmless once the run
  is gone.

**Use the path the server uses.** The lock file is looked for next to the database file,
after symbolic links are resolved, so a symbolic link or a `..` in your path makes no
difference. But if your shell reaches the same database under a different folder layout or
file name (a second container that mounts the volume elsewhere, for example), the server
finds no lock file. It then has nothing to judge by: it treats the run as alive until
`V4W_RETRAIN_TIMEOUT_MIN` minutes have passed and after that closes it as Failed ("... has
no lock file the server can check, so it is taken as ended"). A run closed that way cannot
write its result any more. So mount the database at the same path everywhere.

The options:

| Option                    | Default                                                            | Meaning                                                 |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `--db PATH`               | required                                                           | The SQLite file, absolute path.                         |
| `--mode`                  | `full`                                                             | `full` or `forecast-only`.                              |
| `--workers N`             | `V4W_GATE_WORKERS`, else 4 or the CPU count if lower               | Worker processes of the check.                          |
| `--horizon-days N`        | `V4W_HORIZON_DAYS`, else 800                                       | How far ahead the forecast is written.                  |
| `--holidays-through YEAR` | `V4W_HOLIDAYS_THROUGH_YEAR`, else the year after the forecast ends | Last year of official holidays to add.                  |
| `--today YYYY-MM-DD`      | today in New York                                                  | For tests.                                              |
| `--gate-origins N`        | 26                                                                 | Weeks replayed by the check. For tests; leave it alone. |
| `--run-id N`              | none                                                               | Only the server passes this.                            |
| `--verify-reference`      | off                                                                | See below. Writes nothing.                              |

`python -m db.train` is another name for the same script.

### Checking against the reference model

```bash
.venv/bin/python -m db.retrain --db /absolute/path/to/app.db --verify-reference
```

This trains a model on the stored calls up to the last day the committed reference model
(`forecast/models/`) was trained on, and compares the two fingerprints. It only reads; the
database is not changed, and the check against the baseline is skipped.

- `MATCH: same data and libraries give the same model.` Exit code 0. The database holds the
  same calls the reference model was trained on, and this machine computes the same model.
- `DIFFERENT: see the deployment guide on comparing models across machines.` Exit code 4.
  Either the calls differ, or the machine does. See
  [deployment.md](deployment.md#comparing-models-across-machines).
- `Cannot verify: the reference model was trained through 2026-11-03, but the database has
calls end ...` Exit code 2. The stored calls stop before the reference model's last day.

It is meant for the real call history. On generated data it always answers DIFFERENT.

## How long a run takes

Measured on synthetic data in a test sandbox (about 388,000 calls over six years, 4 shared
CPU cores): a full retrain took between 20 and 35 seconds with 4 workers, and about 55
seconds with 1. A forecast refresh took about 3 seconds. The numbers for memory, and what they
mean for the size of the task, are in [deployment.md](deployment.md#how-big-a-task). Measure
again on the real machine with the real data before relying on them.
