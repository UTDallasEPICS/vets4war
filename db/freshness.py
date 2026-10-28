"""Invalidate process caches after committed imports, including across workers."""
from threading import Lock
import os

_seen = None
_lock = Lock()


def refresh(conn):
    global _seen
    if os.getenv("V4W_PIPELINE_ENABLED", "false").lower() != "true":
        return
    from db.pipeline import revision
    current = revision(conn)
    with _lock:
        if current == _seen:
            return
        import db.forecast as forecast
        import db.patience as patience
        import db.source as source
        with forecast._cache_lock:
            forecast._cache = {"mtime": None, "booster": None, "metadata": None, "aht": {}}
        patience._cache = None
        source._range_cache = None
        _seen = current
