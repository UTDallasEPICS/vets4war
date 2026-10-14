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

Rolling-origin backtest over the last 12 complete months of data
(2025-09 to 2026-08). Each month is predicted by a model trained only on the
months before it. Pooled over all held-out hours:

| model | hourly MAE | hourly MAPE | daily-total MAE |
|---|---|---|---|
| LightGBM Poisson | 2.72 calls | 54% | 16.9 calls/day |
| seasonal naive (same weekday-hour, last 8 weeks) | 2.85 | 54% | 18.7 |
| flat mean of training window | 3.17 | 72% | 17.4 |

The line takes about 180 calls a day, so the daily error is roughly 9%.
Hourly MAPE is high because many hours have only a handful of calls; the
dashboard treats any one cell as plus or minus one person. Exact numbers,
per fold, are in `models/metadata.json` and in the banner on the dashboard.
`make train` refuses to save a model that does not beat seasonal naive on
daily-total MAE.

## Layout

```
db/erlang.py     Erlang C and Erlang A, required_agents()        (pure math)
db/features.py   the ONLY place feature logic lives; hourly aggregation SQL
db/aht.py        handle time per (weekday, hour), recency-weighted
db/patience.py   mean caller patience from abandoned calls
db/train.py      LightGBM Poisson, rolling backtest, writes models/
db/forecast.py   forecast_range(): hourly calls + handle time for a date range
db/staffing.py   Erlang -> agents -> scheduled staff, shift roll-up
api/main.py      FastAPI: /api/forecast, /api/staffing, /api/model, serves web/
web/index.html   the dashboard (vanilla JS); web/erlang.js mirrors db/erlang.py
models/          volume_lgbm.txt + metadata.json, written by `make train`
tests/           pytest; test_features.py and test_api.py need the database
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
make test     PYTHON=.venv/bin/python   # 85 tests; 2 files need the database
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

About 30 seconds. It rebuilds the full hourly grid, reruns the 12-month
rolling backtest against the two baselines, prints the per-fold table, and
only then writes `models/volume_lgbm.txt` and `models/metadata.json`. If
LightGBM does not beat seasonal naive on daily-total MAE it prints `STOP`,
exits non-zero and leaves `models/` untouched. The hold-out window moves
forward automatically with the data: the last 12 complete months.

The running API reloads the model on the next request after a retrain.

## API

```
GET /api/forecast?start=YYYY-MM-DD&end=YYYY-MM-DD
    &efficiency=0.65&target_pct=0.80&target_sec=30
    &queue_model=erlang_a|erlang_c&patience_sec=
    hours: one row per hour with the whole chain (calls, handle time, load,
           agents, people to schedule, service level, abandonment)
    days:  per-date shift roll-up (Overnight / Day / Evening)
    window: totals and the talk-time caveat

GET /api/staffing?...same params
    days only

GET /api/model
    models/metadata.json verbatim (training window, features, backtest)
```

`start`/`end` default to today and today + 29 days; maximum range 366 days.

## Dashboard

`make serve`, then open the URL. Pick a date range for the hour-by-hour
matrix and the per-shift strip, or pick a single day and hour in the
"Pick a day and hour" card to see that hour's forecast and the people to
schedule. Sliders for efficiency, service-level target and answer time
recompute in the browser without a round trip.

## What must never be committed

`.gitignore` blocks `.env`, `.venv/`, `data/`, and every `*.csv`, `*.xlsx`,
`*.xls`, `*.parquet`. No call export, extract or caller-identifying data
belongs in this repository. The database holds timing and outcome fields
only.
