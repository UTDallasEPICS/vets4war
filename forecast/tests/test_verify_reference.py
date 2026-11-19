"""--verify-reference: retrain on the calls up to a reference model's last day
and compare fingerprints, writing nothing.

The reference is a tiny model pair written into a temp models/ folder; the
committed forecast/models is never touched. The calls are SYNTHETIC.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

from conftest import apply_migrations, insert_calls, synthetic_calls
from db.add_holidays import official_holidays
from db.client_files import hourly_from_calls
from db.procedure import PRODUCTION
from db.retrain import verify_reference
from db.train import featured_frame, fit_model

FORECAST_DIR = Path(__file__).resolve().parents[1]
FIRST_DAY = "2026-03-02"
REFERENCE_END = "2026-09-30"


@pytest.fixture(scope="module")
def calls() -> pd.DataFrame:
    return synthetic_calls(FIRST_DAY, 230)


@pytest.fixture(scope="module")
def database(calls, tmp_path_factory) -> Path:
    path = apply_migrations(tmp_path_factory.mktemp("verify") / "app.db")
    insert_calls(path, calls)
    return path


@pytest.fixture(scope="module")
def expected_sha(calls) -> str:
    """The fingerprint of the model trained on the calls through REFERENCE_END,
    computed here the long way (no database involved)."""
    upto = calls[calls["start_ts"] < pd.Timestamp(REFERENCE_END) + pd.Timedelta(days=1)]
    holidays = pd.concat([official_holidays(year) for year in (2026, 2027)], ignore_index=True)
    model = fit_model(featured_frame(hourly_from_calls(upto), holidays), holidays, PRODUCTION)
    return hashlib.sha256(model.booster.model_to_string().encode()).hexdigest()


def _reference(folder: Path, sha: str, train_end: str = f"{REFERENCE_END}T23:00:00") -> Path:
    models = folder / "models"
    models.mkdir()
    (models / "volume_lgbm.txt").write_text("tree\n")
    path = models / "metadata.json"
    path.write_text(json.dumps({"model_sha256": sha, "train_start": f"{FIRST_DAY}T00:00:00",
                                "train_end": train_end, "train_rows": 4848}))
    return path


def test_the_same_calls_reproduce_the_reference_fingerprint(database, expected_sha, tmp_path, capsys):
    before = database.read_bytes()

    code = verify_reference(database, _reference(tmp_path, expected_sha))

    out = capsys.readouterr().out
    assert code == 0
    assert f"retrained  model_sha256 {expected_sha}  train_rows 5112  train_start {FIRST_DAY}T00:00:00" in out
    assert "MATCH" in out
    assert database.read_bytes() == before                     # nothing written, not even holidays


def test_a_different_fingerprint_exits_4(database, tmp_path, capsys):
    code = verify_reference(database, _reference(tmp_path, "0" * 64))

    assert code == 4
    assert "DIFFERENT" in capsys.readouterr().out


def test_data_that_ends_before_the_reference_is_refused(database, tmp_path, capsys):
    code = verify_reference(database, _reference(tmp_path, "0" * 64, train_end="2027-01-31T23:00:00"))

    assert code == 2
    assert "trained through 2027-01-31, but the database has calls end 2026-10-17" in capsys.readouterr().err


def test_the_command_line_compares_with_the_committed_reference_and_writes_nothing(database, tmp_path):
    # The committed real-data model ends 2026-11-03; these SYNTHETIC calls end
    # earlier, so the command refuses before training anything.
    copy = Path(shutil.copy(database, tmp_path / "app.db"))
    before = copy.read_bytes()

    process = subprocess.run([sys.executable, "-m", "db.retrain", "--db", str(copy), "--verify-reference"],
                             cwd=FORECAST_DIR, capture_output=True, text=True, timeout=300)

    assert process.returncode == 2
    assert "Cannot verify: the reference model was trained through 2026-11-03" in process.stderr
    assert copy.read_bytes() == before
