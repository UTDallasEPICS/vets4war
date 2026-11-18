"""Admin model metadata and dispatch for the protected GitHub workflow."""

import hashlib
import json
import os
import re
from datetime import date, datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from api.auth import require_permissions
from api.reports import monthly_report
from db import pipeline
from db.forecast import check_model_matches
from db.train import METADATA_PATH, MODEL_PATH

router = APIRouter(tags=["admin"])
read_admin = require_permissions("read:admin")
request_training = require_permissions("read:admin", "trigger:retraining")
workflow = "actions/workflows/retrain.yml"


def active_model():
    try:
        metadata = json.loads(METADATA_PATH.read_bytes())
        artifact = MODEL_PATH.read_bytes().replace(b"\r\n", b"\n")
        check_model_matches(metadata, artifact)
        version = hashlib.sha256(artifact).hexdigest()
        if metadata.get("model_sha256", version) != version:
            raise ValueError("Model hash mismatch")
        trained_through = datetime.fromisoformat(metadata["train_end"])
        trained_at = datetime.fromisoformat(metadata["created_at_utc"])
        if trained_at.tzinfo is None:
            raise ValueError("Missing training timezone")
    except (OSError, KeyError, TypeError, ValueError):
        raise HTTPException(503, "The active model metadata is unavailable or invalid.") from None
    gate = metadata.get("gate") or {}
    backtest = None
    if gate.get("passed") is True:
        fields = ("daily_mape_1_14", "hourly_mae_1_14")
        backtest = {key: gate.get(key) for key in ("origins", "first_origin", "last_origin")}
        backtest["metrics"] = {key: gate.get("model", {}).get(key) for key in fields}
    today = datetime.now(ZoneInfo("America/New_York")).date()
    return {"historical_backtest": backtest, "name": "LightGBM call volume", "version": version, "trained_at": trained_at,
            "train_end": trained_through, "data_age_days": (today - trained_through.date()).days}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def github(path, payload=None):
    repo = os.getenv("V4W_RETRAIN_REPOSITORY", "")
    token = os.getenv("V4W_RETRAIN_GITHUB_TOKEN", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or not token:
        raise HTTPException(503, "GitHub retraining is not configured.")
    request = Request(f"https://api.github.com/repos/{repo}/{path}",
                      data=json.dumps(payload).encode() if payload else None,
                      headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                               "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10"})
    try:
        with build_opener(_NoRedirect()).open(request, timeout=8) as response:
            return json.load(response)
    except (URLError, TimeoutError, ValueError):
        raise HTTPException(502, "GitHub could not confirm the retraining operation. Check recent runs before retrying.") from None


class RetrainRequest(BaseModel):
    cutoff: date
    complete_history_confirmed: bool


@router.get("/model-health")
def model_health(response: Response, user: dict = Depends(read_admin)):
    response.headers["Cache-Control"] = "no-store"
    active = active_model()
    evaluation = None
    configured = os.getenv("V4W_ACCURACY_REPORT_DIR")
    if configured:
        for path in sorted(Path(configured).glob("????-??.json"), reverse=True):
            try:
                report = monthly_report(path.stem)
            except HTTPException:
                continue
            if report["model"].get("model_sha256") == active["version"]:
                evaluation = {key: report[key] for key in (
                    "status", "evaluation_period", "completeness", "metrics", "warnings")}
                break
    data_through = None
    data_status = "unavailable"
    try:
        with pipeline.connect() as conn:
            conn.read_only = True
            with conn.transaction():
                latest = conn.execute("SELECT max(start_ts) AS latest FROM calls").fetchone()["latest"]
        data_through = latest.date() if latest is not None else None
        data_status = "available" if latest is not None else "empty"
    except (pipeline.PipelineError, psycopg.Error):
        pass
    days_behind = (data_through - active["train_end"].date()).days if data_through is not None else None
    return {**active, "evaluation": evaluation, "data_through": data_through,
            "data_status": data_status, "days_behind_latest_call": days_behind}


@router.get("/retraining")
def training_runs(response: Response, user: dict = Depends(read_admin)):
    response.headers["Cache-Control"] = "no-store"
    data = github(f"{workflow}/runs?branch=final-main&event=workflow_dispatch&per_page=10")
    fields = ("id", "display_title", "status", "conclusion", "created_at", "updated_at", "html_url")
    return [{key: run[key] for key in fields} for run in data["workflow_runs"]]


@router.post("/retraining", status_code=202)
def create_training(body: RetrainRequest, user: dict = Depends(request_training)):
    today = datetime.now(ZoneInfo("America/New_York")).date()
    if not body.complete_history_confirmed or body.cutoff >= today:
        raise HTTPException(400, "Confirm verified historical data through a completed Eastern day.")
    active = active_model()
    result = github(f"{workflow}/dispatches", {"ref": "final-main", "inputs": {
        "cutoff": body.cutoff.isoformat(), "active_version": active["version"]}})
    return {"id": result["workflow_run_id"], "url": result["html_url"], "cutoff": body.cutoff,
            "active_version": active["version"]}
