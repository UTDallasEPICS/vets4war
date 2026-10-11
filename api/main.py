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
    recency = equal | weighted (default) | recent: handle-time weighting
                   (db.aht.RECENCY_HALFLIFE_DAYS); window.recency_effect_pct says
                   how much it moves expected talk time vs equal weighting.
    include_holidays = false predicts every day as an ordinary weekday.
    POST /api/planned                                       the supervisor's roster
        body: the same params plus planned: [{date, shift, planned}]; returns
        the recommendation, the verdict (under / on target / over / exceeds
        capacity) and the Erlang service level at the PLANNED number.
    GET /api/model                                          models/metadata.json
    GET /                                                   web/index.html (static)

    Every response carries data_source: which data (partner / synthetic,
    from $V4W_DATA_SOURCE) and its date range, so the page can say so.

Every request opens its own database connection from $V4W_DATABASE_URL and
runs the same db.staffing code the CLI uses. No numbers are computed here.

Run from the repo root:  uvicorn api.main:app --reload
"""

from __future__ import annotations

import json
import math
import logging
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

from db.aht import DEFAULT_RECENCY, RECENCY_OPTIONS  # noqa: E402
from db.features import SATURDAY_ISODOW, load_holidays  # noqa: E402
from db.forecast import aht_table, holiday_coverage  # noqa: E402
from db.patience import cached_patience  # noqa: E402
from db.source import describe_source  # noqa: E402
from db.staffing import (  # noqa: E402
    DEFAULT_EFFICIENCY,
    DEFAULT_QUEUE_MODEL,
    DEFAULT_TARGET_PCT,
    DEFAULT_TARGET_SEC,
    SHIFT_ORDER,
    abandon_share_at,
    planned_outcome,
    resolve_patience,
    rollup_shifts,
    shift_memberships,
    staff_for_range,
    verdict,
)
from db.train import METADATA_PATH  # noqa: E402

log = logging.getLogger("v4w.api")

DEFAULT_HORIZON_DAYS = 30
MAX_RANGE_DAYS = 366
MAX_TARGET_SEC = 3600
MAX_PATIENCE_SEC = 86400
QUEUE_MODEL_PATTERN = "^(erlang_a|erlang_c)$"
RECENCY_PATTERN = "^(" + "|".join(RECENCY_OPTIONS) + ")$"
MAX_PLANNED = 1000
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


def _equal_weight_talk_sec(conn, start: date, end: date, recency: str, include_holidays: bool,
                           hourly: pd.DataFrame) -> float:
    """Expected talk time over the window under EQUAL handle-time weighting,
    the reference the recency control is compared against. Volume does not
    depend on recency, so the forecast is not rerun: the same predicted
    calls are multiplied by the equal-weight AHT for each weekday and hour."""
    if recency == "equal":
        return _talk_seconds(hourly["offered_load_erlangs"].sum())
    equal = aht_table(conn, "equal")
    dow = hourly["hour_start"].dt.isocalendar().day.astype(int)
    hour = hourly["hour_start"].dt.hour
    aht = [equal[(int(d), int(h))] for d, h in zip(dow, hour)]
    return float((hourly["predicted_offered"].to_numpy() * aht).sum())


def _hourly_staffing(start: date, end: date, efficiency: float, target_pct: float,
                     target_sec: float, queue_model: str, patience_sec: float | None,
                     recency: str = DEFAULT_RECENCY, include_holidays: bool = True) -> dict:
    """Everything one request needs, computed on one connection:
    hourly (staffing frame), coverage, holidays, queue (params used),
    source (data-source badge), equal_talk_sec (recency reference).

    staff_for_range -> forecast_range builds the whole hourly grid once and
    runs the shared build_features on it once with the trained epoch. This
    is the only feature path; nothing here recomputes features."""
    try:
        with _connection() as conn:
            queue = _queue_params(conn, queue_model, patience_sec)
            hourly = staff_for_range(conn, start, end, efficiency, target_pct, target_sec,
                                     queue_model, queue["patience_sec"], recency, include_holidays)
            holidays = load_holidays(conn)
            return {
                "hourly": hourly,
                "coverage": holiday_coverage(holidays, end),
                "holidays": holidays,
                "queue": queue,
                "source": describe_source(conn),
                "equal_talk_sec": _equal_weight_talk_sec(conn, start, end, recency, include_holidays, hourly),
            }
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


def _abandoned_one_fewer(hourly: pd.DataFrame, efficiency: float, target_sec: float,
                         patience_sec: float | None) -> float | None:
    """Expected abandoned calls if every hour scheduled ONE FEWER person than
    recommended. Same chain as staff_for_hour, evaluated at scheduled - 1:
    effective = floor((scheduled - 1) * efficiency). This is what the slack
    buys. None under Erlang C (no abandonment) or at efficiency 0."""
    if patience_sec is None or efficiency == 0 or hourly["scheduled_needed"].isna().any():
        return None
    total = 0.0
    for row in hourly.itertuples(index=False):
        fewer = max(int(row.scheduled_needed) - 1, 0)
        effective = math.floor(fewer * efficiency)
        share = abandon_share_at(effective, row.offered_load_erlangs, row.predicted_aht_sec, target_sec, patience_sec)
        total += float(row.predicted_offered) * float(share)
    return total


def _window_summary(hourly: pd.DataFrame, start: date, end: date, efficiency: float,
                    target_sec: float, queue: dict, recency: str, equal_talk_sec: float) -> dict:
    """Totals over the whole requested window, in seconds and as text, next to
    the call total they came from. Carries the caveat so the number never
    travels without it."""
    calls = float(hourly["predicted_offered"].sum())
    talk_sec = _talk_seconds(hourly["offered_load_erlangs"].sum())
    known = hourly["abandon_share"].notna()
    abandoned = float((hourly["predicted_offered"] * hourly["abandon_share"])[known].sum()) if known.any() else None
    # recency_effect_pct: how far the chosen weighting moves expected talk
    # time from equal weighting. Volume is unaffected by recency, so this is
    # purely the handle-time effect.
    effect_pct = (talk_sec / equal_talk_sec - 1.0) * 100.0 if equal_talk_sec > 0 else 0.0
    return {
        "start": str(start),
        "end": str(end),
        "expected_calls": calls,
        "expected_talk_sec": talk_sec,
        "expected_talk": format_duration(talk_sec),
        "mean_aht_sec": talk_sec / calls if calls > 0 else None,
        "expected_abandoned_calls": abandoned,
        "abandon_share": (abandoned / calls) if abandoned is not None and calls > 0 else None,
        "expected_abandoned_one_fewer": _abandoned_one_fewer(hourly, efficiency, target_sec, queue["patience_sec"]),
        "recency": recency,
        "recency_effect_pct": effect_pct,
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

def _params(start: date, end: date, efficiency: float, target_pct: float, target_sec: float,
            queue: dict, recency: str, include_holidays: bool) -> dict:
    return {"start": str(start), "end": str(end), "efficiency": efficiency,
            "target_pct": target_pct, "target_sec": target_sec, **queue,
            "recency": recency, "include_holidays": include_holidays}


@app.get("/api/forecast")
def api_forecast(
    start: date | None = None,
    end: date | None = None,
    efficiency: float = Query(DEFAULT_EFFICIENCY, ge=0, le=1),
    target_pct: float = Query(DEFAULT_TARGET_PCT, gt=0, lt=1),
    target_sec: float = Query(DEFAULT_TARGET_SEC, ge=0, le=MAX_TARGET_SEC),
    queue_model: str = Query(DEFAULT_QUEUE_MODEL, pattern=QUEUE_MODEL_PATTERN),
    patience_sec: float | None = Query(None, gt=0, le=MAX_PATIENCE_SEC),
    recency: str = Query(DEFAULT_RECENCY, pattern=RECENCY_PATTERN),
    include_holidays: bool = True,
):
    start, end = _validate_range(start, end)
    run = _hourly_staffing(start, end, efficiency, target_pct, target_sec, queue_model, patience_sec,
                           recency, include_holidays)
    hourly = run["hourly"]
    return {
        "params": _params(start, end, efficiency, target_pct, target_sec, run["queue"], recency, include_holidays),
        "data_source": run["source"],
        "holiday_coverage": run["coverage"],
        "hours": _hour_rows(hourly),
        "days": _days_with_calendar(rollup_shifts(hourly), run["holidays"], _talk_by_date(hourly)),
        "window": _window_summary(hourly, start, end, efficiency, target_sec, run["queue"],
                                  recency, run["equal_talk_sec"]),
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
    recency: str = Query(DEFAULT_RECENCY, pattern=RECENCY_PATTERN),
    include_holidays: bool = True,
):
    start, end = _validate_range(start, end)
    run = _hourly_staffing(start, end, efficiency, target_pct, target_sec, queue_model, patience_sec,
                           recency, include_holidays)
    return {
        "params": _params(start, end, efficiency, target_pct, target_sec, run["queue"], recency, include_holidays),
        "data_source": run["source"],
        "holiday_coverage": run["coverage"],
        "days": _days_with_shifts(rollup_shifts(run["hourly"])),
    }


class PlannedShift(BaseModel):
    date: date
    shift: str = Field(pattern="^(" + "|".join(SHIFT_ORDER) + ")$")
    planned: int = Field(ge=0, le=MAX_PLANNED)


class PlannedRequest(BaseModel):
    start: date
    end: date
    efficiency: float = Field(DEFAULT_EFFICIENCY, ge=0, le=1)
    target_pct: float = Field(DEFAULT_TARGET_PCT, gt=0, lt=1)
    target_sec: float = Field(DEFAULT_TARGET_SEC, ge=0, le=MAX_TARGET_SEC)
    queue_model: str = Field(DEFAULT_QUEUE_MODEL, pattern=QUEUE_MODEL_PATTERN)
    patience_sec: float | None = Field(None, gt=0, le=MAX_PATIENCE_SEC)
    recency: str = Field(DEFAULT_RECENCY, pattern=RECENCY_PATTERN)
    include_holidays: bool = True
    planned: list[PlannedShift] = Field(max_length=MAX_RANGE_DAYS * len(SHIFT_ORDER))


@app.post("/api/planned")
def api_planned(body: PlannedRequest):
    """The supervisor's roster against the forecast: for each (date, shift)
    the recommendation, the verdict, and what the planned number delivers.
    Service level and abandonment at the planned staffing come from the same
    Erlang code as the recommendation; nothing is recomputed differently."""
    start, end = _validate_range(body.start, body.end)
    run = _hourly_staffing(start, end, body.efficiency, body.target_pct, body.target_sec,
                           body.queue_model, body.patience_sec, body.recency, body.include_holidays)
    hourly, queue = run["hourly"], run["queue"]
    recommended = rollup_shifts(hourly).set_index(["shift_date", "shift"])["staff_needed"]
    memberships = shift_memberships(hourly)
    if body.efficiency == 0:
        raise HTTPException(400, "efficiency is 0: people to schedule is undefined, so there is no roster to judge")

    results = []
    for item in body.planned:
        key = (pd.Timestamp(item.date), item.shift)
        if key not in recommended.index:
            raise HTTPException(400, f"{item.date} {item.shift} is not inside the forecast window")
        shift_hours = memberships[(memberships["shift_date"] == key[0]) & (memberships["shift"] == item.shift)]
        rec = int(recommended[key])
        outcome = planned_outcome(shift_hours, item.planned, body.efficiency, body.target_sec, queue["patience_sec"])
        results.append({
            "date": str(item.date),
            "shift": item.shift,
            "planned": item.planned,
            "recommended": rec,
            "delta": item.planned - rec,
            "verdict": verdict(item.planned, rec),
            **outcome,
        })
    return {
        "params": _params(start, end, body.efficiency, body.target_pct, body.target_sec, queue,
                          body.recency, body.include_holidays),
        "data_source": run["source"],
        "shifts": results,
    }


@app.get("/api/model")
def api_model():
    if not METADATA_PATH.exists():
        raise HTTPException(404, f"{METADATA_PATH} not found; run `make train`")
    try:
        metadata = json.loads(METADATA_PATH.read_text())
    except json.JSONDecodeError as exc:
        raise HTTPException(500, f"{METADATA_PATH} is not valid JSON: {exc}") from exc
    try:
        with _connection() as conn:
            source = describe_source(conn)
    except (psycopg.Error, ValueError) as exc:
        log.exception("data source lookup failed")
        raise HTTPException(503, f"data source lookup failed: {exc}") from exc
    return {**metadata, "data_source": source}


# Static site last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
