"""Authenticated monthly data portal; original workbooks are never retained."""
from contextlib import contextmanager
import csv
from io import StringIO
import os
from pathlib import Path
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse, Response
import psycopg
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from typing import Literal

from api.auth import require_admin
from db import pipeline
from db.artifacts import active_version

router = APIRouter()


@contextmanager
def database():
    if os.getenv("V4W_PIPELINE_ENABLED", "false").lower() != "true":
        raise HTTPException(503, "The admin pipeline is not enabled. Complete the setup steps first.")
    try:
        with pipeline.connect() as conn:
            yield conn
    except pipeline.PipelineError as exc:
        raise HTTPException(exc.status, str(exc)) from None
    except psycopg.Error:
        raise HTTPException(503, "The pipeline database is unavailable or needs its migration. No partial import was committed.") from None


@router.get("/admin")
def portal(request: Request):
    require_admin(request)
    return FileResponse(Path(__file__).resolve().parent.parent / "web/admin.html")


@router.get("/api/admin/contract")
def export_contract(request: Request):
    require_admin(request)
    try:
        profile = pipeline.contract()
        return {"configured": True, "contract": profile.model_dump()}
    except pipeline.PipelineError as exc:
        return {"configured": False, "detail": str(exc)}


@router.post("/api/admin/uploads")
async def upload(request: Request, month: str):
    user = require_admin(request)
    if request.headers.get("content-type", "").split(";")[0] != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        raise HTTPException(415, "Upload an .xlsx workbook.")
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > pipeline.MAX_BYTES:
            raise HTTPException(413, "Upload a workbook no larger than 25 MB.")
        content.extend(chunk)

    def validate():
        with database() as conn:
            return pipeline.preview(conn, bytes(content), pipeline.month_start(month), user["email"], pipeline.contract())

    return await run_in_threadpool(validate)


class ImportRequest(BaseModel):
    confirm_complete_month: Literal[True]
    expected_rows: int = Field(gt=0, le=pipeline.MAX_ROWS)
    replace_batch_id: uuid.UUID | None = None


@router.post("/api/admin/uploads/{batch_id}/import")
def import_upload(batch_id: uuid.UUID, body: ImportRequest, request: Request):
    user = require_admin(request)
    with database() as conn:
        return pipeline.commit_import(conn, batch_id, pipeline.contract(), expected_rows=body.expected_rows,
                                      replace_batch_id=body.replace_batch_id, actor=user["email"])


@router.get("/api/admin/uploads")
def uploads(request: Request):
    require_admin(request)
    with database() as conn:
        return {"uploads": pipeline.history(conn), "active_model_version": active_version()}


@router.post("/api/admin/jobs/{job_id}/retry")
def retry(job_id: uuid.UUID, request: Request):
    require_admin(request)
    with database() as conn:
        return pipeline.retry_job(conn, job_id)


@router.get("/api/admin/reports/{report_id}")
def report(report_id: uuid.UUID, request: Request, format: Literal["json", "csv"] = "json"):
    require_admin(request)
    with database() as conn:
        row = conn.execute("SELECT content FROM pipeline_reports WHERE id=%s", (report_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Report not found.")
    content = row["content"]
    filename = "monthly-report-" + content["month"]
    if format == "csv":
        stream = StringIO()
        writer = csv.writer(stream)
        writer.writerow(["month", "metric", "value"])
        for key, value in content["actuals"].items():
            writer.writerow([content["month"], key, value])
        writer.writerow([])
        writer.writerow(["date", "calls", "abandoned"])
        for day in content["daily"]:
            writer.writerow([day["date"], day["calls"], day["abandoned"]])
        writer.writerow([])
        training = content.get("training", {})
        writer.writerow(["training_status", training.get("status", "pending")])
        writer.writerow(["active_model_version", training.get("active_model_version", "")])
        writer.writerow(["backtest_model", "daily_mae", "hourly_mae", "hourly_rmse"])
        for metric in training.get("backtest", {}).get("overall", []):
            writer.writerow([metric["model"], metric["daily_mae"], metric["mae"], metric["rmse"]])
        writer.writerow([])
        for note in content["notes"]:
            writer.writerow(["note", note])
        return Response(stream.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'})
    return JSONResponse(jsonable_encoder(content), headers={"Content-Disposition": f'inline; filename="{filename}.json"'})
