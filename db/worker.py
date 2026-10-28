"""Run monthly jobs: python -m db.worker [--once]. Uses PostgreSQL advisory locks."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import logging
import signal
import time
import uuid

from psycopg.types.json import Jsonb

from db.artifacts import activate, active_version, model_root
from db.pipeline import LOCK_ID, connect, next_month

log = logging.getLogger("v4w.worker")


def actual_report(conn, batch):
    row = conn.execute("""SELECT count(*) AS calls,
        count(*) FILTER (WHERE abandoned) AS abandoned,
        count(*) FILTER (WHERE NOT abandoned) AS answered,
        avg(agent_sec) FILTER (WHERE NOT abandoned AND agent_sec>0) AS mean_handle_sec,
        avg(in_queue_sec) FILTER (WHERE NOT abandoned) AS mean_answer_wait_sec
        FROM calls WHERE start_ts >= %s AND start_ts < %s""",
        (batch["month"], next_month(batch["month"]))).fetchone()
    total = row["calls"]
    daily = conn.execute("""SELECT start_ts::date AS date,count(*) AS calls,
        count(*) FILTER (WHERE abandoned) AS abandoned FROM calls
        WHERE start_ts >= %s AND start_ts < %s GROUP BY 1 ORDER BY 1""",
        (batch["month"], next_month(batch["month"]))).fetchall()
    return {
        "month": batch["month"].strftime("%Y-%m"), "batch_id": str(batch["id"]),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "actuals": {**row, "abandonment_rate": row["abandoned"] / total if total else None},
        "daily": [{**r, "date": r["date"].isoformat()} for r in daily],
        "notes": ["Actual results for the uploaded month. No prospective forecast accuracy is claimed.",
                  "Mean handle time excludes answered calls with zero agent time.",
                  "Completeness was attested at import; absence of calls alone cannot establish export coverage."],
    }


def store_report(conn, batch_id, content):
    conn.execute("""INSERT INTO pipeline_reports(id,batch_id,content) VALUES (%s,%s,%s)
        ON CONFLICT (batch_id) DO UPDATE SET content=excluded.content,created_at=now()""",
        (uuid.uuid4(), batch_id, Jsonb(content)))


def run_once(conn, trainer=None):
    """Run at most one job. A crashed worker's 'running' job is recovered next.

    The session lock serializes every worker and excludes imports/corrections
    until training and reporting finish, keeping the source dataset stable.
    """
    if not conn.execute("SELECT pg_try_advisory_lock(%s) AS locked", (LOCK_ID,)).fetchone()["locked"]:
        return False
    try:
        with conn.transaction():
            conn.execute("UPDATE pipeline_batches SET records=NULL,status='expired' WHERE status='validated' AND expires_at<now()")
            job = conn.execute("""SELECT j.*,b.month,b.status AS batch_status FROM pipeline_jobs j
                JOIN pipeline_batches b ON b.id=j.batch_id WHERE j.state IN ('pending','running')
                ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j""").fetchone()
            if not job:
                return False
            if job["batch_status"] != "imported":
                conn.execute("UPDATE pipeline_jobs SET state='complete',training_status='superseded',report_status='superseded',updated_at=now() WHERE id=%s",
                             (job["id"],))
                return True
            conn.execute("UPDATE pipeline_jobs SET state='running',training_status='running',error_code=NULL,attempts=attempts+1,updated_at=now() WHERE id=%s",
                         (job["id"],))
        batch = {"id": job["batch_id"], "month": job["month"]}
        report = None
        try:
            report = actual_report(conn, batch)
            with conn.transaction():
                store_report(conn, job["batch_id"], report)
                conn.execute("UPDATE pipeline_jobs SET report_status='complete',updated_at=now() WHERE id=%s", (job["id"],))
            if trainer is None:
                from db.train import train_candidate
                trainer = train_candidate
            version = uuid.uuid4().hex
            output = model_root() / "versions" / version
            outcome = trainer(conn, output)
            if outcome["status"] == "passed":
                # Read both candidate files before switching the pointer.
                import lightgbm as lgb
                lgb.Booster(model_file=str(output / "volume_lgbm.txt"))
                metadata = json.loads((output / "metadata.json").read_text())
                if not metadata.get("features") or not metadata.get("train_start"):
                    raise ValueError("Invalid candidate metadata")
                metadata.update(batch_id=str(job["batch_id"]), model_version=version)
                (output / "metadata.json").write_text(json.dumps(metadata, indent=2))
                activate(version)
            report["training"] = {**outcome, "active_model_version": active_version()}
            with conn.transaction():
                store_report(conn, job["batch_id"], report)
                conn.execute("UPDATE pipeline_jobs SET state='complete',training_status=%s,model_version=%s,updated_at=now() WHERE id=%s",
                             (outcome["status"], version if outcome["status"] == "passed" else None, job["id"]))
                conn.execute("UPDATE pipeline_state SET revision=revision+1")
        except Exception:
            # Cell values, SQL parameters, connection strings and tokens must
            # never be copied into public job errors or logs.
            log.error("Monthly processing failed for job %s", job["id"])
            with conn.transaction():
                if report is not None:
                    report["training"] = {"status": "failed", "active_model_version": active_version()}
                    store_report(conn, job["batch_id"], report)
                conn.execute("""UPDATE pipeline_jobs SET state='failed',training_status='failed',
                    report_status=%s,error_code='processing_failed',updated_at=now() WHERE id=%s""",
                    ("complete" if report is not None else "failed", job["id"]))
        return True
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv()
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping:
        with connect() as conn:
            conn.autocommit = True
            worked = run_once(conn)
        if args.once:
            break
        if not worked:
            time.sleep(5)


if __name__ == "__main__":
    main()
