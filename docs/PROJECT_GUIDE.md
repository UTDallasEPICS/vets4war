# Vets4Warriors staffing tool: the complete project guide

Written 2026-11-11 as the handover document. It explains what the tool is,
how it got here, how every part works, what is finished, what is not, and
where everything lives. If you only have five minutes, read
[`START_HERE.md`](../START_HERE.md) first.

Every number in this guide comes from a command, a test run or a report
named next to it. Where something was not checked, it says so.

---

## 1. What this is

Vets4Warriors runs a 24/7 peer-support phone line for veterans. This tool
answers two questions for the people who schedule it:

1. **How many calls will come in, hour by hour, for the coming weeks?**
2. **How many peers need to be on shift to answer them in time?**

It is a Python web application: a forecasting model trained on the client's
call records since 2021, queueing math that turns calls into people, one
staffing page for the client, and an admin side for loading new call data.

| | |
|---|---|
| Repository | `UTDallasEPICS/vets4war` (public) |
| Live site | https://v4w-staffing.vercel.app (shared password; ask the project lead) |
| What is live | commit `e75f974` (tag `v1.0` + the roster-check command) |
| Newest code | branch `integrate-admin`, commit `0c5c8fb` and later |
| Language / stack | Python 3.12, LightGBM, FastAPI, PostgreSQL (Supabase), plain HTML/JS |
| Tests | 767 pass (`make test`; database tests need a local Postgres, see section 8) |
| Hosting | Vercel, one container, region Portland (next to the database) |

## 2. Where it stands at handover (2026-11-11)

**Finished and live**
- Forecast model, final tuning run (section 5).
- Staffing page: date range and one-day views, phone layouts, light/dark.
- Shared-password sign-in in front of everything.
- Hosted on Vercel.

**Finished, tested, pushed, NOT live yet** (branch `integrate-admin`)
- Teammates' admin work merged in: Auth0 sign-in, admin page, upload API,
  ingestion ledger.
- Auth0 for the admin side working beside the shared password.
- Data loading for any range of whole days (the one-month limit is gone).

**Not done** (section 12 has the steps)
- Auth0 tenant settings for the live address; nobody has signed in as an
  admin on the live site.
- Migration 002 on the shared database.
- Deploying `integrate-admin`.
- Admin "model freshness" panel, monitoring panel, automated retraining.

## 3. How we got here

Dates are commit dates or the dates printed on the reports.

| When | What happened |
|---|---|
| Aug 24 | EPICS creates the repository from its Nuxt template (`1b9642a`). |
| Sep | First prototype on made-up data in a separate repository (`vets4war-dummy`), to learn the problem before real data arrived. Not part of this repo. |
| Oct 11 | **First forecast on the client's real call data**, built in place of the Nuxt template (`e784f9e`). 376,748 calls, 2021-01-01 to 2026-08-31. First staffing page (`6dc9fbd`). |
| Oct 14 | Production Dockerfile (`6ece15c`, Aarush). |
| Oct 17 | Liquid-glass redesign of the page (`bd59f17`, `2d919f3`, Jamie). |
| Oct 18 | Model comparison on a 12-month blind test: LightGBM chosen (report `v4w-model-comparison.pdf`). |
| Oct 21 | Client meeting. First validation: the client's real week Oct 14 to 20, never seen by the model. Daily accuracy 91.9% (the "92%" quoted since). Report `V4W_Model_Validation_Oct14-20_2026.pdf`. |
| Oct 22 to 28 | Excel validation and the month-based ingestion ledger (Quan). Monitoring CLI, admin page, Auth0 login (Veda). Model calibration experiments on `forecast-mvp` (Hamza). |
| Oct 26 | **Fine-tuning** on the Oct 14 to 20 week (`782bbef`): a bug that counted missing days as zero-call days fixed, level calibration added, efficiency default set to the client's own 0.65625, roster what-ifs. That week re-scored at 93.0%. Report `V4W_Model_and_Fine_Tuning_Explained.pdf`. |
| Oct 28 | Second client week (Oct 21 to 27): forecast 1,305 calls, actual 1,300; daily accuracy 90.9%; hourly error 2.89 calls. Three model versions compared; the combined one kept (`70aa13f`). Reports `V4W_Oct21-27_*.pdf`, `V4W_Forecast_Report_Oct14-27.pdf`. |
| Oct 31 to Nov 4 | Admin upload/import/history API and its documentation; `feature/admin-integration` brings pipeline, admin page and Auth0 together (Quan, Veda). |
| Nov 3 | Light/dark theme (`055ca80`). |
| Nov 4 | Third client week (Oct 28 to Nov 3): forecast 1,252, actual 1,248; daily accuracy 93.9%; hourly error 3.17 calls. "Real calls" tile (calls with more than 2 minutes of talk time), asked for by the client, built (`9472bf6`). Report `V4W_Oct28-Nov3_Prediction_vs_Reality.pdf`. |
| Nov 10 | **Final model run** (`3557ff7`): all client data loaded (388,588 calls to Nov 3), 224 candidate changes scored on 104 weekly blind forecasts under rules fixed in advance, 5 kept. **Page redesign** (`99f9ddf`): one-day view, phone layouts, charts. |
| Nov 11 | Shared-password sign-in and Vercel hosting (`34d4149`); tagged `v1.0` (`57b0003`); per-shift roster check (`e75f974`). Then on `integrate-admin`: merge of the admin branch (`684da2e`), Auth0 beside the password (`304ce1b`), day-range data loading (`0c5c8fb`). |
| Nov 11, evening | Branches reorganised on GitHub by a teammate (section 11). |

## 4. Who did what

From `git shortlog` on `integrate-admin` (39 commits, merges included) and
GitHub's activity log. The two `moaizattiq` identities are the same person.

| Person | Commits | What |
|---|---|---|
| Moaiz Attiq (project lead; `moaizattiq`, `officiallymoaizattiq-bit`) | 15 | Real-data forecast and its model code, every tuning round and the final run, both staffing-page rebuilds and the final redesign, queue math and roster what-ifs, real-calls tile, weekly scoring against the client's data, shared-password sign-in, Vercel hosting, roster check, the merge of the admin branch, Auth0 wiring, day-range ingestion, the client reports, this guide |
| Quan Nguyen | 10 | Excel validation (`db/ingest.py`), the ingestion ledger and its first pipeline (`db/pipeline.py`, migration 001), admin upload/import/history routes, history-preparation tool, ingestion docs, CI switched to pytest |
| Veda Manchana | 6 | Monitoring CLI (`db/monitor.py`, not on this branch yet), admin page (`web/admin.html`, `web/admin.js`), Auth0 login and token checks (`api/auth.py`), integration of the above |
| Hamza Munis | 4 | Calibration and LightGBM experiments on `forecast-mvp`, code comments. Scored against the client's Oct 21 to 27 week; two of his settings (7-day level window, 15% cap) went into the Oct 28 model |
| Jamie O | 2 | Liquid-glass page redesign (Oct 17) |
| Aarush | 1 | Production Dockerfile; branch housekeeping on GitHub |
| Arnav Kumar | 1 | EPICS template |

## 5. How it works

Longer versions: `README.md` (overview), `docs/final-run/REPORT.md` (model,
with every number), `docs/final-run/HANDOFF.md` (model recipe).

### 5.1 Calls per hour

- **Model:** LightGBM, Poisson objective, trained on hourly call counts from
  2021 on. Inputs are calendar facts only: hour, weekday, holidays and
  distance to the nearest holiday, the client's four holiday-type days.
  No "last week's calls" inputs, because a forecast weeks ahead would not
  have them.
- **Calibration on top:** a level factor (how the last weeks ran against the
  model, recent days weighted more, capped at 15%) and hour-of-day shape
  factors. Bursts (one-off spikes) are clipped so they do not pull it.
- **How it is judged:** weekly blind forecasts. Train on everything up to a
  day, forecast the next 28 days, move back a week, repeat (104 times).
  `make train` refuses to save a model that does not beat "same weekday and
  hour, average of the last 8 weeks".

Results (`README.md`, `docs/final-run/REPORT.md`):

| | Daily error, 1 to 14 days ahead |
|---|---|
| This model | 9.29% (about 90.7% daily accuracy on average) |
| Oct 28 model | 9.91% |
| Seasonal naive | 10.33% |

Calls arrive at random. A forecast that knew every weekly total in advance
would still average only about 92.1% daily accuracy, so **96% is not
reachable** and a single week anywhere from about 84% to 96% is normal.
The three client weeks scored 91.9% (93.0% after fine-tuning), 90.9% and
93.9%.

### 5.2 From calls to people

1. **Handle time** per weekday and hour: recency-weighted mean talk time
   (`db/aht.py`). It ran about 10% high against the last two client weeks
   (608 s predicted, 551 and 557 actual); the lead chose not to change it.
2. **Patience:** how long callers wait before hanging up, estimated from the
   abandoned calls (`db/patience.py`); about 255 s.
3. **Erlang A** (callers hang up) gives the people needed on the phones so
   80% of calls are answered within 30 s (`db/erlang.py`, `db/staffing.py`).
4. **Efficiency 0.65625:** the client's own figure (480-minute shift, 45
   minutes of breaks). People to schedule = people needed / efficiency.
5. **Shifts:** Overnight 00 to 08, Day 08 to 16, Evening 16 to 24, each
   staffed for its busiest hour. Caps: 7 per shift, 6 in the evening. A
   number over the cap is flagged, never silently lowered.

### 5.3 Is the queue math right?

Checked against the client's real roster (4 overnight / 4 day / 6 evening on
all 21 days of Oct 14 to Nov 3) with `python -m db.roster_check`:

| Week | Answered in 30 s: actual | tool | Hung up: actual | tool |
|---|---|---|---|---|
| Oct 14 to 20 | 78.4% | 75.5% | 14.3% | 14.8% |
| Oct 21 to 27 | 78.6% | 75.9% | 13.2% | 14.6% |
| Oct 28 to Nov 3 | 77.6% | 77.1% | 13.3% | 13.9% |

Close on the whole week, slightly cautious. Day and Evening within about 4
points. **Overnight is the weak spot** (8 points too pessimistic in two of
three weeks), and real talk time differs by shift more than the tool
assumes. Nothing was changed: three weeks at one roster is too little to
fit per-shift numbers. The roster never varied, so "what if we had 5
instead of 4" rests on queue theory, checked at this one roster only.

## 6. The repository, folder by folder

```
api/            the web server
  main.py         forecast and staffing routes; wires everything together
  site_auth.py    shared-password sign-in (session cookie, lockout, security headers)
  auth.py         Auth0 access-token checks and permissions
  auth0_config.py reads the three AUTH0_* settings
  admin.py        admin routes: validate, stage, import, history, config
db/             model, data and queue math (no web code)
  features.py, train.py, procedure.py, calibration.py, backtest.py, tune.py   the forecast model
  forecast.py, staffing.py, erlang.py, aht.py, patience.py, real_calls.py     turning it into staffing
  client_files.py   reads the client's Excel layouts
  day_ledger.py     per-day comparison (new / identical / conflict)
  pipeline.py       staging and importing call data; `python -m db.pipeline ...`
  load_week.py      older command-line loader (still works)
  dataset.py        training data = database + client files it lacks
  score_week.py, snapshot.py, roster_check.py   scoring forecasts against the client's weeks
  ingest.py, prepare_history.py                 standalone Excel checking tools
  migrations/       001 (ledger), 002 (day ranges), 002_down (undo)
models/         the trained model (volume_lgbm.txt) and its metadata
web/            the pages: index.html + app/logic/charts/dayfocus/motion.js (staffing),
                login.html (password), admin.html + admin.js (admin), vendor/ (Auth0 library)
tests/          767 tests; *_checks.js are run through Node by pytest
docs/           this guide, sign-in, data loading, model report, teammates' pipeline docs, archive
forecasts/      forecasts frozen before the client's actuals arrived
config/         example export contract for the standalone validator
data/           NOT in git: client workbooks and caches
Dockerfile.vercel, vercel.json, .vercelignore   hosting
Makefile        db-check, train, serve, test
wpr/, requirements.md, docs/adr/   EPICS coursework files
```

## 7. Setting it up and running it

```
git clone https://github.com/UTDallasEPICS/vets4war.git && cd vets4war
git switch integrate-admin
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt   # macOS also: brew install libomp
cp .env.example .env        # then fill in V4W_DATABASE_URL (ask the lead)
make serve PYTHON=.venv/bin/python PORT=8001      # http://127.0.0.1:8001
```

`.env` settings (never commit `.env`):

| Setting | For |
|---|---|
| `V4W_DATABASE_URL` | the shared Supabase database (session pooler address) |
| `V4W_DATA_SOURCE` | label on the page: `partner` |
| `V4W_AUTH_DISABLED=1` | local only: no password on your own machine (ignored on the server) |
| `V4W_APP_PASSWORD_HASH`, `V4W_SESSION_SECRET` | server: shared-password sign-in |
| `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` | admin sign-in (not secret) |
| `V4W_ADMIN_IMPORTS=1` | allows imports to write to `calls`; off by default |

Other commands:

| To | Run |
|---|---|
| Check the database connection | `make db-check PYTHON=.venv/bin/python` |
| Retrain the model | `make train PYTHON=.venv/bin/python`, then commit `models/` and deploy |
| Score a client week | `.venv/bin/python -m db.tune weeks`, `-m db.score_week`, `-m db.roster_check "<file>.xlsx"` |
| Load call data from a file | `.venv/bin/python -m db.pipeline import "<file>.xlsx"` (dry run), add `--commit` to write |
| Change the site password | `.venv/bin/python -m api.site_auth hash`, put the hash in Vercel, redeploy |

## 8. Tests

```
make test PYTHON=.venv/bin/python          # database tests skip without a test database
```

For the database tests, a throwaway Postgres (never the shared one):

```
docker run -d --name v4w-test-pg -e POSTGRES_DB=pipeline_test -e POSTGRES_USER=pipeline_test \
  -e POSTGRES_PASSWORD=pipeline_test -p 127.0.0.1:55432:5432 postgres:16
V4W_TEST_DATABASE_URL=postgresql://pipeline_test:pipeline_test@127.0.0.1:55432/pipeline_test \
  .venv/bin/python -m pytest tests -q
```

Good to know:
- Some older tests read the shared database (read-only), so they need the
  network and `V4W_DATABASE_URL`.
- `test_recompute_on_168_hour_grid_is_under_budget` is a speed test; it can
  fail on a busy machine.
- `tests/conftest.py` fails any test that would reach the shared database
  through the ingestion code.
- The repository's GitHub check runs pytest on pull requests (and on pushes
  to `dev`), not on plain pushes to `integrate-admin`.

## 9. Sign-in

Full detail: [`docs/admin-sign-in.md`](admin-sign-in.md).

- **Staffing page:** one shared password, no usernames. Only a slow salted
  hash is stored. Five wrong tries from one address lock sign-in for 15
  minutes; a redeploy clears the lock.
- **Admin page and `/api/admin/*`:** Auth0 accounts, checked on the server.
  Permissions `read:admin` (look) and `import:calls` (stage and import).
- The two never grant each other's access.

## 10. Loading call data

Full detail: [`docs/day-range-ingestion.md`](day-range-ingestion.md).

- A file may cover any range of whole days. Each day is **new** (inserted),
  **identical** (skipped) or **conflict** (replaced only when the admin
  confirms exactly that day; the replaced calls are kept).
- Checked read-only against the shared database on Nov 11: the client's
  multi-year workbook (376,748 calls, 2,069 days) and the four later files
  (11,840 calls, 64 days) match it day for day.
- Checked end to end on a local database with the real files.
- Imports need `V4W_ADMIN_IMPORTS=1` and migration 002 (section 12).
- **Importing does not retrain the model.** After new data: `make train`,
  commit `models/`, deploy.

The shared database today: `calls` (388,588 rows, 2021-01-01 to 2026-11-03),
`holidays` (through 2027), teammates' ledger tables (`pipeline_batches` with
10 staged test batches, none imported). Rule the project has kept: nobody
alters `calls` or the shared schema without the team agreeing first.

## 11. Branches on GitHub

As of 2026-11-11 23:10 UTC. A teammate renamed and removed several branches
that evening; no commit was lost (everything removed is contained in the
branches below).

| Branch | Commit | What it is |
|---|---|---|
| `integrate-admin` | `0c5c8fb`+ | **Newest code.** `final-main` plus the admin branch, Auth0 wiring, day-range loading and this guide. Start new work here. |
| `final-main` | `e75f974` | What the live site runs. Was `final-frontend-mo` until Nov 11. Tag `v1.0` is one commit before it. |
| `last-version-clients-saw` | `055ca80` | The Nov 3 version (was `testing-rounds`). |
| `feature/admin-integration` | `f9b0b4d` | Teammates' admin work as they left it; fully merged into `integrate-admin`. |
| `admin-data-pipeline`, `feature/admin-monitoring`, `feature/monthly-data-ingestion` | | Earlier steps of the admin work; all contained in the branch above. |
| `dev` (default) | `79e4400` | The EPICS Nuxt template. The Python tool was never merged into it: that would delete the template, and the team has not decided to. |

Removed on Nov 11 (contained elsewhere): `forecast-mvp`, `model-final-run`,
`prod`, `stage`, and the old names `final-frontend-mo`, `testing-rounds`.

## 12. What is left to do, in order

1. **Review and merge `integrate-admin` into `final-main`** by pull request.
2. **Auth0 tenant** (owned by a teammate). In the Auth0 dashboard:
   - Single-page application: Allowed Callback URLs, Logout URLs and Web
     Origins for `https://v4w-staffing.vercel.app/admin.html` and your local
     address. Note the Client ID.
   - API: RS256, Enable RBAC, Add Permissions in the Access Token,
     permissions `read:admin`, `import:calls`, `trigger:retraining`.
   - A role with `read:admin` and `import:calls` for each admin. Public
     sign-ups off.
3. **Vercel settings:** `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`.
   Leave `V4W_ADMIN_IMPORTS` unset for now.
4. **Deploy** (`npx vercel deploy` for a preview first, then `--prod`).
   Sign in on the admin page; use "Check without staging" on a real file.
5. **Migration 002 on the shared database**, after the team agrees:
   schema backup, note the `calls` count, `python -m db.pipeline migrate
   --dry-run`, then `migrate`.
6. Set `V4W_ADMIN_IMPORTS=1`, redeploy, import one real weekly file from the
   admin page, check the row count and the upload history.
7. **Hand over ownership:** the Vercel project sits in the lead's personal
   account on the Hobby plan (meant for non-commercial use), with the
   database address in its settings. Move it to an account the team or the
   client owns; change the shared password.
8. **Model freshness on the admin page** (planned, not built): show "model
   trained through" (`models/metadata.json`) against "data through" (latest
   call), so staleness is visible.
9. **Monitoring:** `db/monitor.py` on `feature/admin-integration` was left
   out of the merge because it calls a function the final model code no
   longer has; adapt it, then feed the admin "Accuracy" panel from it and
   from `db.tune weeks`, `db.score_week`, `db.roster_check`.
10. **Automated retraining** (later): a GitHub workflow that trains, runs the
    backtest gate, commits the model and deploys. Needs repository secrets
    from a UTDallasEPICS organisation admin; the same is true for attaching
    Vercel to GitHub so pushes deploy by themselves.

## 13. Known limits and open points

- **Model:** tell the client 96% is beyond the noise ceiling. Retrain at
  least monthly. Score each new client week before more tuning.
- **Overnight** queue estimates and per-shift talk time (section 5.3).
- **Password** is shared and was chosen for convenience, not strength.
- **Lockout** counts live in the running app; it was not confirmed that
  Vercel passes each visitor's own address through.
- **The app sleeps** after about 5 quiet minutes; the next visit takes a few
  seconds longer.
- **Page:** `web/app.js` is about 840 lines (team guideline 800); no
  automated tests for `charts.js`, `dayfocus.js`, `motion.js`; checked in
  headless Chromium only, not on a real iPhone or Safari; the client's four
  holiday-type days are not labelled on the page.
- **Admin page:** never used with a real Auth0 sign-in on this branch
  (needs step 2). Token renewal can fail in Safari, forcing a new sign-in.
- **Replacing a day deletes rows** from the shared `calls` table. It needs
  the permission, the exact day, the row count and the server switch, and
  the old rows are kept with the batch, but it is the one destructive path.
- **EPICS template:** `dev`, and how the Python tool relates to it, is an
  open team decision.

## 14. Documents

In the repository:

| File | What |
|---|---|
| `START_HERE.md` | the short version for the team |
| `README.md` | overview and accuracy table |
| `docs/PROJECT_GUIDE.md` | this guide |
| `docs/admin-sign-in.md` | shared password and Auth0 |
| `docs/day-range-ingestion.md` | loading call data |
| `docs/final-run/REPORT.md`, `HANDOFF.md`, `ledger.json` | the model: every experiment and number |
| `docs/admin-upload-pipeline.md`, `ingestion-integration.md`, `ingestion.md`, `admin-dashboard-troubleshooting.md` | teammates' pipeline docs (month-based design; partly superseded, marked at the top) |
| `docs/archive/` | older working notes |

Reports made for the client and the course (PDF, kept by the project lead,
not in the repository; ask for copies):

| Report | Pages | What |
|---|---|---|
| `V4W_Model_Validation_Oct14-20_2026.pdf` | 4 | first blind validation week |
| `v4w-model-comparison.pdf` | 1 | why LightGBM |
| `V4W_Model_and_Fine_Tuning_Explained.pdf` | 6 | the Oct 25 to 26 fine-tuning, plain language |
| `V4W_Forecast_Report_Oct14-27.pdf` | 6 | two weeks of forecasts against real calls, for the client meeting |
| `V4W_Oct21-27_Forecast_vs_Actual.pdf`, `V4W_Oct21-27_Prediction_vs_Reality.pdf` | 3, 2 | second client week |
| `V4W_Oct28-Nov3_Prediction_vs_Reality.pdf` | 2 | third client week |
| `V4W_Work_Log_Nov10-11_2026.pdf` | 15 | everything done on Nov 10 and 11, with screenshots |
| `V4W_Final_Summary_Nov11_2026_v2.pdf` | 5 | summary at tag `v1.0` plus the roster check |
| `Vets4Warriors Mid-term Review.pdf` | 27 | mid-term project review |
| `EPICS_Fall2026_ADR_Vets4Warriors.pdf` | 10 | engineering decision record |
| `vets4warriors-field-research-red-team.pdf` | 19 | background research on the partner |

Client data (Excel, no PHI, never in git; the lead and the client have
them): the multi-year call records 2021 to Aug 2026, call records for Sep 1
to Oct 13, three weekly "Actual Data for Validity Testing" workbooks
(Oct 14 to Nov 3, each with a Staff By Shift sheet), and monthly staffing
spreadsheets May to October 2026 with reading instructions.

## 15. Words used here

| Word | Meaning |
|---|---|
| Daily accuracy | 100 minus the average percentage miss of each day's call total |
| Handle time (AHT) | how long an answered call keeps a peer busy |
| Abandoned / hung up | the caller left before anyone answered |
| Service level | share of all calls answered within 30 seconds |
| Efficiency | share of a shift a person is free for inbound calls (0.65625) |
| Erlang A | queue formula that includes callers hanging up |
| Blind / hold-out | scored on days the model was not allowed to see |
| Ledger | the tables recording which upload put which calls in |
| Staged batch | an uploaded file checked and stored for 7 days, not yet imported |
