"""Read-only volume replay. Run with ``python -m db.monitor --help``."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import warnings
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
import psycopg

from db.features import build_features, load_holidays, load_hourly
from db.forecast import holiday_coverage
from db.train import METADATA_PATH, MODEL_PATH, score


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _level_factor(metadata: dict) -> float:
    """Require a finite positive numeric correction; old artifacts use 1.0."""
    value = metadata.get("level_factor", 1.0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("level_factor must be a finite positive number")
    try:
        factor = float(value)
    except (ValueError, OverflowError) as exc:
        raise ValueError("level_factor must be a finite positive number") from exc
    if not math.isfinite(factor) or factor <= 0:
        raise ValueError("level_factor must be a finite positive number")
    return factor


def load_model(model_path: Path, metadata_path: Path):
    """Load one immutable in-memory copy and check the feature contract."""
    model_bytes = model_path.read_bytes()
    metadata_bytes = metadata_path.read_bytes()
    metadata = json.loads(metadata_bytes)
    _level_factor(metadata)
    start, end = pd.Timestamp(metadata["train_start"]), pd.Timestamp(metadata["train_end"])
    if pd.isna(start) or pd.isna(end) or start.tz is not None or end.tz is not None or end < start:
        raise ValueError("invalid naive training interval")
    if metadata.get("target") != "offered":
        raise ValueError("model target must be offered")
    features = metadata["features"]
    if not features or len(features) != len(set(features)):
        raise ValueError("invalid metadata features")
    booster = lgb.Booster(model_str=model_bytes.decode("utf-8"))
    if booster.feature_name() != features:
        raise ValueError("model feature names/order do not match metadata")
    model_hash = _sha256(model_bytes)
    if metadata.get("model_sha256") and metadata["model_sha256"] != model_hash:
        raise ValueError("model hash does not match metadata")
    identity = {"model_sha256": model_hash, "metadata_sha256": _sha256(metadata_bytes),
                "train_start": start.isoformat(), "train_end": end.isoformat(),
                "created_at_utc": metadata.get("created_at_utc"), "features": features,
                "pairing": "hash_verified" if metadata.get("model_sha256") else "feature_contract_only"}
    return booster, metadata, identity


def evaluate(conn, booster, metadata, start: date | None, end: date | None,
             attestation: dict | None, today: date) -> dict:
    """Score only complete historical days in the repository's wall-clock grain."""
    factor = _level_factor(metadata)
    train_end = pd.Timestamp(metadata["train_end"])
    first = train_end.normalize().date() + timedelta(days=1)
    start = max(start or first, first)
    # Yesterday in UTC is conservatively excluded to avoid an unfinished Eastern day.
    last_historical = today - timedelta(days=2)
    end = min(end or last_historical, last_historical)
    result = {"status": "incomplete", "evaluation_period": {"start": str(start), "end": str(end),
              "timezone": "Eastern naive wall-clock", "grain": "hour"},
              "metrics": None, "warnings": [], "completeness": {"verified": False}}
    if start > end:
        result.update(status="no_data")
        result["warnings"].append("No complete historical days strictly after train_end in the requested window.")
        return result
    if attestation is None:
        result["warnings"].append("Completeness cannot be established: no loader/operator attestation. Metrics withheld; missing hours are not assumed zero.")
        return result
    if not isinstance(attestation, dict):
        raise ValueError("completeness attestation must be an object")
    text_fields = ("complete_start", "complete_end", "source", "evidence", "timezone")
    required = {*text_fields, "offered_count"}
    if not required.issubset(attestation):
        raise ValueError("completeness attestation is missing required fields")
    if any(not isinstance(attestation[name], str) or not attestation[name].strip()
           for name in text_fields):
        raise ValueError("attestation text fields must be nonempty strings")
    if attestation["timezone"] != "Eastern naive wall-clock":
        raise ValueError("attestation timezone must match Eastern naive wall-clock")
    expected = attestation["offered_count"]
    if type(expected) is not int or expected < 0:
        raise ValueError("attestation offered_count must be a nonnegative integer")
    a_start, a_end = date.fromisoformat(attestation["complete_start"]), date.fromisoformat(attestation["complete_end"])
    if (a_start, a_end) != (start, end):
        result["warnings"].append("Attestation must cover exactly the effective evaluation dates (including any training/historical clipping).")
        return result
    try:
        hourly = load_hourly(conn)
    except ValueError as exc:
        # load_hourly's explicit empty-table signal is the only ValueError
        # that means no data. Parsing/processing failures must remain errors.
        if str(exc) != "`calls` is empty; nothing to aggregate":
            raise
        result.update(status="no_data")
        result["warnings"].append(str(exc))
        return result
    hours = pd.to_datetime(hourly["hour_start"])
    if hours.dt.tz is not None or hours.isna().any() or hours.duplicated().any() or not hours.eq(hours.dt.floor("h")).all():
        raise ValueError("actuals must have unique, nonnull naive hourly timestamps")
    selected = hourly.loc[(hours >= pd.Timestamp(start)) & (hours < pd.Timestamp(end) + pd.Timedelta(days=1))].copy()
    offered = selected["offered"]
    if not np.isfinite(offered).all() or (offered < 0).any() or (offered % 1 != 0).any():
        raise ValueError("actual offered counts must be finite nonnegative integers")
    if int(offered.sum()) != expected:
        result["warnings"].append("Database offered count differs from completeness evidence; metrics withheld.")
        return result
    if selected.empty:
        result.update(status="no_data")
        result["warnings"].append("No observations in the evaluation window; metrics withheld.")
        return result
    grid = pd.DataFrame({"hour_start": pd.date_range(start, pd.Timestamp(end) + pd.Timedelta(hours=23), freq="h")})
    actual = selected.set_index("hour_start")["offered"].reindex(grid["hour_start"], fill_value=0).to_numpy(dtype=float)
    holidays = load_holidays(conn)
    coverage = holiday_coverage(holidays, end)
    if not coverage["covered"]:
        result["warnings"].append(coverage["message"])
    featured = build_features(grid, holidays, epoch=metadata["train_start"])
    # Match production volume inference, including its saved level correction.
    # Older metadata without calibration retains the original predictions.
    predicted = (np.asarray(booster.predict(featured[metadata["features"]]), dtype=float)
                 * factor)
    if predicted.shape != actual.shape or not np.isfinite(predicted).all() or (predicted < 0).any():
        raise ValueError("model produced invalid predictions")
    # Existing scorer also calculates MAPE; suppress its undefined zero-denominator warning.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        metrics = score(grid["hour_start"], actual, predicted)
    result["metrics"] = {"hourly_mae": metrics["mae"], "hourly_rmse": metrics["rmse"],
                         "daily_total_mae": metrics["daily_mae"],
                         "signed_bias": float(np.mean(predicted - actual)),
                         "hours": len(actual), "days": len(actual) // 24,
                         "actual_calls": int(actual.sum()), "predicted_calls": float(predicted.sum())}
    result["completeness"] = {"verified": True, "method": "external_attestation_and_count_reconciliation",
                              "attestation": {name: attestation[name] for name in (*text_fields, "offered_count")},
                              "zero_filled_hours": len(actual) - len(selected)}
    result["warnings"].append("Completeness relies on external attestation; count reconciliation alone cannot prove completeness or detect duplicates.")
    result["warnings"].append("Retrospective replay uses today's holiday table; historical calendar availability is not archived. DST follows existing naive wall-clock aggregation (24 bins/day).")
    result["status"] = "success"
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=date.fromisoformat)
    parser.add_argument("--end", type=date.fromisoformat)
    parser.add_argument("--model", type=Path, default=MODEL_PATH)
    parser.add_argument("--metadata", type=Path, default=METADATA_PATH)
    parser.add_argument("--completeness", type=Path, help="Loader/operator JSON attestation; see docs/forecast-monitoring.md")
    args = parser.parse_args(argv)
    report = {"schema_version": 1, "evaluation_kind": "retrospective_replay",
              "executed_at_utc": datetime.now(timezone.utc).isoformat(), "status": "error",
              "model": None, "evaluation_period": None, "metrics": None, "warnings": []}
    try:
        if args.start and args.end and args.end < args.start:
            raise ValueError("end must not precede start")
        booster, metadata, identity = load_model(args.model, args.metadata)
        report["model"] = identity
        if identity["pairing"] == "feature_contract_only":
            report["warnings"].append("Metadata contains no model hash: feature compatibility is checked, but exact training-run pairing cannot be proven. Supply the deployed model and its matching metadata together.")
        attestation = json.loads(args.completeness.read_text(encoding="utf-8")) if args.completeness else None
        dsn = os.environ.get("V4W_DATABASE_URL")
        if not dsn:
            raise ValueError("V4W_DATABASE_URL is not set")
        # Enforce read-only, consistent reads server-side before the first query.
        with psycopg.connect(dsn, options="-c default_transaction_read_only=on -c default_transaction_isolation=repeatable\\ read", connect_timeout=15) as conn:
            outcome = evaluate(conn, booster, metadata, args.start, args.end, attestation,
                               datetime.now(timezone.utc).date())
        report["warnings"].extend(outcome.pop("warnings"))
        report.update(outcome)
    except psycopg.Error:
        # Driver messages can contain connection details; never serialize them.
        report["warnings"].append("Database connection or read failed; connection details omitted.")
    except FileNotFoundError:
        report["warnings"].append("Required model, metadata, or completeness file was not found.")
    except Exception as exc:
        report["warnings"].append(f"Invalid input, model, or evaluation data ({type(exc).__name__}); details omitted.")
    print(json.dumps(report, allow_nan=False, indent=2))
    return 0 if report["status"] == "success" else (1 if report["status"] == "error" else 2)


if __name__ == "__main__":
    sys.exit(main())
