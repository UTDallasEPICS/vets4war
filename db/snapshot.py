"""Freeze a forecast to a timestamped CSV BEFORE the actuals exist.

    python -m db.snapshot --start 2026-10-21 --end 2026-10-27
        [--roster 4,4,6] [--efficiency 0.65625] [--target-pct 0.80] [--target-sec 30]

Writes forecasts/forecast_<start>_to_<end>_<UTC stamp>.csv, one row per hour:

    date, hour, shift, predicted_calls, aht_sec, staff_recommended,
    roster_staff, sl_at_roster, abandon_share_at_roster, model_label

`staff_recommended` is what the model recommends; `roster_staff` is the
partner's real roster (default 4/4/6, Oct 14-20 2026 file) and the two
*_at_roster columns are what the model expects THAT roster to deliver, the
numbers comparable with the partner's reported service level and
abandonment. db.score_week scores this file against the actual Excel.

The file is never overwritten (new timestamp each run), so the frozen
forecast can be shown to predate the actual numbers.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

import pandas as pd
import psycopg
from dotenv import load_dotenv

from db.staffing import (
    DEFAULT_EFFICIENCY,
    DEFAULT_TARGET_PCT,
    DEFAULT_TARGET_SEC,
    SHIFTS,
    SHIFT_ORDER,
    abandon_share_at,
    resolve_patience,
    service_level_at,
    staff_for_range,
)
from db.train import METADATA_PATH, REPO_ROOT

load_dotenv()

FORECAST_DIR = REPO_ROOT / "forecasts"
# What the partner staffed Oct 14-20 2026 (validation file, Staff By Shift).
DEFAULT_ROSTER = "4,4,6"


def core_shift(hour: int) -> str:
    for spec in SHIFTS:
        if hour in spec["core_hours"]:
            return spec["shift"]
    raise ValueError(f"hour must be 0..23, got {hour}")


def parse_roster(text: str) -> dict[str, int]:
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != len(SHIFT_ORDER) or not all(p.isdigit() for p in parts):
        raise ValueError(f"roster must be {len(SHIFT_ORDER)} whole numbers for {'/'.join(SHIFT_ORDER)}, got {text!r}")
    return dict(zip(SHIFT_ORDER, (int(p) for p in parts)))


def at_roster(hourly: pd.DataFrame, roster: dict[str, int], efficiency: float,
              target_sec: float, patience_sec: float | None) -> pd.DataFrame:
    """Hourly frame -> NEW frame with the roster number and what it delivers."""
    shifts = hourly["hour_start"].dt.hour.map(core_shift)
    staff = shifts.map(roster)
    effective = [math.floor(n * efficiency) for n in staff]
    loads, ahts = hourly["offered_load_erlangs"], hourly["predicted_aht_sec"]
    return pd.DataFrame({
        "date": hourly["hour_start"].dt.strftime("%Y-%m-%d"),
        "hour": hourly["hour_start"].dt.hour,
        "shift": shifts,
        "predicted_calls": hourly["predicted_offered"],
        "aht_sec": ahts,
        "staff_recommended": hourly["scheduled_needed"],
        "roster_staff": staff,
        "sl_at_roster": [service_level_at(e, l, a, target_sec, patience_sec) for e, l, a in zip(effective, loads, ahts)],
        "abandon_share_at_roster": [abandon_share_at(e, l, a, target_sec, patience_sec) for e, l, a in zip(effective, loads, ahts)],
    })


def model_label() -> str:
    meta = json.loads(METADATA_PATH.read_text())
    config = meta.get("config", {}).get("label", "2026-10-11 model (no config)")
    return f"{config}; trained {meta['created_at_utc']}; data to {meta['train_end'][:10]}; level x{meta.get('level_factor', 1.0):.4f}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Freeze a forecast to CSV.")
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--roster", default=DEFAULT_ROSTER, help="Overnight,Day,Evening (default 4,4,6)")
    parser.add_argument("--efficiency", type=float, default=DEFAULT_EFFICIENCY)
    parser.add_argument("--target-pct", type=float, default=DEFAULT_TARGET_PCT)
    parser.add_argument("--target-sec", type=float, default=DEFAULT_TARGET_SEC)
    args = parser.parse_args()

    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")
    roster = parse_roster(args.roster)
    with psycopg.connect(dsn) as conn:
        patience = resolve_patience(conn, "erlang_a", None)
        hourly = staff_for_range(conn, args.start, args.end, args.efficiency, args.target_pct,
                                 args.target_sec, "erlang_a", patience)
    frame = at_roster(hourly, roster, args.efficiency, args.target_sec, patience).assign(model_label=model_label())

    FORECAST_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = FORECAST_DIR / f"forecast_{args.start}_to_{args.end}_{stamp}.csv"
    frame.to_csv(path, index=False)

    daily = frame.groupby("date")["predicted_calls"].sum().round(1)
    calls = frame["predicted_calls"].sum()
    print(daily.to_string())
    print(f"week: {calls:.0f} calls; at roster {args.roster}: "
          f"{(frame['predicted_calls'] * frame['sl_at_roster']).sum() / calls:.1%} answered within {args.target_sec:g} s, "
          f"{(frame['predicted_calls'] * frame['abandon_share_at_roster']).sum() / calls:.1%} hang up")
    print(f"saved {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
