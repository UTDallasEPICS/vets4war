"""Level correction for the volume forecast, from the most recent weeks.

The partner's Oct 14-20 2026 validation showed every day under-forecast
(week total 8.6% low). Trees cannot extrapolate a level they have not seen,
so the model repeats old levels. This module measures the recent level gap
OUT OF SAMPLE and scales the forecast by it, within a cap.

    recent_window_start(hour_start, window_days) -> first hour of the window
        the window = the last `window_days` calendar days that HAVE data
        (days missing from the data, e.g. an unreported gap, are skipped)
    level_factor(actual, predicted, cap) -> float in [1 - cap, 1 + cap]
        sum(actual) / sum(predicted), clipped

How training uses it (db.train.fit_level_factor):
    1. fit the model on every hour BEFORE the window
    2. predict the window, compare with what actually happened
    3. factor = level_factor(...); the final model's forecast is multiplied by it
The backtest (db.tune) runs the same three steps inside every fold, so the
reported accuracy is the accuracy of this exact procedure.

The cap stops one odd week from swinging the forecast too far.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LEVEL_WINDOW_DAYS = 7
LEVEL_CAP = 0.15


def recent_window_start(hour_start: pd.Series, window_days: int = LEVEL_WINDOW_DAYS) -> pd.Timestamp:
    """Midnight of the earliest of the last `window_days` days present in
    `hour_start`. Raises if the data has no more days than the window (then
    nothing would be left to fit on)."""
    if window_days < 1:
        raise ValueError(f"window_days must be >= 1, got {window_days}")
    days = pd.Series(pd.to_datetime(hour_start).dt.normalize().unique()).sort_values()
    if len(days) <= window_days:
        raise ValueError(f"only {len(days)} days of data; need more than {window_days} for a level window")
    return pd.Timestamp(days.iloc[-window_days])


def level_factor(actual: np.ndarray, predicted: np.ndarray, cap: float = LEVEL_CAP) -> float:
    """Ratio of actual to predicted totals, clipped to [1 - cap, 1 + cap]."""
    if not 0 <= cap < 1:
        raise ValueError(f"cap must be in [0, 1), got {cap}")
    actual_total = float(np.sum(actual))
    predicted_total = float(np.sum(predicted))
    if predicted_total <= 0:
        raise ValueError("predicted total is not positive; level factor is undefined")
    return float(np.clip(actual_total / predicted_total, 1 - cap, 1 + cap))
