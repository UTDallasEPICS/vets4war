"""Read-only presentation of offline db.monitor reports; no scoring or DB access."""

import calendar
import hashlib
import json
import math
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Response

from api.auth import require_permissions

router = APIRouter(prefix="/reports", tags=["admin"])
METRICS = ("hourly_mae", "hourly_rmse", "daily_total_mae", "signed_bias",
           "hours", "days", "actual_calls", "predicted_calls")
WEB_ROOT = Path(__file__).resolve().parents[1] / "web"


def monthly_report(month: str) -> dict:
    """Project a trusted offline artifact onto a bounded, aggregate-only API."""
    try:
        if not re.fullmatch(r"\d{4}-\d{2}", month):
            raise ValueError
        first = date.fromisoformat(month + "-01")
        today = datetime.now(ZoneInfo("America/New_York")).date()
        if first >= today.replace(day=1):
            raise ValueError
        last = first.replace(day=calendar.monthrange(first.year, first.month)[1])
    except ValueError:
        raise HTTPException(400, "Choose a completed reporting month (YYYY-MM).") from None
    configured = os.environ.get("V4W_ACCURACY_REPORT_DIR", "").strip()
    if not configured:
        raise HTTPException(404, "No offline accuracy report is available for this month.")
    try:
        directory = Path(configured).resolve()
        path = (directory / f"{month}.json").resolve()
        if path.parent != directory or path.is_relative_to(WEB_ROOT.resolve()):
            raise ValueError
        if not path.exists():
            raise HTTPException(404, "No offline accuracy report is available for this month.")
        with path.open("rb") as stream:
            raw = stream.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError
        report = json.loads(raw.decode("utf-8-sig"))
        if report["schema_version"] != 1 or report["evaluation_kind"] != "retrospective_replay":
            raise ValueError
        status = report["status"]
        if status not in ("success", "incomplete", "no_data", "error"):
            raise ValueError
        generated = report["executed_at_utc"]
        if not isinstance(generated, str) or datetime.fromisoformat(generated).tzinfo is None:
            raise ValueError
        # Never expose arbitrary operator evidence, source text, or local paths.
        warnings = report.get("warnings", [])
        if not isinstance(warnings, list) or len(warnings) > 100 or any(
            not isinstance(w, str) or len(w) > 2000 for w in warnings
        ):
            raise ValueError
        model = report.get("model") or {}
        model_identity = {key: model[key] for key in ("model_sha256", "metadata_sha256", "train_end") if key in model}
        if any(not isinstance(value, str) or len(value) > 128 for value in model_identity.values()):
            raise ValueError
        period = report.get("evaluation_period")
        metrics = None
        hourly, daily = [], []
        verified = (report.get("completeness") or {}).get("verified") is True
        if status == "success":
            start, end = date.fromisoformat(period["start"]), date.fromisoformat(period["end"])
            if not first <= start <= end <= last or period["timezone"] != "Eastern naive wall-clock":
                raise ValueError
            if start <= datetime.fromisoformat(model["train_end"]).date():
                raise ValueError
            if not verified:
                status = "incomplete"
                warnings = [*warnings, "Data completeness was not verified. Results are withheld."]
            else:
                metrics = {key: report["metrics"][key] for key in METRICS}
                if any(type(v) not in (int, float) or not math.isfinite(v) or
                       (key != "signed_bias" and v < 0) for key, v in metrics.items()):
                    raise ValueError
                if metrics["days"] != (end - start).days + 1 or metrics["hours"] != metrics["days"] * 24:
                    raise ValueError
                if "hourly" in report:
                    series = report["hourly"]
                    if not isinstance(series, list) or len(series) != metrics["hours"]:
                        raise ValueError
                    beginning = datetime.combine(start, datetime.min.time())
                    for index, point in enumerate(series):
                        timestamp = (beginning + timedelta(hours=index)).isoformat()
                        actual, predicted = point["actual"], point["predicted"]
                        if (point["hour"] != timestamp or type(actual) is not int or actual < 0
                                or type(predicted) not in (int, float) or not math.isfinite(predicted)
                                or predicted < 0):
                            raise ValueError
                        hourly.append({"hour": timestamp, "actual": actual, "predicted": predicted})
                    for offset in range(0, len(hourly), 24):
                        window = hourly[offset:offset + 24]
                        daily.append({"day": window[0]["hour"][:10],
                                      "actual": sum(point["actual"] for point in window),
                                      "predicted": sum(point["predicted"] for point in window)})
                    if sum(point["actual"] for point in daily) != metrics["actual_calls"] or not math.isclose(
                            sum(point["predicted"] for point in daily), metrics["predicted_calls"]):
                        raise ValueError
                if start != first or end != last:
                    status = "partial"
                    warnings = [*warnings, "This report covers only part of the month."]
        # Only validated dates and fixed timezone labels leave this boundary.
        safe_period = None
        if isinstance(period, dict):
            safe_period = {"start": date.fromisoformat(period["start"]).isoformat(),
                           "end": date.fromisoformat(period["end"]).isoformat(),
                           "timezone": "Eastern naive wall-clock"}
        return {"schema_version": 1, "report_id": hashlib.sha256(raw).hexdigest(),
                "reporting_month": month, "evaluation_kind": "retrospective_replay",
                "status": status, "generated_at_utc": generated,
                "evaluation_period": safe_period, "model": model_identity,
                "completeness": {"verified": verified}, "metrics": metrics, "warnings": warnings,
                **({"hourly": hourly, "daily": daily} if hourly else {})}
    except HTTPException:
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        raise HTTPException(503, "The offline accuracy report is unavailable or invalid.") from None


@router.get("")
def list_reports(response: Response, claims: dict = Depends(require_permissions("read:admin"))):
    """List published month filenames. Viewing a report verifies its contents."""
    response.headers["Cache-Control"] = "no-store"
    configured = os.environ.get("V4W_ACCURACY_REPORT_DIR", "").strip()
    if not configured:
        return {"months": []}
    try:
        directory = Path(configured).resolve()
        if directory.is_relative_to(WEB_ROOT.resolve()):
            raise ValueError
        cutoff = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m")
        months = []
        for path in directory.iterdir():
            month = path.stem
            if (path.suffix == ".json" and re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", month)
                    and month < cutoff and not month.startswith("0000") and not path.is_symlink()
                    and path.is_file()):
                months.append(month)
        return {"months": sorted(months, reverse=True)}
    except (OSError, ValueError):
        raise HTTPException(503, "The offline report directory is unavailable.") from None


@router.get("/{month}")
def get_monthly_report(month: str, response: Response,
                       claims: dict = Depends(require_permissions("read:admin"))):
    response.headers["Cache-Control"] = "no-store"
    return monthly_report(month)
