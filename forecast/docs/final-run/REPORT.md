# Model final run: what changed and why

Branch `model-final-run`, 2026-11-10 and 11. Committed and pushed (`9472bf6`, `3557ff7`).
During the run the shared database was only read. Afterwards, on the
user's instruction, the three new client files and the 2027 holidays were
loaded into it (section 10). To pick the work up: `HANDOFF.md` in this
folder.

Every number below was printed by a command in this repo and is stored in
`docs/final-run/ledger.json`, unless marked otherwise. The commands are at
the end. The plan and the scoring rules were written before any result was
seen: `docs/superpowers/plans/2026-11-10-model-final-run.md`. Two
independent reviews (code and method) were run on the finished work; what
they found is in section 8.

## 1. Bottom line

- **Average daily accuracy: about the same to half a point better.** On the
  104 tuning weeks it moved from 90.1% to 90.7%. On 52 older weeks that were
  not used for tuning it moved from 89.05% to 89.22%, which is too small to
  tell from chance. Do not promise the client a higher average.
- **Weeks are steadier.** Week-to-week spread of accuracy fell from 3.0 to
  2.7 points on the tuning weeks and from 3.3 to 2.7 on the older weeks.
  The worst week went from 81.4% to 84.2%, and from 76.8% to 83.5%.
- **Forecasts 2 to 4 weeks ahead are better** by about half a point of
  accuracy on both sets of weeks (error down 5.8% and 4.7%).
- **Hours that were consistently off are fixed.** The old model ran 13%
  high at 6 AM and 11% high at 1 PM, and 5 to 6% low at midnight and 4 PM,
  pooled over two years. The largest hourly bias is now 6%, most hours are
  within 2%. Hourly error fell 0.7 to 0.8% on both sets of weeks.
- **There is little left to gain.** Calls arrive at random. A forecast that
  knew every weekly total in advance would still average about 92.1% daily
  accuracy. 96% is not reachable; single weeks will keep landing anywhere
  from about 84% to 96%.
- **On the three client weeks old and new score the same** (94.5 / 90.6 /
  93.8 versus 94.9 / 90.4 / 93.7).

## 2. Data

| Source | Calls | Days | Used how |
|---|---|---|---|
| Shared database (`calls`) | 378,075 | 2021-01-01 to 2026-08-31, plus Oct 14 to 20 | read only |
| `V4W Call Records - Sept 1st 2026 thru Oct 13th 2026.xlsx` | 7,965 | Sep 1 to Oct 13 (the missing six weeks) | read from file |
| `Oct 21 2026 to Oct 27 2026 - Actual Data for Validity Testing 2.xlsx` | 1,300 | Oct 21 to 27 | read from file |
| `Oct 28 2026 to Nov 3 2026 - Actual Data for Validity Testing 3-2.xlsx` | 1,248 | Oct 28 to Nov 3 | read from file |
| **Total** | **388,588** | **2,133 days, 2021-01-01 to 2026-11-03, none missing** | |

Checks: both Oct 14 to 20 files match the database exactly (1,327 calls,
day by day). The multi-year workbook in the folder is byte-identical to the
one already loaded. The monthly staffing sheets (May to October) and their
instructions were read but not used: they describe who was scheduled, which
does not help predict how many people call.

The three new files are merged in memory (`db/dataset.py`). The database
wins on any shared day; a day present in both with a different count, or a
file cut off part-way through a day, stops the run. Nothing was inserted
during the tuning, because teammates' pipeline tables (`pipeline_batches`,
`pipeline_call_links`, `pipeline_state`) now live in that database. After
the run the user said to load the files; see section 10.

Filling the six-week gap matters by itself: with data up to the day before,
the old model scores 94.5% on Oct 14 to 20, where it scored 93.0% when the
gap was still open.

## 3. How it was scored

Weekly rolling-origin backtest (`db/backtest.py`). Train on everything up
to a day, forecast the next 28 days with no access to them, move the
origin back one week, repeat.

- **Tuning weeks:** 104 origins, test weeks Nov 2024 to Nov 2026. Choices
  were made here. 224 candidate settings were scored in 23 runs.
- **Older weeks (hold-out):** the 52 origins before that (Nov 2023 to Nov
  2024). Scored for the old model at the start and for the final model at
  the end. After the reviews it was also used once to decide one yes/no
  question (section 4.5) and by the reviewer for diagnostics, so it is no
  longer a perfectly clean test. Upcoming client weeks are the next clean
  one.
- **Client weeks:** Oct 14 to 20, Oct 21 to 27, Oct 28 to Nov 3. They are
  three of the 104 tuning weeks, so they are reported but are not an
  independent test.

A change was kept only if daily error at 1 to 14 days improved by at least
0.5% relative with a consistent sign across weeks (paired t of at least 1),
without making month-ahead error, hourly error, 4-hour-block error, the
weekly spread or the worst weekday bias worse. A change aimed at hours
could also be kept for improving the hour metrics with daily accuracy flat.
The loop stopped when three families in a row produced nothing that passed.
The t values overstate certainty somewhat because neighbouring test weeks
overlap.

### How much room there is

| Reference (tuning weeks) | Daily error 1 to 14 days | Meaning |
|---|---|---|
| Poisson floor | 6.0% | calls perfectly random around a perfectly known average; real calls are burstier, so this is too optimistic |
| Weekly total known in advance | 7.8% | only the split over days and hours left to forecast |
| Hindsight smoother | 9.2% | each hour predicted from the 4 weeks before AND after; not a strict floor, it has noise of its own |
| **Final model** | **9.3%** | |
| Old model (Oct 28) | 9.9% | |
| Seasonal naive | 10.3% | same weekday and hour, median of last 8 weeks |

## 4. What was kept, and why

### 4.1 Level from the recent weeks, weighted, instead of the last 7 days

**Before:** forecast multiplied by (last 7 days actual / model), capped at
15%. **Now:** the same ratio over the recent weeks with a 10-day half-life
(yesterday counts fully, 10 days ago half, 20 days ago a quarter), same cap.

**Why:** seven days is about 1,300 calls. Random variation alone moves that
total by several percent, and the old factor passed that noise straight into
next week's forecast: a randomly busy week pushed the next forecast too
high. Longer flat windows were better than 7 days up to about 3 weeks and
worse after (slow to follow real shifts); a half-life gives both.

| Setting (tuning weeks) | Daily error 1 to 14 d | 15 to 28 d | Weekly spread | Worst week |
|---|---|---|---|---|
| Old: 7 days, two fits | 9.913 | 10.266 | 2.995 | 81.4% |
| 21 days flat | 9.500 | 9.959 | 2.615 | 85.2% |
| **Half-life 10 days (kept)** | **9.400** | **9.856** | **2.681** | **84.3%** |
| Half-life 28 days | 9.505 | 9.804 | 2.890 | 81.8% |

Gain 5.2% on the tuning weeks, t = -3.0. Re-checked at the end: 10 days is
still the best setting.

**Caveat from the review:** on the older weeks this change alone does not
improve days 1 to 14 (the reviewer's own decomposition, not in the ledger,
has it slightly worse there than the 7-day factor). What it gives on both
sets is steadier weeks and a better forecast further out. This is the main
reason the average gain is stated so cautiously above.

### 4.2 Bursts are clipped before the level is measured

**What:** when measuring the level and shape, an hour far above anything
plausible for that hour (more than the expected count plus 4 standard
deviations, where the deviation allows for calls being 1.6 times as variable
as Poisson) is counted at that limit instead of at its raw value. For an
hour that normally gets 10 calls the limit is about 26. Scoring is
untouched: accuracy is still measured on every call.

**Why:** the client said some callers ring many times. One such evening
(47, 39 and 39 calls in three hours on Sep 10 to 11) made the following
weeks' level about 2% too high.

Daily error 9.400 to 9.313 (-0.93%, t = -2.4), month-ahead 9.856 to 9.741.
The review found this is the change that carries the gain on the older
weeks, where bursts were more frequent.

**Why the gentler setting:** a tighter limit (3 deviations) scored better
(-1.33%) but starts clipping ordinary busy hours and makes the forecast
0.31% low on average. At 4 deviations the average bias is -0.10%. A crisis
line should not be under-forecast on purpose.

### 4.3 Hour-of-day shape from the last 20 weeks

**What:** 24 factors, one per hour of the day, measured as recent actual /
model for that hour over the last 140 days, each pulled toward 1 unless the
hour has enough calls to be sure (shrinkage strength 200 calls; an hour of
the day sees about 1,000 calls in 20 weeks). The factors are rescaled so
they do not change the day total.

**Why:** the base model learns its hourly profile from almost six years of
data with a two-year half-life. The profile has drifted: mornings and lunch
are quieter than they used to be, midnight and late afternoon busier.

| Hour | 0 | 4 | 5 | 6 | 8 | 12 | 13 | 16 | 17 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|
| Old model bias % | -5.4 | +6.2 | +5.6 | +13.4 | +4.6 | +5.5 | +10.8 | -6.3 | -3.2 | -3.7 |
| Final model bias % | -2.0 | +1.6 | +0.8 | +6.2 | +0.3 | +2.2 | +2.4 | -0.6 | 0.0 | -1.3 |

(Positive = forecast too high. Pooled over the 104 tuning weeks, 1 to 14
days ahead.)

4-hour-block error 20.07 to 19.87 (-1.0%, t = -4.3); hourly error -0.27%
(t = -2.8); daily accuracy unchanged, as intended. The gain in hourly error
looks small because hourly error is close to its noise level: with about
7.5 calls an hour, randomness alone gives about 2.7 calls of error. What
the factors remove is the part that was wrong in the same direction every
week.

**Drawback:** the factors trail a real change in the daily rhythm by a few
weeks. Factors in the saved model (hour 0 to 23): 1.08 1.06 1.01 1.00 0.97
0.96 0.86 0.96 0.98 0.99 0.97 0.99 0.95 0.92 0.96 1.05 1.04 1.00 0.98 1.08
0.94 1.00 1.01 1.06.

**Effect on staffing:** for Nov 11 to 17 the week total is unchanged (1,256
old, 1,251 new) but calls move between shifts: Day -2.7%, Evening +1.7%,
Overnight -1.0%, with midnight and 1 AM up 7% and 6 AM down 17%. Because a
shift is staffed for its busiest hour and staffing moves in whole people,
the recommendation changed on 4 of 21 shifts that week. (One-off comparison
against the previous model file, `git show
testing-rounds:models/volume_lgbm.txt`; not in the ledger.)

### 4.4 The client's four holiday-type days

**What:** Christmas Eve, New Year's Eve, the day before Thanksgiving and
the day after it are derived by calendar rule (`db/holiday_calendar.py`;
nothing written to the shared holidays table) and given to the model as
their own flag, `is_holiday_adjacent`. The "holiday effects" switch on the
dashboard turns them off together with the official holidays.

**Result:** neutral. Error on holiday-type days 10.40% to 10.29%; overall
daily error 9.312 to 9.320 (noise). It ships because the client asked for
it and the rule fixed in advance for this item was "ship if not worse on
holiday-type days".

**What the data says about these days (2021 to 2025, day total versus the
same weekday in the surrounding weeks; one-off analysis, not in the
ledger):** Christmas runs at 0.83 and Thanksgiving at 0.84 of normal, lower
in every year. The four client days are not clearly different from a normal
day: day before Thanksgiving 1.05, day after 0.93, Christmas Eve 1.04, New
Year's Eve 1.11, each swinging 7 to 17% from year to year on five
observations. The flag lets the model pick up an effect if one firms up.

### 4.5 Bursts are clipped in the training data too (added after the review)

**What:** the base model is fitted once, then refitted with every past
hour's count clipped by the same burst rule as 4.2, so one caller's bad
evening two years ago no longer lifts that weekday-hour's profile.

**Evidence:** this was in the plan and I had skipped it; the reviewer
caught that. On the tuning weeks every clip level helped a little (the
chosen one: 9.320 to 9.292, -0.30%, below the 0.5% bar; only the most
aggressive level cleared it). Before looking further I fixed the rule:
keep the same level as 4.2 only if it passes the full acceptance rule on
the older weeks. It did: 10.862 to 10.776 (-0.79%, t = -1.8), month-ahead
11.441 to 11.317, weekly spread 2.762 to 2.715, nothing worse; all five
levels passed there.

**Drawbacks:** training takes two fits instead of one (still under a
minute). And this used the older weeks to make a decision, which is why
they no longer count as a clean test.

## 5. What was tried and rejected

| Family | Best candidate | Daily error change | Why rejected |
|---|---|---|---|
| Level cap 5 to 30% | 10% | -0.01% | no effect; 5% is worse |
| Level fading with horizon | fade 10% per week | -0.16% | month-ahead 1% better, but the forecast drifts 0.3 to 1% high and weekday bias grows |
| Skip holidays when measuring the level | | +0.05% | no gain |
| Weekday factors (36 settings) | strong shrinkage, 28 days | -0.42% | below the bar. Unshrunk factors were 1 to 4.6% WORSE: recent Sundays or Tuesdays are mostly noise |
| Weekday-hour cell factors (36) | strength 100, 28 days | -0.50% | passed the letter of the rule but made hourly error 0.7% worse, the opposite of its purpose; 60 calls per cell in 8 weeks is too few |
| Base model memory: half-life 90 to 1,460 days, equal weights | 545 days | +0.19% | the current 730 days is the optimum: shorter is noisier, longer more biased |
| Train on the last 1 to 4 years only | 4 years | -0.29% | below the bar |
| Holiday identity (each holiday its own effect) | | -0.02% | weekday-bias guard; with two test occurrences per holiday it flipped Christmas from 8% high to 8% low |
| Thanksgiving and Christmas flag | | -0.21% | below the bar. It did cut holiday-day error from 10.4% to 9.3%, but the worst week fell from 84.4% to 82.0% and the evidence is two Christmases. Worth revisiting with another year of data |
| Hour of week, payday window, day of month | hour of week | -0.36% | below the bar; day of month +1.6% |
| Yearly cycle, month number | | +3.9 to +6.6% | clearly worse: they memorise last year's level |
| LightGBM settings (13) | bigger leaves, fewer rounds | -0.20% | all within noise |
| Averaging 3 or 5 seeds | | -0.03% | no effect |
| Measuring level and shape against a model that has not seen the recent weeks (reviewer's suggestion) | | -0.29% | forecast becomes 0.84% low on average and weekday bias grows: the saved model has already absorbed part of the recent change, so correcting for all of it over-corrects |

Not run: blending with a recent weekday-hour profile (in the plan). It is
the same thing as the cell factors with shrinkage, which were tested in 36
settings and rejected.

**On Sundays specifically.** The client noticed Sundays running high in
October (213 and 194 calls against a forecast near 173). On Nov 1 Sunday was
171. Chasing recent weekdays made the forecast worse in every setting, so
the model does not. One thing is real, though: Saturdays and Sundays have
been about 2% under-forecast in both the tuning weeks (Sat -2.1%, Sun
-1.7%) and the older weeks, while other weekdays flip sign. A long-window
weekend factor could remove that. It would not move accuracy measurably
(2% on two days), so it was not added; say if you want it.

## 6. Results

### Tuning weeks (104 origins, Nov 2024 to Nov 2026)

| Metric | Old model | Final | Change |
|---|---|---|---|
| Daily error, 1 to 14 days ahead | 9.913% | 9.292% | -6.3% |
| of which days 1 to 7 | 9.619% | 9.119% | -5.2% |
| of which days 8 to 14 | 10.211% | 9.467% | -7.3% |
| Daily error, 15 to 28 days ahead | 10.266% | 9.667% | -5.8% |
| Hourly error (calls) | 2.715 | 2.697 | -0.7% |
| 4-hour-block error | 20.33% | 19.86% | -2.3% |
| Weekly total error | 5.61% | 4.88% | -13% |
| Weekly accuracy, spread | 2.995 | 2.736 | -0.26 points |
| Weekly accuracy, worst week | 81.4% | 84.2% | +2.7 points |
| Largest hourly bias | 13.4% | 6.2% | |

### Older weeks (52 origins, Nov 2023 to Nov 2024)

| Metric | Old model | Final | Change |
|---|---|---|---|
| Daily error, 1 to 14 days ahead | 10.949% | 10.776% | -1.6% (t = -0.7, not significant) |
| of which days 1 to 7 | 10.644% | 10.556% | -0.8% |
| of which days 8 to 14 | 11.255% | 10.997% | -2.3% |
| Daily error, 15 to 28 days ahead | 11.870% | 11.317% | -4.7% |
| Hourly error (calls) | 2.788 | 2.766 | -0.8% (t = -2.8) |
| 4-hour-block error | 21.56% | 21.32% | -1.1% |
| Weekly total error | 4.93% | 4.75% | -3.6% |
| Weekly accuracy, spread | 3.308 | 2.715 | -0.59 points |
| Weekly accuracy, worst week | 76.8% | 83.5% | +6.7 points |

Reading the two tables together: steadier weeks, a better month-ahead
forecast and the hour fixes show up in both. The gain in the near-term
average is clear on the tuning weeks and small on the older ones. With 224
settings tried on the tuning weeks, some of that 6% is selection luck; the
older weeks are the better guide to what to expect.

### Client weeks (each forecast with data up to the day before the week)

| Week | Actual calls | Old model | Final |
|---|---|---|---|
| Oct 14 to 20 | 1,327 | 94.5%, total 1,322 | 94.9%, total 1,302 |
| Oct 21 to 27 | 1,300 | 90.6%, total 1,296 | 90.4%, total 1,289 |
| Oct 28 to Nov 3 | 1,248 | 93.8%, total 1,246 | 93.7%, total 1,244 |

### The model that was saved

Trained on all 388,588 calls to 2026-11-03. Gate on the last 26 weekly
origins (May to October 2026, all inside the tuning weeks, so a sanity
check rather than a new test): daily error 8.81% against 9.92% for seasonal
naive, month-ahead 9.00% against 9.89%, weekly spread 2.38 against 2.89,
worst week 85.5% against 82.6%. Level factor 1.0231. The dashboard on port
8001 is serving it.

## 7. Code

New:

| File | What it does |
|---|---|
| `db/client_files.py` | reads a client call-records workbook, either layout, without the database |
| `db/dataset.py` | database + client files, database wins, conflicts and half days stop the run; frozen local snapshot |
| `db/holiday_calendar.py` | the four client days by calendar rule; fixed holiday codes |
| `db/backtest.py` | weekly origins, horizon bands, every metric, the accept / reject rule |
| `db/diagnostics.py` | Poisson floor, hindsight smoother, "weekly total known", bias tables, holiday-day error |
| `db/procedure.py` | base model + calibration as one procedure; `PRODUCTION` is what ships |
| `db/base_cache.py` | stores base-model numbers so one candidate scores in a second |
| `db/experiments.py` | the candidate families |
| `db/legacy.py` | the Oct 28 model, kept unchanged as the baseline |
| `db/atomic.py` | files are replaced whole or not at all |

Changed:

| File | Change |
|---|---|
| `db/calibration.py` | added level + shape calibration with shrinkage, burst clipping, horizon fading (off) |
| `db/features.py` | `is_holiday_adjacent`, plus candidate columns that were tested and are not used by the model |
| `db/train.py` | rewritten: fits `PRODUCTION`, gates on the weekly backtest, `--supplement`, richer metadata, model and metadata written atomically with a fingerprint |
| `db/forecast.py` | applies the saved level and hour factors; refuses a model paired with another run's metadata; older model files still served as before |
| `db/tune.py` | rewritten: the loop (`baseline`, `run`, `promote`, `holdout`, `weeks`, `diagnose`, `show`) |
| `models/` | new model and metadata (previous: `git show testing-rounds:models/...`) |
| `tests/test_api.py` | one test assumed the overnight shift always has room under the cap; it now looks up a shift that has |
| `README.md` | accuracy, layout and retraining sections |

Tests: 155 before, 369 now, all passing. Coverage of `db/` is 87%.

## 8. Reviews

Two independent reviewers read the finished work.

**Code review:** no critical or high-severity issues; training, backtest
and serving confirmed to compute the same thing; no database writes. Six
medium issues, all fixed: the cache key could miss moved calls; cache,
ledger and model files were not written atomically; a comparison did not
check that both forecasts were scored against the same actuals; a guard
metric that could not be computed counted as passed; a request arriving
between the two files of a retrain could pair a new model with old
metadata; the baseline cache was not tied to the data. Also fixed: windows
longer than the recent history are refused, a file cut off mid-day is
refused, header names with stray spaces are read, and `python -m db.train`
explains what to do when recent days are missing.

**Method review:** no leakage; served forecast equals the backtested one
exactly. Its main point was that the near-term gain on the tuning weeks
does not carry over to the older weeks, so the claims had to be restated
(done in section 1). It also caught two plan items I had skipped (one is
now 4.5, the other is explained in section 5), that the client weeks sit
inside the tuning weeks, and that the hold-out reason I wrote in the ledger
for the holiday flags was loosely worded (corrected in section 5).

Left as they are, by choice: the burst rule's variability constant (1.6)
was measured on May to November 2026 data, which overlaps the tuning weeks;
t values are optimistic because test weeks overlap.

## 9. Reproduce

```
# dataset (reads the database, writes only under data/)
.venv/bin/python -m db.dataset --supplement "data/client/V4W Call Records - Sept 1st 2026 thru Oct 13th 2026.xlsx" \
    "data/client/Oct 21 2026 to Oct 27 2026 - Actual Data for Validity Testing 2.xlsx" \
    "data/client/Oct 28 2026 to Nov 3 2026 - Actual Data for Validity Testing 3-2.xlsx" --snapshot data/cache/final_run

.venv/bin/python -m db.tune baseline              # old model, naive, smoother, floor
.venv/bin/python -m db.tune run level_halflife    # any family in db/experiments.py
.venv/bin/python -m db.tune holdout               # final vs old on the older weeks
.venv/bin/python -m db.tune weeks --origins 2026-10-13 2026-10-20 2026-10-27
.venv/bin/python -m db.tune diagnose              # bias by weekday and hour
.venv/bin/python -m db.train --supplement <the same three files>
```

## 10. Open items for you

1. **Done 2026-11-11: the three files are in the shared database.**
   `python -m db.load_week <file> --commit`, 10,513 calls: ids 378076 to
   386040 (Sep 1 to Oct 13), 386041 to 387340 (Oct 21 to 27), 387341 to
   388588 (Oct 28 to Nov 3). The table now holds 388,588 calls with no
   missing day. Plain `make train` then reproduced the saved model exactly
   (same model fingerprint), so `--supplement` is no longer needed. The
   rows went in directly, not through the teammates' pipeline tables.
2. **Done: committed** on `model-final-run` in two commits (the earlier
   "real calls" work, then this run), then pushed to
   `origin/model-final-run` on 2026-11-11.
3. **Done 2026-11-11: 2027 holidays added** with `python -m db.add_holidays
   2027 --commit` (11 rows, by calendar rule; the rules reproduce all 66
   older rows). Their multiplier columns follow the table's own convention
   for dates not reached yet: the mean of that holiday's measured years. The
   volume model does not read those columns.
4. **Retrain at least monthly.** The level and hour factors are frozen at
   training time, and accuracy beyond 28 days ahead was never measured.
5. **Show the four client days on the dashboard** (the holiday chip). The
   model knows them; the page does not label them yet.
6. **Handle time.** The three validation workbooks report average talk time
   of 608, 545 and 552 seconds; the dashboard's default predicted about 608
   for all three. Not touched: the request was the volume model.
7. **Next clean test:** score the next client weeks with
   `db.tune weeks` before any further tuning.
8. **Tell the client** that 96% average daily accuracy is beyond what
   random call arrival allows, and that a single week between 84% and 96%
   is normal for a forecast that is right on average.
