"""Retrain the volume model and write the forecast into the web app's database.

    cd forecast && python -m db.retrain --db /abs/path/app.db [options]

      --run-id N               the forecast_runs row the web app created; without
                               it (a person at a shell) a row with trigger 'cli' is added
      --mode full|forecast-only    default full
      --workers N              gate worker processes ($V4W_GATE_WORKERS, else min(4, cpus))
      --gate-origins N         weekly origins of the accuracy check (default 26)
      --horizon-days N         forecast reach past max(today, last data day)
                               ($V4W_HORIZON_DAYS, else 800)
      --holidays-through YEAR  last year of official holidays kept in `holidays`
                               ($V4W_HOLIDAYS_THROUGH_YEAR, else the year after the horizon ends)
      --today YYYY-MM-DD       default: today in America/New_York
      --verify-reference       retrain on the calls up to the committed reference
                               model's last day and compare fingerprints; writes nothing

A full run reads every call and the data revision in one read transaction,
claims its run row, checks and extends the holidays table, backtests the
procedure against the seasonal naive baseline (the gate, db.train.gate),
fits the model when it passes, measures handle time, real-call share,
patience and quick hang-ups from the same calls, forecasts every hour from
the first data day to the horizon, and writes all of it (model, forecast,
derived numbers, run row) in ONE transaction (db.store.write_forecast). A
model that fails the gate is not used: the previous model keeps serving and
the rest is refreshed. forecast-only skips the gate and the fit and reuses
the serving model.

Exit codes (the run row says the same, and is the source of truth):
    0  succeeded   forecast written
    3  rejected    the new model did not beat the baseline
    2  failed      refused for a data reason; the message says what to do.
                   Also: a bad argument, or a --run-id that is not a queued
                   row (the row is left alone: it is not this run's)
    1  failed      unexpected error (the traceback goes to stderr)
    4  --verify-reference: the fingerprints differ

Stopping (db/lifetime.py): SIGTERM, SIGINT or SIGHUP kill the gate workers
at once, roll back any open write and end the process by that same signal,
so nothing of the run is left running. A run the web app started
(--run-id) also ends when the web app's process ends; the web app records
how such a run ended. A run started from a shell records `failed` itself.

The last line printed is `V4W_RESULT {...}` (run id, status, model id and
fingerprint). Nothing printed holds a call record: aggregates only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import traceback
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from db import lifetime, store
from db.add_holidays import official_holidays, rule_mismatches
from db.aht import RECENCY_HALFLIFE_DAYS, RECENCY_OPTIONS, aht_from_calls
from db.backtest import HORIZON_DAYS, weekly_origins
from db.client_files import HOURLY_COLUMNS, hourly_from_calls
from db.dataset import _database_source
from db.features import HOURS_PER_DAY
from db.forecast import forecast_frame, load_booster
from db.patience import patience_from_calls
from db.procedure import PRODUCTION, RECENT_DAYS
from db.quick_abandon import quick_hangups_from_calls
from db.real_calls import real_counts, real_share_table
from db.train import (
    GATE_ORIGINS,
    METADATA_PATH,
    _print_gate,
    build_metadata,
    featured_frame,
    fit_model,
    gate,
    recent_gaps,
)

EXIT_SUCCEEDED = 0
EXIT_UNEXPECTED = 1
EXIT_REFUSED = 2
EXIT_REJECTED = 3
EXIT_REFERENCE_DIFFERS = 4

FULL = "full"
FORECAST_ONLY = "forecast-only"
MODES = (FULL, FORECAST_ONLY)
DEFAULT_HORIZON_DAYS = 800
MAX_GATE_WORKERS = 4
EASTERN = ZoneInfo("America/New_York")
RESULT_PREFIX = "V4W_RESULT"
GATE_METRIC = "daily_mape_1_14"
DAYS_PER_WEEK = 7
MAX_MISMATCHES_SHOWN = 3


class Refusal(Exception):
    """A data reason not to run. The message is the sentence for the admin page."""


@dataclass(frozen=True)
class Settings:
    db: Path
    run_id: int | None
    mode: str
    workers: int
    gate_origins: int
    horizon_days: int
    holidays_through: int | None
    today: date


@dataclass(frozen=True)
class Outcome:
    status: str
    exit_code: int
    model_id: int | None
    model_sha256: str | None


# =============================================================================
# Command line
# =============================================================================

def _positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise ValueError(f"must be at least 1, got {value}")
    return value


def _env_positive_int(parser: argparse.ArgumentParser, name: str) -> int | None:
    text = os.environ.get(name, "").strip()
    if not text:
        return None
    try:
        return _positive_int(text)
    except ValueError as error:
        parser.error(f"${name}: {error}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m db.retrain",
                                     description="Retrain the volume model and write the forecast into the database.")
    parser.add_argument("--db", required=True, help="ABSOLUTE path of the web app's SQLite file")
    parser.add_argument("--run-id", type=_positive_int, default=None, help="the forecast_runs row to report into")
    parser.add_argument("--mode", choices=MODES, default=FULL)
    parser.add_argument("--workers", type=_positive_int, default=None)
    parser.add_argument("--gate-origins", type=_positive_int, default=GATE_ORIGINS)
    parser.add_argument("--horizon-days", type=_positive_int, default=None)
    parser.add_argument("--holidays-through", type=_positive_int, default=None)
    parser.add_argument("--today", type=date.fromisoformat, default=None)
    parser.add_argument("--verify-reference", action="store_true")
    return parser


def _settings(parser: argparse.ArgumentParser, args: argparse.Namespace) -> Settings:
    workers = args.workers or _env_positive_int(parser, "V4W_GATE_WORKERS") or min(MAX_GATE_WORKERS, os.cpu_count() or 1)
    horizon = args.horizon_days or _env_positive_int(parser, "V4W_HORIZON_DAYS") or DEFAULT_HORIZON_DAYS
    through = args.holidays_through or _env_positive_int(parser, "V4W_HOLIDAYS_THROUGH_YEAR")
    return Settings(db=Path(args.db), run_id=args.run_id, mode=args.mode, workers=workers,
                    gate_origins=args.gate_origins, horizon_days=horizon, holidays_through=through,
                    today=args.today or datetime.now(EASTERN).date())


# =============================================================================
# The steps of a run
# =============================================================================

def _day(timestamp: pd.Timestamp) -> str:
    return str(timestamp.date())


def _ensure_holidays(conn, calls: pd.DataFrame, through_year: int, refuse: str) -> pd.DataFrame:
    """Check every holidays row against the calendar rules, add the official
    holidays of the first data year through `through_year`, return the table."""
    problems = rule_mismatches(store.load_holidays(conn))
    if problems:
        shown = "; ".join(problems[:MAX_MISMATCHES_SHOWN])
        raise Refusal(f"{refuse}the holidays table has {len(problems)} row(s) that disagree with the calendar "
                      f"rules ({shown}). Correct or delete those rows, then run again.")
    first_year = int(calls["start_ts"].min().year)
    rows = [(day.strftime("%Y-%m-%d"), name)
            for year in range(first_year, through_year + 1)
            for day, name in official_holidays(year).itertuples(index=False)]
    added = store.insert_missing_holidays(conn, rows)
    holidays = store.load_holidays(conn)
    print(f"holidays: {len(holidays)} rows through {_day(holidays['holiday_date'].max())} ({added} added)")
    return holidays


def _check_gate_data(hourly: pd.DataFrame, featured: pd.DataFrame, n_origins: int) -> None:
    """Refuse when the gate cannot run: unreported days inside its span, or too little history."""
    span_days = n_origins * DAYS_PER_WEEK + HORIZON_DAYS + RECENT_DAYS
    gaps = recent_gaps(hourly, span_days)
    if len(gaps):
        raise Refusal(f"Cannot retrain: {len(gaps)} recent day(s) have no calls at all ({_day(gaps[0])} to "
                      f"{_day(gaps[-1])}): that is unreported data, and the backtest gate cannot run across it. "
                      f"Load those days from the admin page, then run again.")
    try:
        weekly_origins(pd.DatetimeIndex(featured["hour_start"].dt.normalize().unique()), n_origins)
    except ValueError as error:
        raise Refusal(f"Cannot retrain: there is not enough call history for the accuracy check ({error}). "
                      f"Load more history from the admin page, then run again.") from error


def _derived(calls: pd.DataFrame, refuse: str) -> tuple[list[tuple], dict, dict]:
    """forecast_cells rows, patience and quick hang-ups, all from `calls`."""
    try:
        counts = real_counts(calls)
        cells = []
        for recency in RECENCY_OPTIONS:
            halflife = RECENCY_HALFLIFE_DAYS[recency]
            aht = aht_from_calls(calls, halflife)
            share = real_share_table(counts, halflife)
            cells += [(recency, dow, hour, aht[(dow, hour)], share[(dow, hour)]) for dow, hour in sorted(aht)]
        return cells, patience_from_calls(calls), quick_hangups_from_calls(calls)
    except ValueError as error:
        raise Refusal(f"{refuse}{error}. Check the loaded call data.") from error


def _hour_rows(frame: pd.DataFrame) -> list[tuple]:
    return list(zip(frame["hour_start"].dt.strftime("%Y-%m-%d").tolist(), frame["hour_start"].dt.hour.tolist(),
                    frame["predicted"].tolist(), frame["predicted_no_holidays"].tolist()))


def _pct(value: float) -> str:
    return f"{value:.1f}%"


def _run(conn, settings: Settings, run_id: int, snapshot: store.Snapshot) -> Outcome:
    calls = snapshot.calls
    full = settings.mode == FULL
    refuse = "Cannot retrain: " if full else "Cannot refresh the forecast: "
    if calls.empty:
        raise Refusal(f"{refuse}there are no calls in the database. Load a call-records file from the admin page.")
    data_start, data_end = _day(calls["start_ts"].min()), _day(calls["start_ts"].max())
    horizon_end = max(settings.today, date.fromisoformat(data_end)) + timedelta(days=settings.horizon_days)
    through_year = settings.holidays_through or horizon_end.year + 1
    holidays = _ensure_holidays(conn, calls, through_year, refuse)

    new_model = None
    gate_result = None
    if full:
        hourly = hourly_from_calls(calls)[list(HOURLY_COLUMNS)]
        sources = (_database_source(hourly),)
        print(json.dumps(list(sources), indent=2))
        featured = featured_frame(hourly, holidays)
        print(f"grid rows {len(featured):,}  days {len(featured) // HOURS_PER_DAY:,}  "
              f"{featured['hour_start'].min().date()} to {featured['hour_start'].max().date()}")
        _check_gate_data(hourly, featured, settings.gate_origins)
        gate_result = gate(featured, holidays, PRODUCTION, settings.gate_origins, settings.workers)
        _print_gate(gate_result)
        if gate_result["passed"]:
            model = fit_model(featured, holidays, PRODUCTION)
            text = model.booster.model_to_string()
            metadata = {**build_metadata(model, PRODUCTION, sources, gate_result),
                        "model_sha256": hashlib.sha256(text.encode()).hexdigest()}
            new_model = {"model_sha256": metadata["model_sha256"], "model_text": text, "metadata_json": metadata,
                         "train_start": metadata["train_start"], "train_end": metadata["train_end"],
                         "train_rows": metadata["train_rows"]}
            print(f"\nlevel factor {model.factors.level:.4f}")
            print("hour-of-day factors:", " ".join(f"{value:.2f}" for value in model.factors.hour))

    if new_model is not None:
        model_text, metadata, model_id = new_model["model_text"], new_model["metadata_json"], None
    else:
        serving = store.serving_model(conn)
        scores = gate_result and (_pct(gate_result["model"][GATE_METRIC]), _pct(gate_result["naive"][GATE_METRIC]))
        if serving is None and full:
            message = (f"The first model did not beat the simple baseline on daily error ({scores[0]} against "
                       f"{scores[1]}). Nothing is being served yet.")
            store.finish_run(conn, run_id, status="rejected", message=message, trained=False, gate_passed=False,
                             gate_json=gate_result, forecast_written=False)
            print(f"\n{message}")
            return Outcome("rejected", EXIT_REJECTED, None, None)
        if serving is None:
            raise Refusal(f"{refuse}no model has been trained yet. Run a full retrain first.")
        model_text, metadata, model_id = serving.model_text, serving.metadata, serving.model_id

    cells, patience, quick = _derived(calls, refuse)
    frame = forecast_frame(load_booster(model_text, metadata), metadata, holidays, data_start, horizon_end)
    horizon = {"horizon_start": data_start, "horizon_end": str(horizon_end)}

    if new_model is not None:
        status, exit_code = "succeeded", EXIT_SUCCEEDED
        message = (f"Retrained on {len(calls):,} calls through {data_end}. The new model beat the simple "
                   f"baseline in the check and is now in use.")
    elif full:
        status, exit_code = "rejected", EXIT_REJECTED
        message = (f"The retrained model did not beat the simple baseline on daily error ({scores[0]} against "
                   f"{scores[1]}), so the previous model stays in use. Handle time, caller patience and the "
                   f"data range were refreshed.")
    else:
        status, exit_code = "succeeded", EXIT_SUCCEEDED
        message = f"Forecast refreshed from the model in use; data through {data_end}."

    run = {"status": status, "finished_at": store.now_seconds(), "trained": new_model is not None,
           "forecast_written": True, "message": message, **horizon}
    if full:
        run.update(gate_passed=bool(gate_result["passed"]), gate_json=gate_result)
    state = {"generated_at": store.now_seconds(), "calls_revision": snapshot.calls_revision,
             "calls_count": len(calls), "data_start": data_start, "data_end": data_end, **horizon,
             "patience_sec": patience["patience_sec"], "patience_n_abandoned": patience["n_abandoned"],
             "patience_n_calls": patience["n_calls"], "quick_hangups_json": quick}
    if model_id is not None:
        state["model_id"] = model_id
    served_id = store.write_forecast(conn, run_id=run_id, new_model=new_model, hours=_hour_rows(frame),
                                     cells=cells, state=state, run=run)
    print(f"\nforecast {len(frame):,} hours, {data_start} to {horizon_end}; model {served_id}. {message}")
    return Outcome(status, exit_code, served_id, metadata.get("model_sha256"))


# =============================================================================
# --verify-reference
# =============================================================================

def verify_reference(db_path: Path, metadata_path: Path = METADATA_PATH) -> int:
    """Train on the calls up to the reference model's last day and compare
    fingerprints. Reads only; writes nothing. Exit code: 0 same, 4 different,
    2 when the data ends before the reference's last day."""
    reference = json.loads(Path(metadata_path).read_text())
    last_day = pd.Timestamp(reference["train_end"]).normalize()
    conn = store.connect(db_path, readonly=True)
    try:
        calls = store.read_snapshot(conn).calls
        table = store.load_holidays(conn)
    finally:
        conn.close()
    if calls.empty or calls["start_ts"].max().normalize() < last_day:
        newest = "no calls" if calls.empty else f"calls end {_day(calls['start_ts'].max())}"
        print(f"Cannot verify: the reference model was trained through {last_day.date()}, but the database has "
              f"{newest}.", file=sys.stderr)
        return EXIT_REFUSED
    calls = calls[calls["start_ts"].dt.normalize() <= last_day]
    # The holidays a run would see, without writing them: the table plus the
    # rule-derived official days of any year it lacks.
    official = pd.concat([official_holidays(year) for year in range(int(calls["start_ts"].min().year),
                                                                     last_day.year + 2)], ignore_index=True)
    holidays = pd.concat([table, official[~official["holiday_date"].isin(table["holiday_date"])]],
                         ignore_index=True).sort_values("holiday_date").reset_index(drop=True)
    featured = featured_frame(hourly_from_calls(calls)[list(HOURLY_COLUMNS)], holidays)
    model = fit_model(featured, holidays, PRODUCTION)
    fingerprint = hashlib.sha256(model.booster.model_to_string().encode()).hexdigest()
    print(f"reference  model_sha256 {reference.get('model_sha256')}  train_rows {reference.get('train_rows')}  "
          f"train_start {reference.get('train_start')}")
    print(f"retrained  model_sha256 {fingerprint}  train_rows {model.train_rows}  "
          f"train_start {model.train_start.isoformat()}")
    same = fingerprint == reference.get("model_sha256")
    print("MATCH: same data and libraries give the same model." if same else
          "DIFFERENT: see the deployment guide on comparing models across machines.")
    return EXIT_SUCCEEDED if same else EXIT_REFERENCE_DIFFERS


# =============================================================================
# Entry point
# =============================================================================

def _print_result(run_id: int | None, status: str, model_id: int | None, model_sha256: str | None) -> None:
    payload = {"run_id": run_id, "status": status, "model_id": model_id, "model_sha256": model_sha256}
    print(f"{RESULT_PREFIX} {json.dumps(payload, separators=(',', ':'))}", flush=True)


def _describe(error: Exception) -> str:
    """The error's type, and its text only when that cannot quote stored data.

    The message and the output reach the admin page. SQLite's own texts name
    tables, columns and conditions, never values; any other text might quote
    a value it failed on (a call's start time, say), so it is left out."""
    name = type(error).__name__
    if isinstance(error, store.DatabaseError):
        return f"{name}: {error}"
    return f"{name} (its text is not shown, as it may quote stored data; see where it happened in the output)"


def _print_traceback(error: Exception) -> None:
    """Where it happened (file, line, code), then _describe: no exception text."""
    print("Traceback (most recent call last):", file=sys.stderr)
    print("".join(traceback.format_tb(error.__traceback__)), end="", file=sys.stderr)
    print(_describe(error), file=sys.stderr, flush=True)


def _record_failure(conn, run_id: int | None, message: str, unclaimed: bool = False) -> None:
    """Best effort: the run row is the report, but a broken database must not
    hide the original error. unclaimed: the web app's row, still queued because
    the run failed before it could claim it."""
    if conn is None or run_id is None:
        return
    try:
        store.finish_run(conn, run_id, status="failed", message=message, unclaimed=unclaimed)
    except Exception as error:  # noqa: BLE001  (already failing; report and go on)
        print(f"could not record the failure on run {run_id}: {type(error).__name__}: {error}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    previous = lifetime.stop_on_signals()
    try:
        return _main(argv)
    except lifetime.Stopped as stop:
        lifetime.end_by(stop.signum)
        raise  # not reached: end_by ends the process
    finally:
        lifetime.restore_signals(previous)


def _main(argv: list[str] | None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    settings = _settings(parser, args)
    if not settings.db.is_absolute() or not settings.db.is_file():
        print(f"Cannot retrain: --db must be the absolute path of an existing database file, got {args.db}",
              file=sys.stderr)
        _print_result(settings.run_id, "failed", None, None)
        return EXIT_REFUSED
    if args.verify_reference:
        return verify_reference(settings.db)

    if settings.run_id is not None:
        # Started by the web app, which owns the run row: when its process ends,
        # this run ends too (as on SIGTERM), and the web app's next start records it.
        lifetime.bind_to_parent(os.getppid(), signal.SIGTERM)

    conn = None
    run_id = None  # set once this process holds the row; until then nothing is recorded on it
    try:
        conn = store.connect(settings.db)
        snapshot = store.read_snapshot(conn)
        calls = snapshot.calls
        try:
            run_id = store.start_run(
                conn, settings.run_id, mode=settings.mode, pid=os.getpid(), calls_revision=snapshot.calls_revision,
                calls_count=len(calls), data_start=None if calls.empty else _day(calls["start_ts"].min()),
                data_end=None if calls.empty else _day(calls["start_ts"].max()))
        except store.RunNotOpen as error:
            raise Refusal(f"Cannot retrain: {error}. The web app creates a queued row for each run it starts; "
                          f"run from a shell without --run-id.") from error
        print(f"run {run_id}: {settings.mode}, data revision {snapshot.calls_revision}, {len(calls):,} calls, "
              f"today {settings.today}, horizon {settings.horizon_days} days, gate {settings.gate_origins} origins "
              f"on {settings.workers} worker(s)")
        outcome = _run(conn, settings, run_id, snapshot)
    except Refusal as refusal:
        print(str(refusal), file=sys.stderr)
        _record_failure(conn, run_id, str(refusal))
        _print_result(run_id or settings.run_id, "failed", None, None)
        return EXIT_REFUSED
    except lifetime.Stopped as stop:
        print(f"\nStopped by {stop.name}; the gate workers were stopped and nothing more is written.",
              file=sys.stderr, flush=True)
        if settings.run_id is None:
            _record_failure(conn, run_id, f"Stopped by {stop.name} before it finished. Nothing new was written; "
                                          f"the previous forecast is still in use.")
        raise
    except Exception as error:  # noqa: BLE001  (reported on the run row, then exit 1)
        _print_traceback(error)
        if run_id is not None:
            _record_failure(conn, run_id, f"Unexpected error: {_describe(error)}")
        else:  # failed before the claim (reading the calls, say): the web app's row is still queued
            _record_failure(conn, settings.run_id, f"Unexpected error: {_describe(error)}", unclaimed=True)
        _print_result(run_id or settings.run_id, "failed", None, None)
        return EXIT_UNEXPECTED
    finally:
        if conn is not None:
            conn.close()
    _print_result(run_id, outcome.status, outcome.model_id, outcome.model_sha256)
    return outcome.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
