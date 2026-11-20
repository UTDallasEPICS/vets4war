#!/usr/bin/env python3
"""SYNTHETIC call records shaped like the Vets4Warriors line. NOT real data.

Nothing here comes from the partner. Every number is drawn from a seeded
random generator whose shape follows what the repository documents about the
real line: about 180 calls a day around the clock, busiest in the evening,
~14% of callers hang up (about half of them within 10 seconds), handle time
around 15 minutes, Thanksgiving and Christmas quieter, counts more variable
than Poisson (variance / mean ~1.6), the occasional burst from one caller.
Timestamps are naive local wall-clock: hour 2 is empty on spring-forward
Sundays and hour 1 is doubled on fall-back Sundays.

    cd forecast && .venv/bin/python tools/gen_synthetic.py OUT_DIR [--start 2021-01-01] [--end 2026-11-17] [--seed 4]

Writes OUT_DIR/SYNTHETIC_calls_all.csv.gz with the `calls` table columns
(start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned)
and prints a summary. Deterministic for a given seed and date range: the
defaults reproduce the calls of the legacy reference stack used to prove the
rebuild (same rows, byte for byte once decompressed).

For tests, parity runs and demos only. Real call data comes in through the
web app's admin page and is never generated, copied into or committed with
this folder.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HOUR_WEIGHTS = np.array([9.5, 9.0, 8.5, 7.0, 5.5, 4.5, 4.0, 4.5, 5.5, 6.5, 7.0, 7.5,
                         7.5, 7.5, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5, 11.0, 11.0, 10.5])
MEAN_DAILY_CALLS = 169.0
DOW_FACTOR = np.array([1.05, 1.04, 1.02, 1.00, 0.98, 0.94, 0.97])       # Monday .. Sunday
WEEKEND_HOUR_TILT = np.array([1.10] * 4 + [1.0] * 4 + [0.92] * 8 + [1.03] * 8)
DISPERSION = 1.6                    # variance / mean of an hour's count
BURST_PROBABILITY = 0.001           # share of hours with one caller ringing over and over
QUICK_HANGUP_SHARE = 0.06           # callers who hang up almost at once
QUICK_PATIENCE_SEC = 4.0
PATIENCE_SEC = 420.0
QUEUE_DELAY_SEC = 70.0
SHORT_CALL_SHARE = 0.22
SHORT_CALL_SEC = 70.0
LONG_CALL_MEDIAN_SEC = 620.0
LONG_CALL_SIGMA = 0.6
MAJOR_HOLIDAY_FACTOR = 0.83
HOLIDAY_FACTOR = 0.92
ADJACENT_FACTOR = 0.96
SYNTHETIC_CALLS_FILE = "SYNTHETIC_calls_all.csv.gz"


def nth_weekday(year: int, month: int, weekday: int, nth: int) -> pd.Timestamp:
    first = pd.Timestamp(year=year, month=month, day=1)
    offset = (weekday - first.dayofweek) % 7
    if nth > 0:
        return first + pd.Timedelta(days=offset + 7 * (nth - 1))
    last = first + pd.offsets.MonthEnd(0)
    return last - pd.Timedelta(days=(last.dayofweek - weekday) % 7)


def official_holidays(year: int) -> dict[pd.Timestamp, str]:
    """The 11 official holidays on their calendar date (same rules as the
    repository's db/add_holidays.py)."""
    days = {
        pd.Timestamp(year, 1, 1): "New Year's Day",
        nth_weekday(year, 1, 0, 3): "MLK Day",
        nth_weekday(year, 2, 0, 3): "Presidents Day",
        nth_weekday(year, 5, 0, -1): "Memorial Day",
        pd.Timestamp(year, 6, 19): "Juneteenth",
        pd.Timestamp(year, 7, 4): "Independence Day",
        nth_weekday(year, 9, 0, 1): "Labor Day",
        nth_weekday(year, 10, 0, 2): "Columbus Day",
        pd.Timestamp(year, 11, 11): "Veterans Day",
        nth_weekday(year, 11, 3, 4): "Thanksgiving",
        pd.Timestamp(year, 12, 25): "Christmas",
    }
    return days


def day_factor(day: pd.Timestamp) -> float:
    names = official_holidays(day.year)
    if day in names:
        return MAJOR_HOLIDAY_FACTOR if names[day] in ("Thanksgiving", "Christmas") else HOLIDAY_FACTOR
    turkey = nth_weekday(day.year, 11, 3, 4)
    adjacent = {turkey - pd.Timedelta(days=1), turkey + pd.Timedelta(days=1),
                pd.Timestamp(day.year, 12, 24), pd.Timestamp(day.year, 12, 31)}
    return ADJACENT_FACTOR if day in adjacent else 1.0


def level_curve(days: pd.DatetimeIndex, rng: np.random.Generator) -> np.ndarray:
    """A slow wave, mild growth and a weekly random walk that reverts to 1:
    the kind of level drift the calibration step exists for."""
    t = (days - days[0]).days.to_numpy() / 365.25
    slow = 1.0 + 0.07 * np.sin(2 * np.pi * t / 2.3) + 0.015 * t
    weeks = (days - days[0]).days.to_numpy() // 7
    shocks = rng.normal(0.0, 0.025, size=weeks.max() + 1)
    walk = np.zeros(len(shocks))
    for i in range(1, len(shocks)):
        walk[i] = 0.85 * walk[i - 1] + shocks[i]
    return slow * np.exp(walk[weeks])


def hourly_rates(days: pd.DatetimeIndex, rng: np.random.Generator) -> np.ndarray:
    """Expected calls for every (day, hour): shape (n_days, 24)."""
    level = level_curve(days, rng)
    base = HOUR_WEIGHTS / HOUR_WEIGHTS.sum() * MEAN_DAILY_CALLS
    rates = np.empty((len(days), 24))
    for i, day in enumerate(days):
        profile = base * (WEEKEND_HOUR_TILT if day.dayofweek >= 5 else 1.0)
        rates[i] = profile * DOW_FACTOR[day.dayofweek] * day_factor(day) * level[i]
        if day.dayofweek == 6 and day.month == 3 and 8 <= day.day <= 14:
            rates[i, 2] = 0.0                       # spring forward: 02:00 does not exist
        if day.dayofweek == 6 and day.month == 11 and day.day <= 7:
            rates[i, 1] *= 2.0                      # fall back: 01:00 happens twice
    return rates


def draw_counts(rates: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Negative binomial counts with variance = DISPERSION x mean, plus rare bursts."""
    shape = rates / (DISPERSION - 1.0)
    counts = np.where(rates > 0, rng.negative_binomial(np.maximum(shape, 1e-9), 1.0 / DISPERSION), 0)
    bursts = (rng.random(rates.shape) < BURST_PROBABILITY) & (rates > 0)
    return counts + bursts * rng.integers(15, 41, size=rates.shape)


def handle_time_factor(dow: np.ndarray, hour: np.ndarray, years_in: np.ndarray) -> np.ndarray:
    night = np.where((hour < 6) | (hour >= 22), 1.15, 1.0)
    daytime = np.where((hour >= 9) & (hour < 16), 0.92, 1.0)
    weekend = np.where(dow >= 5, 1.05, 1.0)
    return night * daytime * weekend * (1.0 + 0.012 * years_in)


def build_calls(days: pd.DatetimeIndex, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    counts = draw_counts(hourly_rates(days, rng), rng)

    day_index, hour = np.nonzero(counts)
    repeats = counts[day_index, hour]
    day_of_call = np.repeat(day_index, repeats)
    hour_of_call = np.repeat(hour, repeats)
    n = len(day_of_call)

    second = rng.integers(0, 3600, size=n)
    start = days.to_numpy()[day_of_call] + hour_of_call.astype("timedelta64[h]") + second.astype("timedelta64[s]")

    routing = np.clip(np.rint(rng.normal(17.0, 4.0, size=n)), 2, 40)
    busy = HOUR_WEIGHTS[hour_of_call] / HOUR_WEIGHTS.max()
    waits = rng.random(n) < (0.18 + 0.27 * busy)
    delay = np.where(waits, rng.exponential(QUEUE_DELAY_SEC, size=n), 0.0)
    offered_wait = routing + np.rint(delay)

    quick = rng.random(n) < QUICK_HANGUP_SHARE
    patience = np.where(quick, rng.exponential(QUICK_PATIENCE_SEC, size=n), rng.exponential(PATIENCE_SEC, size=n))
    abandoned = patience < offered_wait
    abandon_sec = np.where(abandoned, np.maximum(1, np.rint(patience)), 0)
    in_queue_sec = np.where(abandoned, abandon_sec, offered_wait)

    dow = pd.DatetimeIndex(start).dayofweek.to_numpy()
    years_in = (day_of_call / 365.25)
    short = rng.random(n) < SHORT_CALL_SHARE
    talk = np.where(short, rng.exponential(SHORT_CALL_SEC, size=n),
                    rng.lognormal(np.log(LONG_CALL_MEDIAN_SEC), LONG_CALL_SIGMA, size=n))
    talk = np.maximum(1, np.rint(talk * handle_time_factor(dow, hour_of_call, years_in)))
    # Answered calls recorded with zero agent time: mostly the early years.
    year = pd.DatetimeIndex(start).year.to_numpy()
    zero_talk = rng.random(n) < np.where(year <= 2023, 0.02, 0.002)
    agent_sec = np.where(abandoned | zero_talk, 0, talk)

    calls = pd.DataFrame({
        "start_ts": start,
        "in_queue_sec": in_queue_sec.astype("int64"),
        "agent_sec": agent_sec.astype("int64"),
        "abandon_sec": abandon_sec.astype("int64"),
        "routing_sec": routing.astype("int64"),
        "abandoned": abandoned,
    })
    return calls.sort_values("start_ts", kind="stable").reset_index(drop=True)


def summarize(calls: pd.DataFrame) -> str:
    days = calls["start_ts"].dt.normalize()
    answered = calls[~calls["abandoned"]]
    gone = calls[calls["abandoned"]]
    wait = np.where(calls["abandoned"], calls["abandon_sec"], calls["in_queue_sec"]).sum()
    return "\n".join([
        f"calls            {len(calls):,}",
        f"days             {days.nunique():,}  {days.min().date()} to {days.max().date()}",
        f"calls per day    {len(calls) / days.nunique():.1f}",
        f"abandoned share  {calls['abandoned'].mean():.4f}",
        f"quick (<10 s) share of abandoned  {(gone['abandon_sec'] < 10).mean():.4f}",
        f"patience (censored MLE)  {wait / len(gone):.1f} s",
        f"mean handle time (answered, >0)  {answered.loc[answered['agent_sec'] > 0, 'agent_sec'].mean():.1f} s",
        f"zero agent time among answered   {(answered['agent_sec'] == 0).mean():.4f}",
        f"real calls (>120 s talk) share   {(~calls['abandoned'] & (calls['agent_sec'] > 120)).mean():.4f}",
    ])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write SYNTHETIC call records (not real data).")
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--start", default="2021-01-01")
    parser.add_argument("--end", default="2026-11-17")
    parser.add_argument("--seed", type=int, default=4)
    args = parser.parse_args(argv)

    days = pd.date_range(args.start, args.end, freq="D")
    calls = build_calls(days, args.seed)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    target = args.out_dir / SYNTHETIC_CALLS_FILE
    calls.to_csv(target, index=False)
    print(summarize(calls))
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
