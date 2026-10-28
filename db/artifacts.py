"""Versioned model pairs with one atomic activation pointer on a shared volume."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import uuid

ROOT = Path(__file__).resolve().parent.parent


def model_root():
    return Path(os.getenv("V4W_MODEL_DIR", str(ROOT / "models")))


def active_paths():
    root = model_root()
    pointer = root / "active.json"
    if not pointer.exists():
        return root / "volume_lgbm.txt", root / "metadata.json"
    version = json.loads(pointer.read_text())["version"]
    if not re.fullmatch(r"[a-f0-9]{32}", version):
        raise ValueError("Invalid active model version.")
    directory = root / "versions" / version
    return directory / "volume_lgbm.txt", directory / "metadata.json"


def activate(version):
    root = model_root()
    if not re.fullmatch(r"[a-f0-9]{32}", version):
        raise ValueError("Invalid model version.")
    directory = root / "versions" / version
    if not (directory / "volume_lgbm.txt").is_file() or not (directory / "metadata.json").is_file():
        raise ValueError("Model and metadata must both exist before activation.")
    temporary = root / (".active-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps({"version": version}))
    os.replace(temporary, root / "active.json")


def active_version():
    model, metadata = active_paths()
    return str(model.parent.name) if model.parent.name != model_root().name else "legacy"
