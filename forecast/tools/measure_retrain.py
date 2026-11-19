#!/usr/bin/env python3
"""Time and memory of a full retrain per gate worker count (risk R3).

    cd forecast && .venv/bin/python tools/measure_retrain.py --db PATH --workers 1 2 4 [--today YYYY-MM-DD]

For each worker count, python -m db.retrain runs on a fresh COPY of the
database (the original is never written) and this prints:

    wall_s        wall-clock seconds of the run
    maxrss_mb     ru_maxrss of the run (os.wait4: the largest single process
                  of its tree, the gate's worker processes included)
    tree_peak_mb  peak of the summed RSS of the whole process tree, sampled
                  from /proc every SAMPLE_SEC (what the container must hold)
    exit, status  the script's exit code and V4W_RESULT status

Run it on SYNTHETIC data only, and label any number it prints as measured on
synthetic data on this machine: it sizes a container, it says nothing about
forecast accuracy. Linux only (/proc).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

FORECAST_DIR = Path(__file__).resolve().parents[1]
SAMPLE_SEC = 0.5
PAGE_BYTES = os.sysconf("SC_PAGE_SIZE")
MB = 1024 * 1024
RESULT_PREFIX = "V4W_RESULT "


def _children() -> dict[int, list[int]]:
    """Parent pid -> child pids, for every process visible in /proc."""
    tree: dict[int, list[int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path(f"/proc/{entry}/stat").read_text()
        except OSError:
            continue
        # The command name may contain spaces; the fields after its ')' do not.
        parent = int(stat.rsplit(")", 1)[1].split()[1])
        tree.setdefault(parent, []).append(int(entry))
    return tree


def tree_rss_bytes(root: int) -> int:
    """Summed resident memory of `root` and all its descendants."""
    tree = _children()
    total, pending = 0, [root]
    while pending:
        pid = pending.pop()
        pending.extend(tree.get(pid, []))
        try:
            total += int(Path(f"/proc/{pid}/statm").read_text().split()[1]) * PAGE_BYTES
        except (OSError, IndexError, ValueError):
            continue
    return total


def measure(db: Path, workers: int, extra: list[str], log: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="measure-retrain-") as folder:
        copy = Path(folder) / "copy.db"
        shutil.copy(db, copy)
        command = [sys.executable, "-m", "db.retrain", "--db", str(copy), "--workers", str(workers), *extra]
        peak = 0
        started = time.monotonic()
        with log.open("w") as out:
            process = subprocess.Popen(command, cwd=FORECAST_DIR, stdout=out, stderr=subprocess.STDOUT)
            done = threading.Event()

            def sample() -> None:
                nonlocal peak
                while not done.is_set():
                    peak = max(peak, tree_rss_bytes(process.pid))
                    done.wait(SAMPLE_SEC)

            sampler = threading.Thread(target=sample, daemon=True)
            sampler.start()
            _, status, usage = os.wait4(process.pid, 0)
            done.set()
            sampler.join()
            process.returncode = os.waitstatus_to_exitcode(status)
        wall = time.monotonic() - started
    lines = [line for line in log.read_text().splitlines() if line.startswith(RESULT_PREFIX)]
    result = json.loads(lines[-1].removeprefix(RESULT_PREFIX)) if lines else {}
    return {"workers": workers, "wall_s": wall, "maxrss_mb": usage.ru_maxrss * 1024 / MB,
            "tree_peak_mb": peak / MB, "exit": process.returncode, "status": result.get("status")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Wall time and memory of db.retrain per gate worker count.")
    parser.add_argument("--db", type=Path, required=True, help="a database with SYNTHETIC calls (copied, never written)")
    parser.add_argument("--workers", type=int, nargs="+", default=[1, 2, 4])
    parser.add_argument("--today", default=None, help="passed to db.retrain")
    parser.add_argument("--log-dir", type=Path, default=None, help="keep each run's output here")
    args = parser.parse_args(argv)
    db = args.db.resolve()
    if not db.is_file():
        sys.exit(f"no database file at {db}")
    extra = ["--today", args.today] if args.today else []
    log_dir = args.log_dir or Path(tempfile.mkdtemp(prefix="measure-retrain-logs-"))
    log_dir.mkdir(parents=True, exist_ok=True)

    print(f"database {db} (SYNTHETIC data; numbers measured on this machine, {os.cpu_count()} CPUs visible)")
    print(f"{'workers':>7s} {'wall_s':>8s} {'maxrss_mb':>10s} {'tree_peak_mb':>13s} {'exit':>5s}  status")
    rows = []
    for workers in args.workers:
        row = measure(db, workers, extra, log_dir / f"retrain_workers_{workers}.log")
        rows.append(row)
        print(f"{row['workers']:>7d} {row['wall_s']:>8.1f} {row['maxrss_mb']:>10.0f} {row['tree_peak_mb']:>13.0f} "
              f"{row['exit']:>5d}  {row['status']}", flush=True)
    print(f"logs in {log_dir}")
    return 0 if all(row["exit"] == 0 for row in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
