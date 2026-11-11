"""How good can a forecast be, and where is this one off?

Calls arrive at random. Even a forecast that knew the true average of every
hour would miss the count, so "accuracy" has a ceiling below 100%. Two
reference points put a number on it:

    poisson_mad(mean)             -> E|X - mean| for a Poisson count, closed form
    poisson_floor(predictions)    -> the error a perfect-mean forecast would
                                     still make if calls were Poisson with the
                                     forecast as their mean
    oracle_predictions(grid, origins)
                                  -> a HINDSIGHT forecast: each hour predicted
                                     by the mean of the same weekday and hour
                                     in the 4 weeks before and after it. No
                                     real forecast can see the future weeks,
                                     so this bounds what is achievable.

And one honest baseline plus the tables that say where a forecast is off:

    SeasonalNaive()               -> same weekday and hour, median of the
                                     trailing 8 weeks, as a backtest procedure
    bias_tables(predictions)      -> signed bias % per weekday, hour,
                                     (weekday, hour) cell and horizon week
    with_perfect_weekly_level(predictions)
                                  -> the same forecast with every week's
                                     total set to the truth: what is left is
                                     day-to-day randomness
    special_day_mape(predictions, special) -> error on holiday-type days

All inputs are the prediction frames of db.backtest. Nothing here fits a
model or reads the database.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from db.backtest import DAYS_PER_WEEK, NEAR, PREDICTION_COLUMNS, in_band, origin_frames, with_keys
from db.features import TARGET

ORACLE_WEEKS_EACH_SIDE = 4
NAIVE_WINDOW_DAYS = 8 * DAYS_PER_WEEK


# =============================================================================
# Poisson floor
# =============================================================================

def poisson_mad(mean: np.ndarray) -> np.ndarray:
    """Mean absolute deviation of a Poisson count around its mean:
    2 * exp(-m) * m ** (floor(m) + 1) / floor(m)!   (0 when m = 0)."""
    mean = np.asarray(mean, dtype="float64")
    if (mean < 0).any():
        raise ValueError("poisson_mad: negative mean")
    whole = np.floor(mean)
    log_factorial = np.array([math.lgamma(value + 1.0) for value in whole.ravel()]).reshape(mean.shape)
    with np.errstate(divide="ignore", invalid="ignore"):
        log_mad = math.log(2.0) - mean + (whole + 1.0) * np.log(mean) - log_factorial
    return np.where(mean > 0, np.exp(log_mad), 0.0)


def poisson_floor(predictions: pd.DataFrame) -> dict:
    """Error left over if every predicted mean were exactly right and calls
    were Poisson. Real calls are burstier than Poisson, so the true floor is
    somewhat higher than this."""
    near = in_band(with_keys(predictions), NEAR)
    daily_mean = near.groupby(["origin", "day"])["predicted"].sum()
    daily_mean = daily_mean[daily_mean > 0]
    return {
        "hourly_mae_1_14": float(poisson_mad(near["predicted"].to_numpy()).mean()),
        "daily_mape_1_14": float((poisson_mad(daily_mean.to_numpy()) / daily_mean.to_numpy()).mean() * 100),
    }


# =============================================================================
# Hindsight oracle and the naive baseline
# =============================================================================

def _neighbour_weeks_mean(offered: pd.Series, hours: pd.Series) -> np.ndarray:
    """Mean of `offered` at the same weekday and hour 1..4 weeks before and
    after each hour, over the neighbours that exist."""
    shifts = [sign * week for week in range(1, ORACLE_WEEKS_EACH_SIDE + 1) for sign in (-1, 1)]
    neighbours = np.vstack([
        offered.reindex(hours + pd.Timedelta(days=DAYS_PER_WEEK * shift)).to_numpy(dtype="float64")
        for shift in shifts
    ])
    if np.isnan(neighbours).all(axis=0).any():
        raise ValueError("oracle: an hour has no neighbouring week in the data")
    return np.nanmean(neighbours, axis=0)


def oracle_predictions(grid: pd.DataFrame, origins: list[pd.Timestamp]) -> pd.DataFrame:
    """Hindsight forecast for the same hours db.backtest.run_origins scores."""
    offered = grid.set_index("hour_start")[TARGET].astype("float64")
    parts = []
    for origin in origins:
        _, future = origin_frames(grid, origin)
        parts.append(pd.DataFrame({
            "origin": pd.Timestamp(origin),
            "hour_start": future["hour_start"].to_numpy(),
            "horizon_day": future["horizon_day"].to_numpy(),
            "actual": future[TARGET].to_numpy(dtype="float64"),
            "predicted": _neighbour_weeks_mean(offered, future["hour_start"]),
        }))
    return pd.concat(parts, ignore_index=True)[list(PREDICTION_COLUMNS)]


def predict_seasonal_naive(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """Median `offered` per (dow, hour) over the trailing 8 weeks of train."""
    window_start = test["hour_start"].min() - pd.Timedelta(days=NAIVE_WINDOW_DAYS)
    window = train[train["hour_start"] >= window_start]
    medians = window.groupby(["dow", "hour"])[TARGET].median()

    keys = pd.MultiIndex.from_frame(test[["dow", "hour"]])
    predicted = medians.reindex(keys).to_numpy()
    if np.isnan(predicted).any():
        raise ValueError("seasonal naive: some (dow, hour) cells have no trailing history")
    return predicted


class SeasonalNaive:
    """The baseline every model must beat: the median of the same weekday
    and hour over the trailing 8 weeks. Frames need the `dow` and `hour`
    feature columns."""

    def __call__(self, train: pd.DataFrame, future: pd.DataFrame) -> np.ndarray:
        return predict_seasonal_naive(train, future)


def with_perfect_weekly_level(predictions: pd.DataFrame) -> pd.DataFrame:
    """A NEW prediction frame in which every (origin, test week) is rescaled
    so its predicted total equals the actual total: the forecast you would
    have if next week's total were known in advance and only the split over
    days and hours had to be forecast. Whatever error is left is the part no
    level correction can remove."""
    keyed = with_keys(predictions)
    totals = keyed.groupby(["origin", "test_week"])[["actual", "predicted"]].transform("sum")
    scale = (totals["actual"] / totals["predicted"]).where(totals["predicted"] > 0, 1.0)
    return predictions.assign(predicted=predictions["predicted"] * scale.to_numpy())


def special_day_mape(predictions: pd.DataFrame, special: frozenset) -> dict:
    """Mean daily abs % error on holiday-type days only, every horizon.
    {"days": how many (origin, day) forecasts, "daily_mape": percent}."""
    frame = with_keys(predictions)
    frame = frame[frame["day"].isin(list(special))]
    daily = frame.groupby(["origin", "day"])[["actual", "predicted"]].sum()
    daily = daily[daily["actual"] > 0]
    if daily.empty:
        return {"days": 0, "daily_mape": float("nan")}
    ape = (daily["predicted"] - daily["actual"]).abs() / daily["actual"] * 100
    return {"days": int(len(daily)), "daily_mape": float(ape.mean())}


# =============================================================================
# Bias tables
# =============================================================================

def _bias_table(frame: pd.DataFrame, by: list[str]) -> pd.DataFrame:
    sums = frame.groupby(by)[["actual", "predicted"]].sum()
    return sums.assign(bias_pct=(sums["predicted"] - sums["actual"]) / sums["actual"] * 100)


def bias_tables(predictions: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Signed bias % (positive = forecast too high). `dow`, `hour` and `cell`
    cover horizon days 1 to 14; `horizon_week` covers every horizon.
    `cell` is a 7 x 24 table: rows weekday 1 = Mon .. 7 = Sun, columns hour."""
    frame = with_keys(predictions)
    frame = frame.assign(horizon_week=(frame["horizon_day"] - 1) // DAYS_PER_WEEK + 1)
    near = in_band(frame, NEAR)
    return {
        "dow": _bias_table(near, ["dow"]),
        "hour": _bias_table(near, ["hour"]),
        "cell": _bias_table(near, ["dow", "hour"])["bias_pct"].unstack("hour"),
        "horizon_week": _bias_table(frame, ["horizon_week"]),
    }
