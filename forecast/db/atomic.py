"""Replace a file whole or not at all.

A run that is interrupted while writing must not leave half a ledger, half
a cache file or a model without its metadata under the real name.

    atomic_write(path, write)   write(tmp_path) fills a temporary file next
                                to `path`; it is moved over `path` only if
                                `write` returned without raising
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable


def atomic_write(path: Path, write: Callable[[Path], None]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        write(temporary)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
