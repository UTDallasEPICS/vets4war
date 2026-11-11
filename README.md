# Vets4Warriors staffing forecast

Forecasts inbound call volume per hour for the Vets4Warriors peer-support line
and turns it into "how many people to schedule" per hour and per shift. Reads
the real call log from the shared Supabase Postgres database. Python, LightGBM,
FastAPI, one static dashboard page.

This branch replaces the Nuxt template that the repository started from.
Nothing here depends on it.

## What it does

1. **Volume model.** LightGBM with a Poisson objective learns calls per hour
   from five and a half years of hourly counts: hour of day, weekday, month,
   week of year, a slow trend, holidays and distance to the nearest holiday.
   No lag features, because the forecast runs weeks ahead and lagged actuals
   would not exist yet.
2. **Handle time.** A recency-weighted mean of agent seconds per (weekday,
   hour) over answered calls. Calls recorded with zero agent time are left
   out of this average only.
3. **Caller patience.** Mean patience estimated from the abandoned calls in
   the data (censored-exponential maximum likelihood).
4. **Staffing.** Erlang A (default; callers hang up) or Erlang C (infinite
   patience) gives the agents needed so a target share of callers (default
   80%) is answered within a target time (default 30 s). Dividing by staff
   efficiency (default 65%, the share of a shift a person is free for
   inbound) gives the number to put on the schedule. Each shift is staffed
   for its busiest hour. Numbers above the client's cap of 7 per shift are
   flagged, never clamped.

## Accuracy on the real data

Weekly rolling-origin backtest (`db/backtest.py`): the model is trained on
everything up to a day, forecasts the next 28 days with no access to them,
and the origin then moves back one week. 104 origins, test weeks Nov 2024 to
Nov 2026:

| model | daily error, 1 to 14 days ahead | 15 to 28 days ahead | hourly MAE | week-to-week spread of accuracy |
|---|---|---|---|---|
| this model | 9.29% | 9.67% | 2.70 calls | 2.74 points |
| Oct 28 2026 model | 9.91% | 10.27% | 2.72 | 3.00 |
| seasonal naive (same weekday-hour, last 8 weeks) | 10.33% | 10.78% | 2.87 | 3.38 |
| hindsight oracle (knows the weeks before AND after) | 9.22% | 9.14% | 2.83 | 2.80 |

"Daily error" is the mean absolute % error of the day total; the client's
"accuracy" is 100 minus it, so about 90.7% on average. On 52 older weeks
(Nov 2023 to Nov 2024) the same comparison is 10.78% vs 10.95% (1 to 14
days, too small to tell from chance), 11.32% vs 11.87% (15 to 28 days),
spread 2.72 vs 3.31, worst week 83.5% vs 76.8%.

Calls arrive at random, so accuracy has a ceiling: with about 180 calls a
day, a forecast that knew every weekly total in advance would still average
92.1% daily accuracy, and single weeks swing about 3 points either way.
Hourly error is close to its noise level; any one cell is plus or minus
one person. The full record of what was tried, kept and rejected is
`docs/final-run/REPORT.md` and `docs/final-run/ledger.json`.
`make train` refuses to save a model that does not beat seasonal naive on
daily error.

## Layout

```
db/erlang.py     Erlang C and Erlang A, required_agents()        (pure math)
db/features.py   the ONLY place feature logic lives; hourly aggregation SQL
db/aht.py        handle time per (weekday, hour), recency-weighted
db/patience.py   mean caller patience from abandoned calls
db/holiday_calendar.py  official holidays + the client's four holiday-type days
db/dataset.py    training data: database (read-only) + client files it lacks
db/client_files.py      reads a client call-records workbook (no database)
db/load_week.py  appends a client call-records file to `calls` (dry run by default)
db/add_holidays.py      adds a year of official holidays to `holidays` (dry run by default)
db/procedure.py  the forecasting procedure: LightGBM base profile + calibration;
                 PRODUCTION is the configuration that ships
db/calibration.py       level and hour-of-day shape from the most recent weeks
db/train.py      fits PRODUCTION on all data, gates it, writes models/
db/forecast.py   forecast_range(): hourly calls + handle time for a date range
db/backtest.py   weekly rolling-origin folds, metrics, accept / reject rule
db/diagnostics.py       noise floor, hindsight oracle, bias tables
db/tune.py       the improvement loop: candidates vs incumbent, ledger
db/experiments.py       the candidate families the loop tried
db/base_cache.py        stores base-model numbers so a candidate scores in seconds
db/legacy.py     the Oct 28 2026 model, kept as the comparison baseline
db/atomic.py     files are replaced whole or not at all
db/staffing.py   Erlang -> agents -> scheduled staff, shift roll-up
db/source.py     data-source badge: partner / synthetic label + date range
api/main.py      FastAPI: /api/forecast, /api/staffing, /api/planned, /api/model
web/index.html   the console: markup + stylesheet
web/logic.js     every number the page shows is derived here (pure, node-testable)
web/app.js       DOM wiring, fetch, exports; no arithmetic of its own
web/erlang.js    mirror of db/erlang.py + staff_for_hour, parity-tested
models/          volume_lgbm.txt + metadata.json, written by `make train`
tests/           pytest; test_features.py and test_api.py need the database,
                 test_erlang_js.py and test_web.py need node
```

## Setup

Python 3.12. Versions are pinned in `requirements.txt`.

macOS first: LightGBM links against OpenMP, which is not bundled.

```
brew install libomp
```

Then, with [uv](https://docs.astral.sh/uv/):

```
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

or with plain Python:

```
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Create `.env` in the repo root. It is gitignored and must never be committed:

```
cp .env.example .env
```

Paste the connection string from the Supabase project (Connect button,
"Session pooler" tab) as `V4W_DATABASE_URL`.

```
make db-check PYTHON=.venv/bin/python   # row counts and date range
make test     PYTHON=.venv/bin/python   # 101 tests; 2 files need the database, 2 need node
make serve    PYTHON=.venv/bin/python   # http://127.0.0.1:8000
```

`make` targets default to `python3`; pass `PYTHON=.venv/bin/python` to use
the venv. `PORT=8001` changes the port.

## Container verification

The application image listens on port 8000 and requires the database settings
from the local `.env` file. After Docker Desktop is healthy, run this sequence
from PowerShell at the repository root:

```powershell
docker build -t app-test .
docker run -d --env-file .env -p 8000:8000 --name test-container app-test
docker logs test-container
curl.exe -I http://localhost:8000
docker rm -f test-container
```

### Verification record (2026-10-14)

Automated container verification was blocked by the Windows host runtime, not
by an application build error. Docker Desktop 4.48.0 crashed at
`dockerInference` and `docker-secrets-engine\engine.sock`, leaving the Linux
engine socket unavailable. Repeat the container verification sequence above
after Docker Desktop is repaired.

As a fallback verification, the application was run directly with Uvicorn on
port 8000 using the same local environment. These requests all returned
`200 OK`:

- `GET /`
- `GET /api/model`
- `GET /api/staffing`

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `V4W_DATABASE_URL` | yes | Postgres connection string. The only data source. Loaded by `python-dotenv` from `.env` or the shell. |
| `V4W_DATA_SOURCE` | yes, for the badge | `partner` or `synthetic`. Shown in the header on every page load with the data's date range. Unset = the badge says the source is not labeled, so synthetic numbers are never mistaken for real ones. |
| `HOST`, `PORT` | no | Bind address for `make serve`, default `127.0.0.1:8000`. |

## The data

Tables are read as-is; this code adds no views, columns or constraints to
the shared database.

- `calls`: one row per inbound call. `start_ts` (naive timestamp),
  `in_queue_sec`, `routing_sec`, `agent_sec`, `abandon_sec`, `abandoned`.
  Weekday and hour are derived in SQL or pandas.
- `holidays`: `holiday_date`, `holiday_name`. The multiplier columns are
  all NULL and are not used; the model learns each holiday from the flag.
  Holidays after the last row in the table are not reflected in the
  forecast; the API and dashboard warn when a requested range runs past it.

Timestamps are local Eastern wall-clock time with daylight saving: the
02:00 hour is empty on every spring-forward Sunday and the 01:00 hour
doubles on fall-back Sundays. Nothing is converted.

## Retraining

New calls land in the `calls` table (loaded outside this repo). Then:

```
make train PYTHON=.venv/bin/python
```

Under a minute. It rebuilds the full hourly grid, backtests the production
procedure on the last 26 weekly origins next to the seasonal naive
baseline, prints both, and only then writes `models/volume_lgbm.txt` and
`models/metadata.json` (features, the procedure, the level and hour-of-day
factors, where the data came from, the gate result). If the model does not
beat seasonal naive on daily error it prints `STOP`, exits non-zero and
leaves `models/` untouched.

Client call-record files for days the database does not have yet can be
added without writing to the database:

```
.venv/bin/python -m db.train --supplement "data/client/<file>.xlsx" ["..." ...]
```

The database wins on any day both have; a day present in both with a
different call count stops the run, and so does a file cut off part-way
through a day. `models/metadata.json` lists every source and how many
calls it added. While recent days are missing from the database, plain
`make train` stops with a message saying so.

The running API reloads the model on the next request after a retrain.

## API

```
GET /api/forecast?start=YYYY-MM-DD&end=YYYY-MM-DD
    &efficiency=0.65&target_pct=0.80&target_sec=30
    &queue_model=erlang_a|erlang_c&patience_sec=
    &recency=equal|weighted|recent&include_holidays=true|false
    hours: one row per hour with the whole chain (calls, handle time, load,
           agents, people to schedule, service level, abandonment)
    days:  per-date shift roll-up (Overnight / Day / Evening)
    window: totals, the talk-time caveat, recency_effect_pct (how far the
            chosen handle-time weighting moves expected talk time from equal
            weighting) and expected_abandoned_one_fewer (hang-ups if every
            hour scheduled one person fewer than recommended)

GET /api/staffing?...same params
    days only

POST /api/planned
    body: the same params plus planned: [{date, shift, planned}]
    per entry: recommended, delta, verdict (understaffed / on target /
    overstaffed / exceeds capacity), effective_agents, and the Erlang
    service level and abandonment at the PLANNED staffing

GET /api/model
    models/metadata.json plus data_source
```

Every response carries `data_source` (`kind`, `label`, `start`, `end`).
`start`/`end` default to today and today + 29 days; maximum range 366 days.

## The console

`make serve`, then open the URL. Top to bottom: a one-line header with the
data-source badge and exports, a sticky control bar, the grid, the summary
strip, and the model-credibility footer. The detail panel docks to the
right of the grid (below it under 1100px).

- **Grid.** One row per date, one column per hour, grouped into the three
  tours. Cell colour is a discrete scale, one shade per person, across the
  under-cap range. Three cap states: under (blue), at the cap of 7 (amber
  edge and numeral), over the cap (red fill, white numeral, corner wedge,
  plus the service level you would get if you could only staff 7). The
  recommendation itself is never clamped. After each tour: its peak (the
  number to roster against) and person-hours; at the end: the day's total.
- **Planned roster.** Type your own number per tour per day; empty follows
  the recommendation. The badge gives the verdict and the service level at
  your number. Your entries persist in this browser's localStorage.
- **Detail panel.** Hover a cell for its full trace (calls, handle time,
  talk time, erlangs, agents, ÷ efficiency, ceil, effective agents,
  delivered service level, hang-ups); click to pin it while you move the
  sliders. Drag across cells for a selection total. Pick a date for a day
  summary.
- **Controls.** Efficiency, service-level target (with the 80 to 85% band
  where the line operates and the 90% industry mark), answer time, Erlang
  A or C, caller patience (defaults to the measured value; "reset to data"
  appears after an override), handle-time weighting (equal / weighted /
  recent), and the holiday toggle. Everything except the window, weighting
  and holiday toggle recomputes in the browser with no round trip; the bar
  reports how many cells changed.
- **Exports.** PNG of the grid (redrawn on a canvas from the computed
  values) and CSV of every hour including planned staff and verdicts.

## What must never be committed

`.gitignore` blocks `.env`, `.venv/`, `data/`, and every `*.csv`, `*.xlsx`,
`*.xls`, `*.parquet`. No call export, extract or caller-identifying data
belongs in this repository. The database holds timing and outcome fields
only.
