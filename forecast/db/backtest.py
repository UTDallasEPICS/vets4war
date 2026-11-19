"""Weekly rolling-origin backtest: folds, horizon bands, metrics, acceptance rule.

An ORIGIN is the last training day. For each origin the procedure trains on
every hour up to and including that day and predicts the next 28 days with
no access to them. Origins step back one week at a time from the last
origin that still leaves a full 7-day test week.

    weekly_origins(days, n, skip)          -> origins, oldest first
    origin_frames(featured, origin)        -> (train, future) with horizon_day
    run_origins(featured, origins, procedure, workers)
                                           -> predictions, one row per hour:
                                              origin, hour_start, horizon_day,
                                              actual, predicted
    score(predictions)                     -> every metric of the plan
    compare(candidate, incumbent, focus)   -> deltas, paired t, accept/reject

A `procedure` is any picklable callable `(train, future) -> predictions`.
The protocol and the acceptance rule were fixed before any result was seen:
docs/superpowers/plans/2026-11-10-model-final-run.md.

Horizon bands: near = days 1 to 14 (what the client validates), far = days
15 to 28 (monthly schedules), first week = days 1 to 7.
"""

from __future__ import annotations

import math
from concurrent.futures import ProcessPoolExecutor
from typing import Callable

import numpy as np
import pandas as pd

from db.features import TARGET

HORIZON_DAYS = 28
DAYS_PER_WEEK = 7
BLOCK_HOURS = 4
MIN_TRAIN_DAYS = 56

PREDICTION_COLUMNS = ("origin", "hour_start", "horizon_day", "actual", "predicted")
FIRST_WEEK = (1, 7)
SECOND_WEEK = (8, 14)
NEAR = (1, 14)
FAR = (15, 28)

# Acceptance rule (percent). See the plan for the reasoning.
REL_GAIN = 0.5            # required relative gain on the metric being improved
T_MIN = 1.0               # required paired t over test weeks
REL_GUARD = 1.0           # a guarded metric may not get worse by more than this
ABS_GUARD = 0.1           # same, for metrics measured in points
DAILY_TOLERANCE = 0.2     # an hours-only change may cost at most this on days
GUARDED_RELATIVE = ("daily_mape_15_28", "hourly_mae_1_14", "block_wape_1_14")
GUARDED_ABSOLUTE = ("week_acc_std", "dow_bias_max")
HOURS_METRICS = ("block_wape_1_14", "hourly_mae_1_14")
T_METRICS = ("daily_mape_1_14", "hourly_mae_1_14", "block_wape_1_14")

Procedure = Callable[[pd.DataFrame, pd.DataFrame], np.ndarray]


# =============================================================================
# Folds
# =============================================================================

def weekly_origins(days: pd.DatetimeIndex, n: int, skip: int = 0,
                   min_train_days: int = MIN_TRAIN_DAYS) -> list[pd.Timestamp]:
    """`n` origins one week apart, oldest first. The newest (skip=0) is the
    last day that still leaves 7 test days; `skip` drops that many of the
    newest origins, so a block of older origins can be held out."""
    if n < 1 or skip < 0:
        raise ValueError(f"need n >= 1 and skip >= 0, got n={n}, skip={skip}")
    days = pd.DatetimeIndex(days).normalize().unique().sort_values()
    last = days.max()
    origins = [last - pd.Timedelta(days=DAYS_PER_WEEK * (k + 1)) for k in range(skip, skip + n)]
    oldest = min(origins)
    if oldest - days.min() < pd.Timedelta(days=min_train_days):
        raise ValueError(f"not enough history: oldest origin {oldest.date()} leaves under "
                         f"{min_train_days} training days (data starts {days.min().date()})")
    expected = pd.date_range(oldest, last, freq="D")
    if len(expected.difference(days)):
        raise ValueError(f"data has missing days between {oldest.date()} and {last.date()}")
    return sorted(origins)


def origin_frames(featured: pd.DataFrame, origin: pd.Timestamp,
                  horizon_days: int = HORIZON_DAYS) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(train, future). train = every hour up to the end of the origin day;
    future = the next `horizon_days` days that exist, with `horizon_day`
    1 = the day after the origin."""
    first_future = pd.Timestamp(origin).normalize() + pd.Timedelta(days=1)
    hour_start = featured["hour_start"]
    train = featured[hour_start < first_future]
    is_future = (hour_start >= first_future) & (hour_start < first_future + pd.Timedelta(days=horizon_days))
    future = featured[is_future]
    horizon = (future["hour_start"].dt.normalize() - first_future).dt.days + 1
    return train, future.assign(horizon_day=horizon.to_numpy())


# =============================================================================
# Runner
# =============================================================================

# Filled once per worker process by _init_worker so the frame is sent to each
# worker once, not once per origin. Never touched in the parent process.
_WORKER: dict = {}


def _run_task(featured: pd.DataFrame, origin: pd.Timestamp, task: Callable):
    train, future = origin_frames(featured, origin)
    if train.empty or future.empty:
        raise ValueError(f"origin {pd.Timestamp(origin).date()}: empty train or future window")
    return task(train, future)


def _init_worker(featured: pd.DataFrame, task: Callable) -> None:
    _WORKER["featured"] = featured
    _WORKER["task"] = task


def _worker_run(origin: pd.Timestamp):
    return _run_task(_WORKER["featured"], origin, _WORKER["task"])


def map_origins(featured: pd.DataFrame, origins: list[pd.Timestamp], task: Callable, workers: int = 1) -> list:
    """`task(train, future)` at every origin, results in origin order.
    `task` must be picklable when workers > 1."""
    if workers <= 1:
        return [_run_task(featured, origin, task) for origin in origins]
    with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(featured, task)) as pool:
        return list(pool.map(_worker_run, origins))


class _AsPredictions:
    """Turns a procedure into a task that returns the prediction frame."""

    def __init__(self, procedure: Procedure):
        self.procedure = procedure

    def __call__(self, train: pd.DataFrame, future: pd.DataFrame) -> pd.DataFrame:
        origin = train["hour_start"].max().normalize()
        predicted = np.asarray(self.procedure(train, future), dtype="float64")
        if predicted.shape != (len(future),):
            raise ValueError(f"origin {origin.date()}: procedure returned {predicted.shape}, "
                             f"expected ({len(future)},)")
        return pd.DataFrame({
            "origin": origin,
            "hour_start": future["hour_start"].to_numpy(),
            "horizon_day": future["horizon_day"].to_numpy(),
            "actual": future[TARGET].to_numpy(dtype="float64"),
            "predicted": predicted,
        })


def run_origins(featured: pd.DataFrame, origins: list[pd.Timestamp], procedure: Procedure,
                workers: int = 1) -> pd.DataFrame:
    """Run `procedure` at every origin. `featured` needs hour_start and the
    target column plus whatever the procedure reads."""
    parts = map_origins(featured, origins, _AsPredictions(procedure), workers)
    return pd.concat(parts, ignore_index=True)[list(PREDICTION_COLUMNS)]


# =============================================================================
# Metrics
# =============================================================================

def _validate(predictions: pd.DataFrame) -> None:
    missing = [c for c in PREDICTION_COLUMNS if c not in predictions.columns]
    if missing:
        raise ValueError(f"predictions is missing columns {missing}")


def in_band(frame: pd.DataFrame, band: tuple[int, int]) -> pd.DataFrame:
    return frame[(frame["horizon_day"] >= band[0]) & (frame["horizon_day"] <= band[1])]


def with_keys(frame: pd.DataFrame) -> pd.DataFrame:
    """Add the grouping keys every metric uses."""
    day = frame["hour_start"].dt.normalize()
    week_index = (frame["horizon_day"] - 1) // DAYS_PER_WEEK
    return frame.assign(
        day=day,
        dow=frame["hour_start"].dt.dayofweek + 1,                 # 1 = Mon .. 7 = Sun
        hour=frame["hour_start"].dt.hour,
        block=frame["hour_start"].dt.hour // BLOCK_HOURS,
        test_week=frame["origin"] + pd.to_timedelta(week_index * DAYS_PER_WEEK + 1, unit="D"),
    )


def _daily(frame: pd.DataFrame) -> pd.DataFrame:
    """One row per (origin, day): totals and absolute percent error."""
    daily = frame.groupby(["origin", "day", "test_week"], as_index=False)[["actual", "predicted"]].sum()
    daily = daily[daily["actual"] > 0]
    return daily.assign(ape=(daily["predicted"] - daily["actual"]).abs() / daily["actual"] * 100)


def _bias_pct(frame: pd.DataFrame, by: list[str]) -> pd.Series:
    sums = frame.groupby(by)[["actual", "predicted"]].sum()
    sums = sums[sums["actual"] > 0]
    return (sums["predicted"] - sums["actual"]) / sums["actual"] * 100


def _block_errors(frame: pd.DataFrame) -> pd.DataFrame:
    """Absolute error of each (origin, test week, weekday, 4-hour block) total."""
    sums = frame.groupby(["origin", "test_week", "dow", "block"], as_index=False)[["actual", "predicted"]].sum()
    return sums.assign(abs_error=(sums["predicted"] - sums["actual"]).abs())


def _wape(blocks: pd.DataFrame) -> float:
    total = blocks["actual"].sum()
    return float(blocks["abs_error"].sum() / total * 100) if total > 0 else float("nan")


def _mean(values: pd.Series) -> float:
    return float(values.mean()) if len(values) else float("nan")


def _overall_bias_pct(frame: pd.DataFrame) -> float:
    actual = float(frame["actual"].sum())
    return (float(frame["predicted"].sum()) - actual) / actual * 100 if actual > 0 else float("nan")


def _week_accuracy(first_week: pd.DataFrame) -> pd.Series:
    """Client accuracy (100 - mean daily abs % error) of each origin's first
    test week. Origins with fewer than 7 test days are left out."""
    daily = _daily(first_week)
    per_origin = daily.groupby("origin")["ape"].agg(["mean", "size"])
    return 100 - per_origin.loc[per_origin["size"] == DAYS_PER_WEEK, "mean"]


def _week_total_ape(first_week: pd.DataFrame) -> float:
    totals = first_week.groupby("origin")[["actual", "predicted"]].sum()
    totals = totals[totals["actual"] > 0]
    return _mean((totals["predicted"] - totals["actual"]).abs() / totals["actual"] * 100)


def score(predictions: pd.DataFrame) -> dict:
    """Every metric of the evaluation protocol, in percent or calls."""
    _validate(predictions)
    frame = with_keys(predictions)
    near, far, first_week = in_band(frame, NEAR), in_band(frame, FAR), in_band(frame, FIRST_WEEK)
    week_accuracy = _week_accuracy(first_week)
    dow_bias = _bias_pct(near, ["dow"])
    cell_bias = _bias_pct(near, ["dow", "hour"])
    return {
        "daily_mape_1_14": _mean(_daily(near)["ape"]),
        "daily_mape_1_7": _mean(_daily(first_week)["ape"]),
        "daily_mape_8_14": _mean(_daily(in_band(frame, SECOND_WEEK))["ape"]),
        "daily_mape_15_28": _mean(_daily(far)["ape"]),
        "hourly_mae_1_14": _mean((near["predicted"] - near["actual"]).abs()),
        "hourly_mae_15_28": _mean((far["predicted"] - far["actual"]).abs()),
        "block_wape_1_14": _wape(_block_errors(near)),
        "week_acc_mean": _mean(week_accuracy),
        "week_acc_std": float(week_accuracy.std(ddof=1)) if len(week_accuracy) > 1 else float("nan"),
        "week_acc_min": float(week_accuracy.min()) if len(week_accuracy) else float("nan"),
        "weeks_scored": int(len(week_accuracy)),
        "week_total_ape": _week_total_ape(first_week),
        "bias_pct_1_14": _overall_bias_pct(near),
        "dow_bias": {int(dow): float(value) for dow, value in dow_bias.items()},
        "dow_bias_max": float(dow_bias.abs().max()) if len(dow_bias) else float("nan"),
        "cell_bias_rms": float(np.sqrt((cell_bias ** 2).mean())) if len(cell_bias) else float("nan"),
    }


# =============================================================================
# Comparison
# =============================================================================

def paired_t(candidate: pd.Series, incumbent: pd.Series) -> float:
    """t statistic of the mean paired difference (candidate - incumbent).
    Negative = the candidate's error is lower."""
    diff = (candidate - incumbent).dropna()
    if len(diff) < 2:
        return 0.0
    mean, spread = float(diff.mean()), float(diff.std(ddof=1))
    if spread == 0:
        return 0.0 if mean == 0 else math.copysign(math.inf, mean)
    return mean / (spread / math.sqrt(len(diff)))


def _per_test_week(predictions: pd.DataFrame) -> pd.DataFrame:
    """The three t-tested metrics, one row per calendar test week (near band)."""
    near = in_band(with_keys(predictions), NEAR)
    blocks = _block_errors(near).groupby("test_week")[["abs_error", "actual"]].sum()
    return pd.DataFrame({
        "daily_mape_1_14": _daily(near).groupby("test_week")["ape"].mean(),
        "hourly_mae_1_14": (near["predicted"] - near["actual"]).abs().groupby(near["test_week"]).mean(),
        "block_wape_1_14": blocks["abs_error"] / blocks["actual"] * 100,
    })


def _relative_delta(candidate: float, incumbent: float) -> float:
    if incumbent == 0:
        return 0.0 if candidate == 0 else math.inf
    return (candidate - incumbent) / incumbent * 100


def _same_hours(candidate: pd.DataFrame, incumbent: pd.DataFrame) -> bool:
    """Same origins, same hours AND the same actual counts: two forecasts
    scored against different versions of the truth cannot be compared."""
    keys = ["origin", "hour_start"]
    left = candidate.sort_values(keys).reset_index(drop=True)
    right = incumbent.sort_values(keys).reset_index(drop=True)
    return (len(left) == len(right) and left[keys].equals(right[keys])
            and np.allclose(left["actual"].to_numpy(), right["actual"].to_numpy()))


def _verdict(delta_pct: dict, delta_abs: dict, t: dict, focus: str) -> tuple[str, str]:
    # "not <=" rather than ">": a guard that could not be computed (NaN)
    # counts as broken, never as passed.
    broken = [m for m in GUARDED_RELATIVE if not delta_pct[m] <= REL_GUARD]
    broken += [m for m in GUARDED_ABSOLUTE if not delta_abs[m] <= ABS_GUARD]
    if broken:
        return "reject", "worse on " + ", ".join(broken)
    if delta_pct["daily_mape_1_14"] <= -REL_GAIN and t["daily_mape_1_14"] <= -T_MIN:
        return "accept", "daily accuracy improved"
    if focus == "hours" and delta_pct["daily_mape_1_14"] <= DAILY_TOLERANCE:
        gained = [m for m in HOURS_METRICS if delta_pct[m] <= -REL_GAIN and t[m] <= -T_MIN]
        if gained:
            return "accept", "hours improved on " + ", ".join(gained)
    return "reject", "gain below the acceptance bar"


def compare(candidate: pd.DataFrame, incumbent: pd.DataFrame, focus: str = "daily") -> dict:
    """Score both forecasts on the same hours and apply the acceptance rule.
    focus="hours" also accepts a change that improves the hour-level metrics
    while leaving daily accuracy flat."""
    if focus not in ("daily", "hours"):
        raise ValueError(f"focus must be 'daily' or 'hours', got {focus!r}")
    _validate(candidate)
    _validate(incumbent)
    if not _same_hours(candidate, incumbent):
        raise ValueError("candidate and incumbent must cover the same origins and hours, with the same actual counts")

    cand, inc = score(candidate), score(incumbent)
    delta_pct = {m: _relative_delta(cand[m], inc[m]) for m in ("daily_mape_1_14", *GUARDED_RELATIVE)}
    delta_abs = {m: cand[m] - inc[m] for m in GUARDED_ABSOLUTE}
    cand_weeks, inc_weeks = _per_test_week(candidate), _per_test_week(incumbent)
    t = {m: paired_t(cand_weeks[m], inc_weeks[m]) for m in T_METRICS}
    verdict, reason = _verdict(delta_pct, delta_abs, t, focus)
    return {"candidate": cand, "incumbent": inc, "delta_pct": delta_pct, "delta_abs": delta_abs,
            "t": t, "verdict": verdict, "reason": reason}
