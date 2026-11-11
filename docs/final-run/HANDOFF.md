# Handoff: model final run (state as of 2026-11-11 ~04:10 UTC: WORK COMPLETE, awaiting user decisions)

Read this first if you are picking the work up (new session, or after context loss).

## Where things are

- Repo `~/vets4war`, branch `model-final-run` (from `testing-rounds` @ 055ca80). Committed locally in two commits (real-calls work, then this run). NOT pushed.
- The working tree also holds the user's older uncommitted "real calls" work (api/main.py, web/*, db/real_calls.py,
  tests/test_real_calls.py, parts of db/forecast.py). Patch of that state: session scratchpad `pre_final_run/realcalls_wip.patch`.
- Shared Supabase DB: read-only during the run. On 2026-11-11, at the user's instruction, the three client files were loaded with `db.load_week --commit` (ids 378076-388588) and the 2027 holidays with `db.add_holidays 2027 --commit`. DB now: 388,588 calls to 2026-11-03, no missing day; holidays to 2027-12-25. Plain `make train` reproduces the saved model exactly.
- Frozen dataset: `data/cache/final_run/` (388,588 calls, 2021-01-01 to 2026-11-03, no missing day).
- Previous model: `git show testing-rounds:models/volume_lgbm.txt` (+ metadata.json).
- Dashboard server: `make serve PYTHON=.venv/bin/python PORT=8001` running in background with --reload.

## Documents

- Plan + pre-registered scoring rules: `docs/superpowers/plans/2026-11-10-model-final-run.md`
- Every experiment: `docs/final-run/ledger.json` (append-only); current winner: `docs/final-run/incumbent.json`
- Report for the user: `docs/final-run/REPORT.md`

## Final recipe (db/procedure.py PRODUCTION must equal incumbent.json; a test checks it)

Base LightGBM Poisson, 9 old calendar features + `is_holiday_adjacent`, half-life 730 d, trained twice with
bursts clipped at z=4 in the training target (`target_clip_z=4.0`). Calibration: level = exponentially weighted
recent actual/model ratio, half-life 10 d, window 140 d, cap 15%, bursts clipped z=4; hour-of-day shape factors,
strength 200, window 140 d. No weekday or cell factors, no horizon fading.

## Kept (in order) / rejected

Kept: level half-life 10 d; burst clip z=4 in calibration; hour-of-day shape; client holiday-eve flag (neutral,
client request, override); burst clip z=4 in the training target (post-review, confirmed on hold-out, override).
Rejected: level cap, horizon fading, skip holidays, weekday factors, cell factors, base half-life, training-window
length, holiday identity, Thanksgiving+Christmas flag, hour-of-week / payday / day-of-month / yearly cycle / month,
13 LightGBM settings, seed averaging, out-of-sample calibration (biases forecast 0.8% low).
Not run: recent-profile blend (same thing as cell factors with shrinkage, which were rejected).

## Status

Everything in the plan is done: final model trained and saved (level factor 1.0231), served by the dashboard,
369 tests pass, coverage 87%, both reviews done and their findings fixed, REPORT.md final. Nothing left to run.
What remains is only the user's decisions listed at the bottom.

## Honest headline (after ML review)

- 1-14 day daily accuracy: about the same to +0.5 point (dev 104 weeks: 9.913% -> 9.292% error; hold-out 52 weeks: 10.949 -> 10.776, t -0.7).
- Steadier: weekly spread 3.0 -> 2.8 (dev), 3.3 -> 2.7/2.8 (hold-out); worst week up.
- Month-ahead (15-28 d) error down ~4-5%. Hour bias cut (max 13% -> 6%).
- Client weeks unchanged: 94.9 / 90.4 / 93.7 vs old 94.5 / 90.6 / 93.8 (they are INSIDE the 104 tuning weeks, so not an independent test).
- Noise ceiling: weekly total known in advance would give 92.1%. 96% is not reachable.

## Commands

```
.venv/bin/python -m pytest tests -q -p no:cacheprovider          # ~55 s, needs DB for some tests
.venv/bin/python -m db.tune show | baseline | run NAME | promote NAME LABEL --why .. | holdout | weeks --origins .. | diagnose
.venv/bin/python -m db.train --supplement "data/client/V4W Call Records - Sept 1st 2026 thru Oct 13th 2026.xlsx" \
  "data/client/Oct 21 2026 to Oct 27 2026 - Actual Data for Validity Testing 2.xlsx" \
  "data/client/Oct 28 2026 to Nov 3 2026 - Actual Data for Validity Testing 3-2.xlsx"
```

## Gotchas

- A PreToolUse hook denies the first Write/Edit of each file until facts are stated; a `grep` search just before helps.
- `python -m db.train` without `--supplement` stops with a clear message while the DB lacks Sep 1 - Oct 13.
- Holidays table ends 2026-12-25: add 2027 holidays before forecasting late December / January.
- V4W ground rules: no push, ask before commit, no fabricated numbers, DB read-only, one file per concern.

## Open decisions for the user

Done on 2026-11-11: files loaded into DB, 2027 holidays added, work committed. User said to skip handle time and the weekend factor.
Still open: push (only when told); dashboard chips for the four client holiday days; tell client 96% is beyond the noise ceiling; score the next client week with `db.tune weeks` before more tuning.
