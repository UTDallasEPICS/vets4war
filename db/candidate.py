"""Verify isolated CI candidate artifacts using the production recipe and gate."""

import argparse
import json
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from db.monitor import load_model
from db.procedure import PRODUCTION
from db.train import METADATA_PATH, MODEL_PATH


def verify(directory: Path, cutoff: date, active_version: str | None = None):
    if cutoff >= datetime.now(ZoneInfo("America/New_York")).date():
        raise ValueError("Use a completed Eastern calendar day.")
    _, metadata, identity = load_model(directory / MODEL_PATH.name, directory / METADATA_PATH.name)
    trained_through = datetime.fromisoformat(identity["train_end"]).date()
    if metadata.get("procedure") != PRODUCTION.to_dict() or not metadata.get("model_sha256"):
        raise ValueError("Expected the packaged production recipe and a verified artifact hash.")
    if active_version is not None:
        if identity["model_sha256"] != active_version or cutoff <= trained_through:
            raise ValueError("The requested incumbent differs or the candidate cutoff is not newer.")
    else:
        gate = metadata.get("gate") or {}
        if trained_through != cutoff or gate.get("passed") is not True:
            raise ValueError("The candidate cutoff or saved rolling-origin training gate failed.")
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["verify-incumbent", "verify-candidate"])
    parser.add_argument("--directory", default=MODEL_PATH.parent, type=Path)
    parser.add_argument("--cutoff", required=True, type=date.fromisoformat)
    parser.add_argument("--active-version")
    args = parser.parse_args()
    if (args.mode == "verify-incumbent") != bool(args.active_version):
        parser.error("The incumbent check requires the active model version.")
    print(json.dumps(verify(args.directory, args.cutoff, args.active_version)))


if __name__ == "__main__":
    main()
