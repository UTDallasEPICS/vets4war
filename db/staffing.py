"""Turn the hourly forecast into staffing numbers.

    staff_for_hour(predicted_offered, aht_sec, efficiency, target_pct, target_sec)
        -> dict: offered_load_erlangs, agents_required, scheduled_needed,
                 effective_agents, service_level_at_scheduled, capped,
                 implausible, reason, target_sec

    schedule_people(agents_required, efficiency)
        -> (scheduled, effective): ceil(agents / efficiency) and
           floor(scheduled * efficiency); (None, None) at efficiency 0

    staff_for_range(conn, start_date, end_date, efficiency, target_pct, target_sec)
        -> hourly DataFrame: forecast columns + the dict above per hour

    rollup_shifts(hourly)
        -> one row per (shift_date, shift): Day / Evening / Overnight

Shift staffing is the MAX of the hourly requirement inside the shift, not
the mean. You staff for the peak or you miss the SLA at the peak.

The client caps a shift at 7 people. `capped` flags any requirement above
that. It is surfaced, never clamped.

Efficiency runs 0..1. At exactly 0 nobody scheduled is ever on inbound, so
the people-to-schedule number is undefined: those fields are None and
`reason` says why. Above MAX_PLAUSIBLE_STAFF the number is still returned
but `implausible` is True, again with a reason.

Shifts overlap by 30 minutes (Day 08:00-16:30, Evening 16:00-00:30,
Overnight 00:00-08:30). For the staffing max, the boundary hour counts
toward both shifts. For predicted call totals, each hour counts once, in
the shift that starts it, so shift totals add up to the day total.
"""

from __future__ import annotations

import math

import pandas as pd

from db.erlang import erlang_a, erlang_c, required_agents
from db.forecast import forecast_range
from db.patience import cached_patience

DEFAULT_EFFICIENCY = 0.65
DEFAULT_TARGET_PCT = 0.80
DEFAULT_TARGET_SEC = 30
# erlang_a: callers hang up after Exp(patience) waiting, abandonment is
# reported. erlang_c: infinite patience, nobody hangs up (the original model).
QUEUE_MODELS = ("erlang_a", "erlang_c")
DEFAULT_QUEUE_MODEL = "erlang_a"
MAX_STAFF_PER_SHIFT = 7
# Above this many people in one hour the efficiency input, not the phones,
# is what needs fixing. The number is reported but flagged.
MAX_PLAUSIBLE_STAFF = 50
SECONDS_PER_HOUR = 3600

ZERO_EFFICIENCY_REASON = (
    "efficiency is 0: no scheduled person is ever free for inbound calls, "
    "so people to schedule is undefined"
)

# core_hours: hours whose start falls inside the shift (counted once).
# boundary_hour: the hour containing the 30-minute overlap at the shift's
# end; it joins the staffing max but not the call total.
# boundary_day_offset: Evening runs past midnight, so hour 0 of day D
# belongs to the Evening shift dated D-1.
SHIFTS = (
    {"shift": "Overnight", "core_hours": range(0, 8), "boundary_hour": 8, "boundary_day_offset": 0},
    {"shift": "Day", "core_hours": range(8, 16), "boundary_hour": 16, "boundary_day_offset": 0},
    {"shift": "Evening", "core_hours": range(16, 24), "boundary_hour": 0, "boundary_day_offset": -1},
)
SHIFT_ORDER = tuple(s["shift"] for s in SHIFTS)


# =============================================================================
# One hour
# =============================================================================

def _service_level(agents: int, load: float, aht_sec: float, target_sec: float,
                   patience_sec: float | None = None) -> float:
    """Share of all arriving calls answered within target_sec with `agents`
    on inbound. Erlang C when patience_sec is None, else Erlang A."""
    if agents <= 0:
        return 0.0
    if patience_sec is not None:
        return erlang_a(agents, load, aht_sec, patience_sec, target_sec)["service_level"]
    wait_prob = erlang_c(agents, load)
    return 1.0 - wait_prob * math.exp(-(agents - load) * target_sec / aht_sec)


def _abandon_share(agents: int, load: float, aht_sec: float, target_sec: float,
                   patience_sec: float | None) -> float | None:
    """Share of arriving callers who hang up before an agent answers.
    None under Erlang C, which assumes nobody ever hangs up."""
    if patience_sec is None:
        return None
    if agents <= 0:
        return 1.0 if load > 0 else 0.0
    return erlang_a(agents, load, aht_sec, patience_sec, target_sec)["abandon_prob"]


def schedule_people(agents_required: int, efficiency: float) -> tuple[int | None, int | None]:
    """People to schedule so that at least `agents_required` are on inbound
    after efficiency loss, and how many of them actually are.

        scheduled = ceil(agents_required / efficiency)
        effective = floor(scheduled * efficiency)

    Undefined (None, None) at efficiency 0: nobody is ever on inbound.
    """
    if not 0 <= efficiency <= 1:
        raise ValueError(f"efficiency must be in [0, 1], got {efficiency}")
    if efficiency == 0:
        return None, None
    scheduled = math.ceil(agents_required / efficiency)
    return scheduled, math.floor(scheduled * efficiency)


def _implausible_reason(scheduled: int) -> str | None:
    if scheduled <= MAX_PLAUSIBLE_STAFF:
        return None
    return (f"{scheduled} people in one hour exceeds the plausible bound of "
            f"{MAX_PLAUSIBLE_STAFF} for this line; the efficiency input is not actionable")


def staff_for_hour(
    predicted_offered: float,
    aht_sec: float,
    efficiency: float = DEFAULT_EFFICIENCY,
    target_pct: float = DEFAULT_TARGET_PCT,
    target_sec: float = DEFAULT_TARGET_SEC,
    patience_sec: float | None = None,
) -> dict:
    """Agents needed on inbound, people to schedule to get that many after
    efficiency loss, the service level those scheduled people deliver
    within `target_sec` seconds, and (Erlang A) the share of callers who
    hang up. patience_sec None = Erlang C."""
    if not 0 <= efficiency <= 1:
        raise ValueError(f"efficiency must be in [0, 1], got {efficiency}")
    if predicted_offered < 0:
        raise ValueError(f"predicted_offered must be >= 0, got {predicted_offered}")

    load = predicted_offered * aht_sec / SECONDS_PER_HOUR
    agents = required_agents(predicted_offered, aht_sec, target_pct, target_sec, patience_sec)
    scheduled, effective_agents = schedule_people(agents, efficiency)
    queue_model = "erlang_c" if patience_sec is None else "erlang_a"

    if scheduled is None:
        return {
            "offered_load_erlangs": load,
            "agents_required": agents,
            "scheduled_needed": None,
            "effective_agents": None,
            "service_level_at_scheduled": None,
            "capped": None,
            "implausible": False,
            "reason": ZERO_EFFICIENCY_REASON,
            "target_sec": target_sec,
            "abandon_share": None,
            "queue_model": queue_model,
            "patience_sec": patience_sec,
        }

    reason = _implausible_reason(scheduled)
    return {
        "offered_load_erlangs": load,
        "agents_required": agents,
        "scheduled_needed": scheduled,
        "effective_agents": effective_agents,
        "service_level_at_scheduled": _service_level(effective_agents, load, aht_sec, target_sec, patience_sec),
        "capped": scheduled > MAX_STAFF_PER_SHIFT,
        "implausible": reason is not None,
        "reason": reason,
        "target_sec": target_sec,
        "abandon_share": _abandon_share(effective_agents, load, aht_sec, target_sec, patience_sec),
        "queue_model": queue_model,
        "patience_sec": patience_sec,
    }


# =============================================================================
# A range of hours
# =============================================================================

def staff_for_range(
    conn,
    start_date,
    end_date,
    efficiency: float = DEFAULT_EFFICIENCY,
    target_pct: float = DEFAULT_TARGET_PCT,
    target_sec: float = DEFAULT_TARGET_SEC,
    queue_model: str = DEFAULT_QUEUE_MODEL,
    patience_sec: float | None = None,
) -> pd.DataFrame:
    """Forecast every hour in the range and attach staffing numbers.

    queue_model erlang_a uses `patience_sec`, or the estimate from the calls
    table when it is None. queue_model erlang_c ignores patience."""
    if queue_model not in QUEUE_MODELS:
        raise ValueError(f"queue_model must be one of {QUEUE_MODELS}, got {queue_model!r}")
    patience = resolve_patience(conn, queue_model, patience_sec)
    forecast = forecast_range(conn, start_date, end_date)
    staffing = pd.DataFrame([
        staff_for_hour(row.predicted_offered, row.predicted_aht_sec,
                       efficiency, target_pct, target_sec, patience)
        for row in forecast.itertuples(index=False)
    ])
    return pd.concat([forecast, staffing], axis=1)


def resolve_patience(conn, queue_model: str, patience_sec: float | None) -> float | None:
    """The patience the run will use: None for Erlang C, the caller's
    override, or the data estimate."""
    if queue_model == "erlang_c":
        return None
    if patience_sec is not None:
        if patience_sec <= 0:
            raise ValueError(f"patience_sec must be > 0, got {patience_sec}")
        return patience_sec
    return cached_patience(conn)["patience_sec"]


# =============================================================================
# Shift roll-up
# =============================================================================

def _shift_memberships(hourly: pd.DataFrame) -> pd.DataFrame:
    """Long frame: one row per (hour, shift it belongs to), with is_core."""
    day = hourly["hour_start"].dt.normalize()
    hour = hourly["hour_start"].dt.hour
    pieces = []
    for spec in SHIFTS:
        core_mask = hour.isin(spec["core_hours"])
        core = hourly[core_mask].assign(
            shift=spec["shift"], shift_date=day[core_mask], is_core=True,
        )
        boundary_mask = hour == spec["boundary_hour"]
        boundary = hourly[boundary_mask].assign(
            shift=spec["shift"],
            shift_date=day[boundary_mask] + pd.Timedelta(days=spec["boundary_day_offset"]),
            is_core=False,
        )
        pieces.extend([core, boundary])
    return pd.concat(pieces, ignore_index=True)


def rollup_shifts(hourly: pd.DataFrame) -> pd.DataFrame:
    """One row per (shift_date, shift). Staffing = max over the shift's
    hours including the overlap hour; calls = sum over core hours only.
    Shifts with no core hours in the range (edge of the window) are dropped."""
    long = _shift_memberships(hourly)
    long["core_calls"] = long["predicted_offered"].where(long["is_core"], 0.0)

    grouped = long.groupby(["shift_date", "shift"]).agg(
        predicted_calls=("core_calls", "sum"),
        agents_required=("agents_required", "max"),
        staff_needed=("scheduled_needed", "max"),
        service_level_delivered=("service_level_at_scheduled", "min"),
        abandon_share=("abandon_share", "max"),
        core_hours=("is_core", "sum"),
    ).reset_index()

    complete = grouped[grouped["core_hours"] > 0].drop(columns="core_hours")
    # staff_needed is NaN when efficiency is 0 (undefined); capped follows it.
    complete = complete.assign(
        capped=(complete["staff_needed"] > MAX_STAFF_PER_SHIFT).where(complete["staff_needed"].notna(), None)
    )
    complete["shift"] = pd.Categorical(complete["shift"], categories=SHIFT_ORDER, ordered=True)
    return complete.sort_values(["shift_date", "shift"]).reset_index(drop=True)
