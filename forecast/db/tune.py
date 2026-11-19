"""The improvement loop: score candidates against the incumbent, keep a ledger.

    python -m db.tune baseline                    Oct 28 model, naive baseline, hindsight
                                                  oracle and Poisson floor on dev + hold-out
    python -m db.tune run NAME [--focus hours]    score one family of candidates
                                                  (db.experiments) against the incumbent on dev
    python -m db.tune promote NAME LABEL --why .. make an accepted candidate the incumbent
    python -m db.tune holdout                     incumbent vs the Oct 28 model on the
                                                  untouched hold-out weeks (final step only)
    python -m db.tune weeks --origins D [D ...]    named forecast weeks (the client's
                                                  validation weeks), old model vs incumbent
    python -m db.tune diagnose                    bias by weekday and hour, and the error
                                                  left if weekly totals were known, old vs incumbent
    python -m db.tune show                        the incumbent and every promotion so far

The folds, metrics and the accept / reject rule live in db.backtest and
were fixed before any result was seen
(docs/superpowers/plans/2026-11-10-model-final-run.md). This module only
runs them and writes down what happened:

    docs/final-run/ledger.json      every baseline, experiment, promotion
    docs/final-run/incumbent.json   the configuration currently in the lead

Data: the frozen dataset under data/cache/final_run (python -m db.dataset
... --snapshot data/cache/final_run). Nothing here writes to the database.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import pandas as pd

from db.atomic import atomic_write
from db.backtest import DAYS_PER_WEEK, compare, run_origins, score, weekly_origins, with_keys
from db.base_cache import cached_base_run, calibrated_predictions, fingerprint
from db.dataset import load_snapshot
from db.diagnostics import (
    SeasonalNaive,
    bias_tables,
    oracle_predictions,
    poisson_floor,
    special_day_mape,
    with_perfect_weekly_level,
)
from db.experiments import candidates, legacy_equivalent
from db.features import build_features
from db.legacy import LegacyProcedure
from db.procedure import ProcedureConfig, special_days
from db.train import REPO_ROOT, complete_hourly_grid

RUN_DIR = REPO_ROOT / "docs" / "final-run"
LEDGER_PATH = RUN_DIR / "ledger.json"
INCUMBENT_PATH = RUN_DIR / "incumbent.json"
CACHE_DIR = REPO_ROOT / "data" / "cache"
SNAPSHOT_DIR = CACHE_DIR / "final_run"
BASE_RUN_DIR = CACHE_DIR / "base_runs"

DEV_ORIGINS = 104
HOLDOUT_ORIGINS = 52
DEFAULT_WORKERS = 8
PRIMARY = "daily_mape_1_14"
LEGACY = "legacy"
TABLE_METRICS = ("daily_mape_1_14", "daily_mape_15_28", "hourly_mae_1_14", "block_wape_1_14",
                 "week_acc_std", "week_acc_min", "dow_bias_max", "cell_bias_rms", "week_total_ape")


# =============================================================================
# Ledger and incumbent files
# =============================================================================

def read_ledger(path: Path) -> list[dict]:
    return json.loads(Path(path).read_text()) if Path(path).exists() else []


def append_ledger(path: Path, entry: dict) -> None:
    """Write a NEW ledger: the old entries plus this one, time-stamped."""
    stamped = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry}
    text = json.dumps([*read_ledger(path), stamped], indent=1)
    atomic_write(path, lambda temporary: temporary.write_text(text))


def read_incumbent(path: Path) -> dict | None:
    return json.loads(Path(path).read_text()) if Path(path).exists() else None


def write_incumbent(path: Path, config: ProcedureConfig, label: str, experiment: str) -> None:
    text = json.dumps({"experiment": experiment, "label": label, "config": config.to_dict()}, indent=1)
    atomic_write(path, lambda temporary: temporary.write_text(text))


def current_config(record: dict | None) -> ProcedureConfig:
    """The configuration candidates are derived from. Before the first
    promotion that is the Oct 28 settings expressed in db.procedure."""
    return legacy_equivalent() if record is None else ProcedureConfig.from_dict(record["config"])


# =============================================================================
# Scoring candidates
# =============================================================================

def experiment_rows(offered: list[tuple[str, ProcedureConfig]], incumbent: pd.DataFrame,
                    evaluate: Callable[[str, ProcedureConfig], pd.DataFrame], focus: str = "daily",
                    special: frozenset | None = None) -> list[dict]:
    """One row per candidate (metrics, change versus the incumbent, verdict),
    lowest primary metric first. With `special`, each row also carries the
    error on those holiday-type days."""
    rows = []
    for label, config in offered:
        predictions = evaluate(label, config)
        result = compare(predictions, incumbent, focus)
        row = {"label": label, "config": config.to_dict(), "metrics": result["candidate"],
               "delta_pct": result["delta_pct"], "delta_abs": result["delta_abs"], "t": result["t"],
               "verdict": result["verdict"], "reason": result["reason"]}
        rows.append(row if special is None else {**row, "special_days": special_day_mape(predictions, special)})
    return sorted(rows, key=lambda row: row["metrics"][PRIMARY])


def best_accepted(rows: list[dict]) -> dict | None:
    accepted = [row for row in rows if row["verdict"] == "accept"]
    return min(accepted, key=lambda row: row["metrics"][PRIMARY]) if accepted else None


def check_promotable(ledger: list[dict], experiment: str, label: str, override: bool) -> None:
    """Raise unless `label` was scored in the latest run of `experiment` and
    was accepted (or the caller overrides, e.g. for the simpler-setting rule)."""
    runs = [entry for entry in ledger if entry.get("kind") == "experiment" and entry.get("experiment") == experiment
            and entry.get("set", "dev") == "dev"]
    rows = runs[-1]["rows"] if runs else []
    scored = [row for row in rows if row["label"] == label]
    if not scored:
        raise ValueError(f"no scored candidate {label!r} in experiment {experiment!r}; run it first")
    if scored[0]["verdict"] != "accept" and not override:
        raise ValueError(f"{label!r} was rejected by the acceptance rule; pass --override with a reason to keep it")


def first_week_report(predictions: pd.DataFrame, origin: pd.Timestamp) -> dict:
    """The numbers the client quotes for one forecast week: the 7 days after
    `origin`, forecast with data up to `origin`."""
    origin = pd.Timestamp(origin)
    if origin not in set(predictions["origin"]):
        raise ValueError(f"origin {origin.date()} is not among the scored origins")
    week = with_keys(predictions[(predictions["origin"] == origin) & (predictions["horizon_day"] <= DAYS_PER_WEEK)])
    daily = week.groupby("day")[["actual", "predicted"]].sum()
    ape = (daily["predicted"] - daily["actual"]).abs() / daily["actual"] * 100
    actual, predicted = float(daily["actual"].sum()), float(daily["predicted"].sum())
    return {
        "first_day": str(daily.index.min().date()),
        "last_day": str(daily.index.max().date()),
        "actual_calls": int(actual),
        "predicted_calls": predicted,
        "week_error_pct": (predicted - actual) / actual * 100,
        "daily_accuracy_pct": float(100 - ape.mean()),
        "worst_day_error_pct": float(ape.max()),
        "hourly_mae": float((week["predicted"] - week["actual"]).abs().mean()),
    }


def format_rows(rows: list[dict], incumbent_metrics: dict) -> str:
    def cells(label: str, metrics: dict, verdict: str) -> str:
        values = " ".join(f"{metrics[name]:8.3f}" for name in TABLE_METRICS)
        return f"{label[:44]:44s} {values}  {verdict}"

    header = f"{'candidate':44s} " + " ".join(f"{name[:8]:>8s}" for name in TABLE_METRICS)
    lines = [header, cells("INCUMBENT", incumbent_metrics, "")]
    for row in rows:
        delta, t = row["delta_pct"][PRIMARY], row["t"][PRIMARY]
        lines.append(cells(row["label"], row["metrics"], f"{row['verdict']} ({delta:+.2f}% t={t:+.1f}) {row['reason']}"))
    return "\n".join(lines)


# =============================================================================
# Data and evaluation
# =============================================================================

@dataclass(frozen=True)
class Context:
    featured: pd.DataFrame
    special: frozenset
    origins: dict[str, list[pd.Timestamp]]
    workers: int


def load_context(workers: int = DEFAULT_WORKERS) -> Context:
    dataset = load_snapshot(SNAPSHOT_DIR)
    featured = build_features(complete_hourly_grid(dataset.hourly), dataset.holidays)
    days = pd.DatetimeIndex(featured["hour_start"].dt.normalize().unique())
    origins = {"dev": weekly_origins(days, DEV_ORIGINS),
               "holdout": weekly_origins(days, HOLDOUT_ORIGINS, skip=DEV_ORIGINS)}
    return Context(featured, special_days(dataset.holidays, featured["hour_start"]), origins, workers)


def evaluate_config(context: Context, config: ProcedureConfig, which: str) -> pd.DataFrame:
    run = cached_base_run(context.featured, context.origins[which], config.base, BASE_RUN_DIR, context.workers)
    return calibrated_predictions(run, config.calibration, context.special)


def legacy_predictions(context: Context, which: str) -> pd.DataFrame:
    """The Oct 28 model's forecasts for one set of origins, computed once
    per version of the data (the file name carries the data fingerprint)."""
    origins = context.origins[which]
    path = CACHE_DIR / f"legacy_{which}_{fingerprint(context.featured, origins, legacy_equivalent().base)}.csv"
    if path.exists():
        return pd.read_csv(path, parse_dates=["origin", "hour_start"])
    predictions = run_origins(context.featured, origins, LegacyProcedure(), context.workers)
    atomic_write(path, lambda temporary: predictions.to_csv(temporary, index=False))
    return predictions


def incumbent_predictions(context: Context, record: dict | None, which: str) -> pd.DataFrame:
    if record is None:
        return legacy_predictions(context, which)
    return evaluate_config(context, ProcedureConfig.from_dict(record["config"]), which)


# =============================================================================
# Commands
# =============================================================================

def command_baseline(context: Context) -> None:
    for which, origins in context.origins.items():
        frames = {
            LEGACY: legacy_predictions(context, which),
            "seasonal naive": run_origins(context.featured, origins, SeasonalNaive(), workers=1),
            "hindsight oracle": oracle_predictions(context.featured, origins),
        }
        rows = [{"label": label, "metrics": score(frame)} for label, frame in frames.items()]
        floor = poisson_floor(frames[LEGACY])
        append_ledger(LEDGER_PATH, {"kind": "baseline", "set": which, "origins": len(origins),
                                    "first_origin": str(origins[0].date()), "last_origin": str(origins[-1].date()),
                                    "rows": rows, "poisson_floor": floor})
        print(f"\n## {which}: {len(origins)} origins {origins[0].date()} to {origins[-1].date()}")
        for row in rows:
            print(f"{row['label']:18s} " + " ".join(f"{name}={row['metrics'][name]:.3f}" for name in TABLE_METRICS))
        print(f"{'poisson floor':18s} " + " ".join(f"{name}={value:.3f}" for name, value in floor.items()))


def command_run(context: Context, experiment: str, focus: str, which: str = "dev") -> None:
    """Score a family against the incumbent. `which` is "dev" for every
    choice; "holdout" exists for a disclosed robustness look only."""
    record = read_incumbent(INCUMBENT_PATH)
    incumbent = incumbent_predictions(context, record, which)
    offered = candidates(experiment, current_config(record))
    rows = experiment_rows(offered, incumbent, lambda label, config: evaluate_config(context, config, which),
                           focus, context.special)
    incumbent_special = special_day_mape(incumbent, context.special)
    append_ledger(LEDGER_PATH, {"kind": "experiment", "experiment": experiment, "focus": focus, "set": which,
                                "incumbent": LEGACY if record is None else record["label"],
                                "incumbent_special_days": incumbent_special, "rows": rows})
    print(f"\n## {experiment} on {which} (focus {focus}); incumbent: {LEGACY if record is None else record['label']}")
    print(format_rows(rows, score(incumbent)))
    print(f"holiday-type days ({incumbent_special['days']} forecasts): incumbent {incumbent_special['daily_mape']:.2f}% | "
          + " | ".join(f"{row['label']}: {row['special_days']['daily_mape']:.2f}%" for row in rows))
    best = best_accepted(rows)
    print(f"\nbest accepted: {best['label'] if best else 'none'}")


def command_promote(experiment: str, label: str, why: str, override: bool) -> None:
    check_promotable(read_ledger(LEDGER_PATH), experiment, label, override)
    offered = dict(candidates(experiment, current_config(read_incumbent(INCUMBENT_PATH))))
    if label not in offered:
        raise ValueError(f"{label!r} is not a candidate of {experiment!r} for the current incumbent")
    write_incumbent(INCUMBENT_PATH, offered[label], label, experiment)
    append_ledger(LEDGER_PATH, {"kind": "promote", "experiment": experiment, "label": label, "why": why,
                                "override": override, "config": offered[label].to_dict()})
    print(f"incumbent is now {experiment}: {label}")


def command_holdout(context: Context) -> None:
    record = read_incumbent(INCUMBENT_PATH)
    if record is None:
        raise ValueError("no incumbent to score; nothing has been promoted")
    result = compare(incumbent_predictions(context, record, "holdout"), legacy_predictions(context, "holdout"))
    append_ledger(LEDGER_PATH, {"kind": "holdout", "label": record["label"], "config": record["config"],
                                "final": result["candidate"], "legacy": result["incumbent"],
                                "delta_pct": result["delta_pct"], "delta_abs": result["delta_abs"], "t": result["t"]})
    print("## hold-out (never used to choose anything)")
    for name in TABLE_METRICS:
        print(f"{name:18s} legacy {result['incumbent'][name]:8.3f}   final {result['candidate'][name]:8.3f}")
    print("relative change %:", {name: round(value, 2) for name, value in result["delta_pct"].items()})
    print("paired t:", {name: round(value, 2) for name, value in result["t"].items()})


def command_weeks(context: Context, origins: list[str]) -> None:
    """Named forecast weeks (e.g. the client's validation weeks): the Oct 28
    model and the incumbent, each trained only on data up to the origin."""
    record = read_incumbent(INCUMBENT_PATH)
    frames = {LEGACY: legacy_predictions(context, "dev"), "incumbent": incumbent_predictions(context, record, "dev")}
    rows = [{"origin": origin, "model": name, **first_week_report(frame, pd.Timestamp(origin))}
            for origin in origins for name, frame in frames.items()]
    append_ledger(LEDGER_PATH, {"kind": "weeks", "incumbent": LEGACY if record is None else record["label"], "rows": rows})
    for row in rows:
        print(f"{row['first_day']} to {row['last_day']}  {row['model']:9s} daily accuracy {row['daily_accuracy_pct']:5.1f}%  "
              f"week {row['predicted_calls']:6.0f} vs {row['actual_calls']} ({row['week_error_pct']:+.1f}%)  "
              f"hourly MAE {row['hourly_mae']:.2f}  worst day {row['worst_day_error_pct']:.1f}% off")


def command_diagnose(context: Context) -> None:
    """Where each model is off (bias by weekday and hour) and how much of the
    error a perfect weekly total would remove. Old model and incumbent, dev."""
    record = read_incumbent(INCUMBENT_PATH)
    frames = {LEGACY: legacy_predictions(context, "dev"), "incumbent": incumbent_predictions(context, record, "dev")}
    entry = {"kind": "diagnose", "set": "dev", "incumbent": LEGACY if record is None else record["label"], "models": {}}
    for name, frame in frames.items():
        tables = bias_tables(frame)
        known_total = score(with_perfect_weekly_level(frame))
        entry["models"][name] = {
            "dow_bias_pct": {int(dow): round(float(v), 2) for dow, v in tables["dow"]["bias_pct"].items()},
            "hour_bias_pct": {int(hour): round(float(v), 2) for hour, v in tables["hour"]["bias_pct"].items()},
            "horizon_week_bias_pct": {int(w): round(float(v), 2) for w, v in tables["horizon_week"]["bias_pct"].items()},
            "cell_bias_pct": [[round(float(v), 1) for v in row] for row in tables["cell"].to_numpy()],
            "with_weekly_total_known": {m: known_total[m] for m in ("daily_mape_1_14", "hourly_mae_1_14", "week_acc_std")},
        }
        print(f"\n## {name}")
        print("bias % by weekday (1=Mon..7=Sun):", entry["models"][name]["dow_bias_pct"])
        print("bias % by hour 0..23:", list(entry["models"][name]["hour_bias_pct"].values()))
        print("if every weekly total were known in advance:", {k: round(v, 3) for k, v in entry["models"][name]["with_weekly_total_known"].items()})
    append_ledger(LEDGER_PATH, entry)


def command_show() -> None:
    record = read_incumbent(INCUMBENT_PATH)
    print("incumbent:", LEGACY if record is None else json.dumps(record, indent=1))
    for entry in read_ledger(LEDGER_PATH):
        if entry["kind"] == "promote":
            print(f"{entry['at']}  promoted {entry['experiment']}: {entry['label']}  ({entry['why']})")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score candidates against the incumbent and keep the ledger.")
    parser.add_argument("command", choices=("baseline", "run", "promote", "holdout", "weeks", "diagnose", "show"))
    parser.add_argument("experiment", nargs="?")
    parser.add_argument("label", nargs="?")
    parser.add_argument("--focus", choices=("daily", "hours"), default="daily")
    parser.add_argument("--set", choices=("dev", "holdout"), default="dev",
                        help="run: which origins to score on (holdout = a disclosed robustness look, never for choosing)")
    parser.add_argument("--why", default="")
    parser.add_argument("--override", action="store_true", help="promote a candidate the rule rejected (say why)")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--origins", nargs="+", default=[], help="weeks: last training day of each forecast week")
    args = parser.parse_args(argv)

    # Worker processes inherit this: one thread each, so 8 workers use 8 cores.
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    if args.command == "show":
        command_show()
    elif args.command == "promote":
        if not (args.experiment and args.label and args.why):
            sys.exit("promote needs: NAME LABEL --why 'reason'")
        command_promote(args.experiment, args.label, args.why, args.override)
    elif args.command == "run":
        if not args.experiment:
            sys.exit("run needs an experiment name")
        command_run(load_context(args.workers), args.experiment, args.focus, args.set)
    elif args.command == "weeks":
        if not args.origins:
            sys.exit("weeks needs --origins YYYY-MM-DD [...]")
        command_weeks(load_context(args.workers), args.origins)
    elif args.command == "diagnose":
        command_diagnose(load_context(args.workers))
    elif args.command == "baseline":
        command_baseline(load_context(args.workers))
    else:
        command_holdout(load_context(args.workers))
    return 0


if __name__ == "__main__":
    sys.exit(main())
