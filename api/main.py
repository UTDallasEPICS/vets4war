"""FastAPI surface for the Vets4Warriors staffing forecast.

    GET /api/forecast?start=&end=&efficiency=&target_pct=&target_sec=
        one row per hour (the full Erlang chain + expected talk time), the
        per-date shift roll-up, and a window summary (calls, talk time, caveat)
    GET /api/staffing?start=&end=&efficiency=&target_pct=&target_sec=
        daily + shift roll-up only
    efficiency 0..1 (0 makes people-to-schedule undefined: nulls + reason);
    target_sec = answer-time threshold in seconds, default 30;
    queue_model = erlang_a (default; callers hang up, abandonment reported)
                  or erlang_c (infinite patience, abandon_share is null);
    patience_sec = mean caller patience override; default is the estimate
                   from the calls table (params.patience_source says which).
    GET /api/model                                          models/metadata.json
    GET /                                                   web/index.html (static)

Every request opens its own database connection from $V4W_DATABASE_URL and
runs the same db.staffing code the CLI uses. No numbers are computed here.

Run from the repo root:  uvicorn api.main:app --reload
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

load_dotenv()

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

from db.features import SATURDAY_ISODOW, load_holidays  # noqa: E402
from db.forecast import holiday_coverage  # noqa: E402
from db.patience import cached_patience  # noqa: E402
from db.staffing import (  # noqa: E402
    DEFAULT_EFFICIENCY,
    DEFAULT_QUEUE_MODEL,
    DEFAULT_TARGET_PCT,
    DEFAULT_TARGET_SEC,
    SHIFT_ORDER,
    resolve_patience,
    rollup_shifts,
    staff_for_range,
)
from db.train import METADATA_PATH  # noqa: E402

log = logging.getLogger("v4w.api")

DEFAULT_HORIZON_DAYS = 30
MAX_RANGE_DAYS = 366
MAX_TARGET_SEC = 3600
MAX_PATIENCE_SEC = 86400
QUEUE_MODEL_PATTERN = "^(erlang_a|erlang_c)$"
SECONDS_PER_HOUR = 3600
SECONDS_PER_MINUTE = 60
MINUTES_PER_HOUR = 60

TALK_TIME_CAVEAT = (
    "Expected talk time is inbound talk time on forecast calls only: predicted calls "
    "times the average handle time for that weekday and hour. It excludes outbound "
    "follow-up and after-call work. Handle times are recency-weighted means of "
    "answered inbound calls in the calls table, excluding calls recorded with zero "
    "agent time."
)
REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = REPO_ROOT / "web"

app = FastAPI(title="Vets4Warriors staffing forecast", version="0.1.0")


# =============================================================================
# Helpers
# =============================================================================

def _default_range() -> tuple[date, date]:
    start = date.today()
    return start, start + timedelta(days=DEFAULT_HORIZON_DAYS - 1)


def _validate_range(start: date | None, end: date | None) -> tuple[date, date]:
    default_start, default_end = _default_range()
    start = start or default_start
    end = end or default_end
    if end < start:
        raise HTTPException(400, f"end {end} is before start {start}")
    span = (end - start).days + 1
    if span > MAX_RANGE_DAYS:
        raise HTTPException(400, f"range is {span} days; maximum is {MAX_RANGE_DAYS}")
    return start, end


def _connection():
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        raise HTTPException(503, "V4W_DATABASE_URL is not set")
    try:
        return psycopg.connect(dsn)
    except psycopg.Error as exc:
        log.exception("database connection failed")
        raise HTTPException(503, f"database connection failed: {exc}") from exc


def _queue_params(conn, queue_model: str, patience_sec: float | None) -> dict:
    """What the run actually used: the model, the patience in seconds, and
    where that patience came from (the data estimate, or the override)."""
    resolved = resolve_patience(conn, queue_model, patience_sec)
    if queue_model == "erlang_c":
        source = None
    elif patience_sec is None:
        estimate = cached_patience(conn)
        source = {"kind": "estimated", "n_abandoned": estimate["n_abandoned"], "n_calls": estimate["n_calls"]}
    else:
        source = {"kind": "override"}
    return {"queue_model": queue_model, "patience_sec": resolved, "patience_source": source}


def _hourly_staffing(start: date, end: date, efficiency: float, target_pct: float,
                     target_sec: float, queue_model: str, patience_sec: float | None,
                     ) -> tuple[pd.DataFrame, dict, pd.DataFrame, dict]:
    """Hourly staffing frame, holiday-coverage status, the holidays table,
    and the queue-model parameters actually used.

    staff_for_range -> forecast_range builds the whole hourly grid once and
    runs the shared build_features on it once with the trained epoch. This
    is the only feature path; nothing here recomputes features."""
    try:
        with _connection() as conn:
            queue = _queue_params(conn, queue_model, patience_sec)
            hourly = staff_for_range(conn, start, end, efficiency, target_pct, target_sec,
                                     queue_model, queue["patience_sec"])
            holidays = load_holidays(conn)
            return hourly, holiday_coverage(holidays, end), holidays, queue
    except FileNotFoundError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except psycopg.Error as exc:
        log.exception("query failed")
        raise HTTPException(500, f"query failed: {exc}") from exc


def format_duration(seconds: float) -> str:
    """152280 -> '42h 18m'; under an hour -> '18m'. Minutes round half up."""
    minutes = int(seconds / SECONDS_PER_MINUTE + 0.5)
    hours, minutes = divmod(minutes, MINUTES_PER_HOUR)
    return f"{hours}h {minutes}m" if hours else f"{minutes}m"


def _talk_seconds(load_erlangs) -> float:
    """expected_talk_sec = predicted_calls * aht_sec, which is load * 3600 by definition."""
    return float(load_erlangs) * SECONDS_PER_HOUR


def _opt(value, cast):
    """None for NaN/None (undefined at efficiency 0), else cast(value)."""
    return None if value is None or pd.isna(value) else cast(value)


def _hour_rows(hourly: pd.DataFrame) -> list[dict]:
    """One JSON row per hour with every link of the chain, unrounded, so a
    reader can recompute each number from the previous one. Scheduling
    fields are null at efficiency 0, with `reason` saying why."""
    return [
        {
            "date": row.hour_start.strftime("%Y-%m-%d"),
            "hour": int(row.hour_start.hour),
            "predicted_calls": float(row.predicted_offered),
            "aht_sec": float(row.predicted_aht_sec),
            "load_erlangs": float(row.offered_load_erlangs),
            "agents_required": int(row.agents_required),
            "staff_to_schedule": _opt(row.scheduled_needed, int),
            "effective_agents": _opt(row.effective_agents, int),
            "service_level_delivered": _opt(row.service_level_at_scheduled, float),
            "over_cap": _opt(row.capped, bool),
            "implausible": bool(row.implausible),
            "reason": _opt(row.reason, str),
            "expected_talk_sec": _talk_seconds(row.offered_load_erlangs),
            "expected_talk": format_duration(_talk_seconds(row.offered_load_erlangs)),
            "abandon_share": _opt(row.abandon_share, float),
        }
        for row in hourly.itertuples(index=False)
    ]


def _talk_by_date(hourly: pd.DataFrame) -> dict[str, float]:
    per_day = hourly.groupby(hourly["hour_start"].dt.normalize())["offered_load_erlangs"].sum()
    return {day.strftime("%Y-%m-%d"): _talk_seconds(load) for day, load in per_day.items()}


def _window_summary(hourly: pd.DataFrame, start: date, end: date) -> dict:
    """Totals over the whole requested window, in seconds and as text, next to
    the call total they came from. Carries the caveat so the number never
    travels without it."""
    calls = float(hourly["predicted_offered"].sum())
    talk_sec = _talk_seconds(hourly["offered_load_erlangs"].sum())
    known = hourly["abandon_share"].notna()
    abandoned = float((hourly["predicted_offered"] * hourly["abandon_share"])[known].sum()) if known.any() else None
    return {
        "start": str(start),
        "end": str(end),
        "expected_calls": calls,
        "expected_talk_sec": talk_sec,
        "expected_talk": format_duration(talk_sec),
        "mean_aht_sec": talk_sec / calls if calls > 0 else None,
        "expected_abandoned_calls": abandoned,
        "abandon_share": (abandoned / calls) if abandoned is not None and calls > 0 else None,
        "caveat": TALK_TIME_CAVEAT,
    }


def _holiday_names(holidays: pd.DataFrame) -> dict[str, str]:
    if "holiday_name" not in holidays.columns:
        return {}
    return {
        pd.Timestamp(day).strftime("%Y-%m-%d"): str(name)
        for day, name in zip(holidays["holiday_date"], holidays["holiday_name"])
        if pd.notna(name)
    }


def _days_with_calendar(shifts: pd.DataFrame, holidays: pd.DataFrame,
                        talk_by_date: dict[str, float]) -> list[dict]:
    """The shift roll-up per date plus the calendar facts the matrix shows on
    the date cell (weekend, holiday name) and the day's expected talk time."""
    names = _holiday_names(holidays)
    return [
        {
            "date": day["date"],
            "is_weekend": date.fromisoformat(day["date"]).isoweekday() >= SATURDAY_ISODOW,
            "holiday": names.get(day["date"]),
            "predicted_calls": day["predicted_calls"],
            "expected_talk_sec": talk_by_date.get(day["date"], 0.0),
            "expected_talk": format_duration(talk_by_date.get(day["date"], 0.0)),
            "shifts": day["shifts"],
        }
        for day in _days_with_shifts(shifts)
    ]


def _days_with_shifts(shifts: pd.DataFrame) -> list[dict]:
    """One entry per date, shifts nested by name, plus the daily call total."""
    days = []
    for shift_date, group in shifts.groupby("shift_date", sort=True):
        by_name = {
            row.shift: {
                "predicted_calls": round(float(row.predicted_calls), 2),
                "agents_required": int(row.agents_required),
                "staff_needed": _opt(row.staff_needed, int),
                "capped": _opt(row.capped, bool),
                # Lowest delivered level of any hour in the shift when each
                # hour is staffed at its own requirement; staffing the whole
                # shift at its peak can only raise it.
                "service_level_delivered": _opt(row.service_level_delivered, float),
                # Worst hour in the shift. None under Erlang C.
                "abandon_share": _opt(row.abandon_share, float),
            }
            for row in group.itertuples(index=False)
        }
        days.append({
            "date": shift_date.strftime("%Y-%m-%d"),
            "predicted_calls": round(float(group["predicted_calls"].sum()), 2),
            "shifts": {name: by_name.get(name) for name in SHIFT_ORDER},
        })
    return days


# =============================================================================
# Routes
# =============================================================================

@app.get("/api/forecast")
def api_forecast(
    start: date | None = None,
    end: date | None = None,
    efficiency: float = Query(DEFAULT_EFFICIENCY, ge=0, le=1),
    target_pct: float = Query(DEFAULT_TARGET_PCT, gt=0, lt=1),
    target_sec: float = Query(DEFAULT_TARGET_SEC, ge=0, le=MAX_TARGET_SEC),
    queue_model: str = Query(DEFAULT_QUEUE_MODEL, pattern=QUEUE_MODEL_PATTERN),
    patience_sec: float | None = Query(None, gt=0, le=MAX_PATIENCE_SEC),
):
    start, end = _validate_range(start, end)
    hourly, coverage, holidays, queue = _hourly_staffing(
        start, end, efficiency, target_pct, target_sec, queue_model, patience_sec)
    return {
        "params": {"start": str(start), "end": str(end), "efficiency": efficiency,
                   "target_pct": target_pct, "target_sec": target_sec, **queue},
        "holiday_coverage": coverage,
        "hours": _hour_rows(hourly),
        "days": _days_with_calendar(rollup_shifts(hourly), holidays, _talk_by_date(hourly)),
        "window": _window_summary(hourly, start, end),
    }


@app.get("/api/staffing")
def api_staffing(
    start: date | None = None,
    end: date | None = None,
    efficiency: float = Query(DEFAULT_EFFICIENCY, ge=0, le=1),
    target_pct: float = Query(DEFAULT_TARGET_PCT, gt=0, lt=1),
    target_sec: float = Query(DEFAULT_TARGET_SEC, ge=0, le=MAX_TARGET_SEC),
    queue_model: str = Query(DEFAULT_QUEUE_MODEL, pattern=QUEUE_MODEL_PATTERN),
    patience_sec: float | None = Query(None, gt=0, le=MAX_PATIENCE_SEC),
):
    start, end = _validate_range(start, end)
    hourly, coverage, _, queue = _hourly_staffing(
        start, end, efficiency, target_pct, target_sec, queue_model, patience_sec)
    shifts = rollup_shifts(hourly)
    return {
        "params": {"start": str(start), "end": str(end), "efficiency": efficiency,
                   "target_pct": target_pct, "target_sec": target_sec, **queue},
        "holiday_coverage": coverage,
        "days": _days_with_shifts(shifts),
    }


@app.get("/api/model")
def api_model():
    if not METADATA_PATH.exists():
        raise HTTPException(404, f"{METADATA_PATH} not found; run `make train`")
    try:
        return json.loads(METADATA_PATH.read_text())
    except json.JSONDecodeError as exc:
        raise HTTPException(500, f"{METADATA_PATH} is not valid JSON: {exc}") from exc


# Static site last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
