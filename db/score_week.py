"""Score a frozen forecast (db.snapshot CSV) against the partner's actuals.

    python -m db.score_week forecasts/forecast_...csv "path/to/actuals.xlsx"

The agreed score (2026-10-25 plan), all computed only over dates present in
BOTH files:

    daily_accuracy_pct   100 - mean over days of |predicted - actual| / actual
                         (the "92%" quoted at the 2026-10-21 meeting)
    week_error_pct       (predicted week total - actual) / actual
    hourly_mae           mean absolute error per hour, calls
    aht_sec              mean agent_sec of answered calls with agent_sec > 0
                         vs the call-weighted predicted handle time
    abandon_share        actual share of calls abandoned vs the model's
                         expectation AT THE PARTNER'S ROSTER
    service_level        actual share of ALL calls answered within the
                         target vs the model's expectation at the roster

Pure function score_week() does the arithmetic; main() only reads files.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from db.load_week import parse_call_records

DEFAULT_TARGET_SEC = 30
SNAPSHOT_COLUMNS = ("date", "hour", "predicted_calls", "aht_sec", "sl_at_roster", "abandon_share_at_roster")


def _validate_snapshot(snapshot: pd.DataFrame) -> None:
    missing = [c for c in SNAPSHOT_COLUMNS if c not in snapshot.columns]
    if missing:
        raise ValueError(f"snapshot is missing columns {missing}; expected a db.snapshot CSV")


def _actual_hourly(calls: pd.DataFrame) -> pd.DataFrame:
    return (calls.assign(date=calls["start_ts"].dt.strftime("%Y-%m-%d"), hour=calls["start_ts"].dt.hour)
            .groupby(["date", "hour"]).size().rename("actual_calls").reset_index())


def _weighted(frame: pd.DataFrame, column: str) -> float:
    # Weight hour-level rates by predicted arrivals so low-volume hours do not
    # contribute as much as high-volume hours to a call-level estimate.
    return float((frame["predicted_calls"] * frame[column]).sum() / frame["predicted_calls"].sum())


def score_week(calls: pd.DataFrame, snapshot: pd.DataFrame, target_sec: float = DEFAULT_TARGET_SEC) -> dict:
    """calls: db.load_week.parse_call_records output. snapshot: db.snapshot CSV."""
    _validate_snapshot(snapshot)
    snap = snapshot.assign(date=snapshot["date"].astype(str))
    # Score only dates available on both sides; a partial overlap is explicit
    # and preserves the no-lookahead frozen-forecast comparison.
    shared = sorted(set(snap["date"]) & set(calls["start_ts"].dt.strftime("%Y-%m-%d")))
    if not shared:
        raise ValueError("the forecast and the actuals share no dates")
    snap = snap[snap["date"].isin(shared)]
    calls = calls[calls["start_ts"].dt.strftime("%Y-%m-%d").isin(shared)]

    # A forecast hour with no actual call rows is a real zero-call hour, so the
    # left join retains it and fills only that missing count.
    hourly = snap.merge(_actual_hourly(calls), on=["date", "hour"], how="left").fillna({"actual_calls": 0})
    # Daily actuals straight from the calls, so no call is lost if the
    # snapshot were ever missing an hour.
    daily = pd.DataFrame({
        "predicted_calls": snap.groupby("date")["predicted_calls"].sum(),
        "actual_calls": calls.groupby(calls["start_ts"].dt.strftime("%Y-%m-%d")).size(),
    })
    daily = daily.assign(error_pct=(daily["predicted_calls"] - daily["actual_calls"]) / daily["actual_calls"] * 100)

    answered = calls[~calls["abandoned"] & (calls["agent_sec"] > 0)]
    in_target = (~calls["abandoned"]) & (calls["in_queue_sec"] <= target_sec)
    return {
        "dates": shared,
        "daily": daily.reset_index(),
        "daily_accuracy_pct": float(100 - daily["error_pct"].abs().mean()),
        "week_predicted": float(daily["predicted_calls"].sum()),
        "week_actual": int(daily["actual_calls"].sum()),
        "week_error_pct": float((daily["predicted_calls"].sum() - daily["actual_calls"].sum()) / daily["actual_calls"].sum() * 100),
        "hourly_mae": float(np.mean(np.abs(hourly["predicted_calls"] - hourly["actual_calls"]))),
        "aht_actual_sec": float(answered["agent_sec"].mean()) if len(answered) else None,
        "aht_predicted_sec": _weighted(snap, "aht_sec"),
        "abandon_share_actual": float(calls["abandoned"].mean()),
        "abandon_share_predicted_at_roster": _weighted(snap, "abandon_share_at_roster"),
        "service_level_actual": float(in_target.mean()),
        "service_level_predicted_at_roster": _weighted(snap, "sl_at_roster"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Score a frozen forecast against actuals.")
    parser.add_argument("snapshot", type=Path, help="db.snapshot CSV")
    parser.add_argument("actuals", type=Path, help="partner call-records Excel")
    parser.add_argument("--target-sec", type=float, default=DEFAULT_TARGET_SEC)
    args = parser.parse_args()
    for path in (args.snapshot, args.actuals):
        if not path.exists():
            sys.exit(f"file not found: {path}")

    calls = parse_call_records(pd.read_excel(args.actuals))
    result = score_week(calls, pd.read_csv(args.snapshot), args.target_sec)
    print(result["daily"].round(1).to_string(index=False))
    print(f"\ndaily accuracy        {result['daily_accuracy_pct']:.1f}%")
    print(f"week total            predicted {result['week_predicted']:.0f} vs actual {result['week_actual']} "
          f"({result['week_error_pct']:+.1f}%)")
    print(f"hourly MAE            {result['hourly_mae']:.2f} calls")
    print(f"handle time           predicted {result['aht_predicted_sec']:.0f} s vs actual {result['aht_actual_sec']:.0f} s")
    print(f"abandoned             predicted {result['abandon_share_predicted_at_roster']:.1%} vs actual {result['abandon_share_actual']:.1%}")
    print(f"answered in {args.target_sec:g} s     predicted {result['service_level_predicted_at_roster']:.1%} vs actual {result['service_level_actual']:.1%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())


# This module compares a frozen forecast CSV with validated call records on
# their shared dates. It reports daily-total accuracy and bias, hourly call
# MAE, actual and predicted AHT, abandonment, and service level at the roster
# recorded in the snapshot; pure scoring logic is separate from CLI file I/O.
#
# It joins db.snapshot's pre-outcome predictions to db.load_week's normalized
# actual calls, producing a reproducible evaluation after the forecast window.
# Those metrics let the project assess volume accuracy and the operational
# quality of staffing outcomes without retraining against the same test data.
