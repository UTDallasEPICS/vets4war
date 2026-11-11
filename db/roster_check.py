"""Per-shift check of the queue model against what the partner's roster did.

    python -m db.roster_check "data/client/<actuals>.xlsx" ["<more>.xlsx" ...]
        [--roster 4,4,6] [--efficiency 0.65625]

For each workbook: the calls it holds are split by shift (Overnight 00-08,
Day 08-16, Evening 16-24, the same core hours as the rest of the tool) and,
per shift and for the whole file, three things are set side by side:

    answered within 30 s   actual share of ALL calls  vs  the model at the roster
    hung up                actual share of ALL calls  vs  the model at the roster
    handle time            mean talk time of answered calls with talk time > 0
                           vs the model's call-weighted handle time

"The model at the roster" is db.snapshot.at_roster on the model's own
hourly forecast for the workbook's dates: floor(roster * efficiency) people
on inbound, Erlang A with the patience estimated from the calls table. This
is exactly what the page shows for "your roster".

Why the forecast and not the actual hourly counts as the call load: the
queue formulas take an arrival RATE. One hour's actual count is a noisy
draw around that rate, and feeding the draws in makes busy hours look
busier than they were (it read about 8 points too low on the three
Oct 14 - Nov 3 2026 weeks).

READ THE RESULT WITH THIS IN MIND: if the model in models/ was trained on
the weeks being checked, the call volumes are not a blind forecast. That is
fine here; this check is about the queue arithmetic, not volume accuracy
(db.score_week on a frozen db.snapshot CSV measures that).

Nothing is written: the database session is read-only and no file is saved.
Pure function roster_check() does the arithmetic; main() only reads.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import zipfile
from pathlib import Path

import pandas as pd
import psycopg
from dotenv import load_dotenv

from db.client_files import read_call_records
from db.features import SERVICE_LEVEL_SEC
from db.snapshot import DEFAULT_ROSTER, at_roster, core_shift, parse_roster
from db.staffing import DEFAULT_EFFICIENCY, DEFAULT_TARGET_PCT, SHIFT_ORDER, resolve_patience, staff_for_range

ALL_SHIFTS = "All"
EXPECTED_COLUMNS = ("date", "shift", "predicted_calls", "aht_sec", "sl_at_roster", "abandon_share_at_roster")
POINTS_PER_UNIT = 100
DATE_FORMAT = "%Y-%m-%d"
# What can go wrong reading one workbook or forecasting its dates.
WORKBOOK_ERRORS = (ValueError, OSError, zipfile.BadZipFile, psycopg.Error)


def _actual(calls: pd.DataFrame) -> dict:
    """What really happened to one group of calls."""
    answered = ~calls["abandoned"]
    talked = calls.loc[answered & (calls["agent_sec"] > 0), "agent_sec"]
    return {
        "calls": len(calls),
        "answered_actual": float((answered & (calls["in_queue_sec"] <= SERVICE_LEVEL_SEC)).mean()),
        "abandon_actual": float(calls["abandoned"].mean()),
        "aht_actual_sec": float(talked.mean()) if len(talked) else math.nan,
    }


def _predicted(hours: pd.DataFrame) -> dict:
    """What the model expected for one group of forecast hours, each hour
    weighted by its predicted calls."""
    weight = hours["predicted_calls"]
    total = float(weight.sum())
    if total <= 0:
        raise ValueError("the forecast has no predicted calls for a shift being checked")
    return {
        "predicted_calls": total,
        "answered_predicted": float((weight * hours["sl_at_roster"]).sum() / total),
        "abandon_predicted": float((weight * hours["abandon_share_at_roster"]).sum() / total),
        "aht_predicted_sec": float((weight * hours["aht_sec"]).sum() / total),
    }


def _compare(shift: str, calls: pd.DataFrame, hours: pd.DataFrame) -> dict:
    if calls.empty:
        raise ValueError(f"no calls in the {shift} shift; cannot check it")
    actual, predicted = _actual(calls), _predicted(hours)
    return {
        "shift": shift,
        **actual,
        **predicted,
        "answered_gap_pts": (predicted["answered_predicted"] - actual["answered_actual"]) * POINTS_PER_UNIT,
        "abandon_gap_pts": (predicted["abandon_predicted"] - actual["abandon_actual"]) * POINTS_PER_UNIT,
    }


def roster_check(calls: pd.DataFrame, expected: pd.DataFrame) -> pd.DataFrame:
    """calls: db.client_files.read_call_records output. expected: the hourly
    frame from db.snapshot.at_roster for the same dates. Returns one row per
    shift in SHIFT_ORDER, then an "All" row. Gaps are predicted minus actual,
    in percentage points. Forecast hours on dates with no call in `calls`
    are left out, so both sides cover the same days. A shift's actual handle
    time is NaN when it has no answered call with talk time."""
    missing = [c for c in EXPECTED_COLUMNS if c not in expected.columns]
    if missing:
        raise ValueError(f"forecast frame is missing columns {missing}; expected db.snapshot.at_roster output")
    if calls.empty:
        raise ValueError("no calls to check")
    call_dates = set(calls["start_ts"].dt.strftime(DATE_FORMAT))
    expected = expected[expected["date"].astype(str).isin(call_dates)]
    call_shift = calls["start_ts"].dt.hour.map(core_shift)
    rows = [_compare(shift, calls[call_shift == shift], expected[expected["shift"] == shift])
            for shift in SHIFT_ORDER]
    return pd.DataFrame([*rows, _compare(ALL_SHIFTS, calls, expected)])


def _format(result: pd.DataFrame) -> str:
    lines = [f"{'shift':<10}{'calls':>6}{'model':>7}   answered in {SERVICE_LEVEL_SEC} s        hung up              handle time",
             f"{'':<10}{'':>6}{'':>7}   actual  model   gap    actual  model   gap    actual  model"]
    for row in result.itertuples(index=False):
        aht_actual = "   n/a" if pd.isna(row.aht_actual_sec) else f"{row.aht_actual_sec:5.0f}s"
        lines.append(
            f"{row.shift:<10}{row.calls:>6}{row.predicted_calls:>7.0f}   "
            f"{row.answered_actual:6.1%} {row.answered_predicted:6.1%} {row.answered_gap_pts:+5.1f}   "
            f"{row.abandon_actual:6.1%} {row.abandon_predicted:6.1%} {row.abandon_gap_pts:+5.1f}   "
            f"{aht_actual} {row.aht_predicted_sec:5.0f}s")
    return "\n".join(lines)


def check_workbook(conn, path: Path, roster: dict[str, int], efficiency: float, patience_sec: float) -> pd.DataFrame:
    """Read one workbook, forecast its dates, compare per shift."""
    calls = read_call_records(path)
    start, end = calls["start_ts"].min().date(), calls["start_ts"].max().date()
    hourly = staff_for_range(conn, str(start), str(end), efficiency, DEFAULT_TARGET_PCT,
                             SERVICE_LEVEL_SEC, "erlang_a", patience_sec)
    return roster_check(calls, at_roster(hourly, roster, efficiency, SERVICE_LEVEL_SEC, patience_sec))


def main() -> int:
    parser = argparse.ArgumentParser(description="Per-shift check of the queue model at the partner's roster.")
    parser.add_argument("actuals", type=Path, nargs="+", help="partner call-records Excel file(s)")
    parser.add_argument("--roster", default=DEFAULT_ROSTER, help="Overnight,Day,Evening (default 4,4,6)")
    parser.add_argument("--efficiency", type=float, default=DEFAULT_EFFICIENCY)
    args = parser.parse_args()
    for path in args.actuals:
        if not path.exists():
            sys.exit(f"file not found: {path}")
    load_dotenv()
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")
    if not 0 < args.efficiency <= 1:
        sys.exit(f"--efficiency must be above 0 and at most 1, got {args.efficiency}")
    try:
        roster = parse_roster(args.roster)
    except ValueError as error:
        sys.exit(str(error))
    try:
        with psycopg.connect(dsn) as conn:
            conn.read_only = True
            return _report(conn, args.actuals, args.roster, roster, args.efficiency)
    except psycopg.Error as error:
        sys.exit(f"database error: {error}")


def _report(conn, paths: list[Path], roster_text: str, roster: dict[str, int], efficiency: float) -> int:
    """Print one table per workbook. A workbook that cannot be checked is
    reported and the rest still run; the exit code is then 1."""
    patience = resolve_patience(conn, "erlang_a", None)
    print(f"roster {roster_text} (Overnight,Day,Evening), efficiency {efficiency:g}, "
          f"patience {patience:.0f} s; gap = model minus actual, in points")
    failed = 0
    for path in paths:
        print(f"\n{path.name}")
        try:
            print(_format(check_workbook(conn, path, roster, efficiency, patience)))
        except WORKBOOK_ERRORS as error:
            failed += 1
            print(f"could not be checked: {error}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
