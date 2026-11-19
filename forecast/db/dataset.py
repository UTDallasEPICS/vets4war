"""Assemble the training data: the shared database plus client files it lacks.

The database is the source of truth and is only READ here. The client also
sends call-record workbooks for periods that are not loaded yet (in November
2026: Sep 1 to Oct 13, Oct 21 to 27 and Oct 28 to Nov 3). Those are merged
in memory so the model can learn from them without anyone writing to the
shared tables.

    merge_hourly(db_hourly, extra_hourly) -> hourly
        days the database lacks are added; a day present in both keeps the
        database rows; a day present in both with a different call total
        raises (two versions of the same day is a data problem to settle,
        never something to pick silently).
    load_dataset(dsn, supplement)   -> Dataset(hourly, holidays, sources)
    save_snapshot / load_snapshot   -> a frozen local copy under data/ (never
        committed), so a long tuning run scores every candidate on exactly
        the same rows even if a teammate loads data meanwhile.

`sources` is the audit trail: what came from the database and what each
file added. db.train writes it into models/metadata.json.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from db.client_files import HOURLY_COLUMNS, hourly_from_calls, read_call_records
from db.features import load_holidays, load_hourly

HOURLY_FILE = "hourly.csv"
HOLIDAYS_FILE = "holidays.csv"
SOURCES_FILE = "sources.json"
MAX_DAYS_IN_ERROR = 10
# The line takes calls around the clock (about 27 between midnight and 3 AM
# on a normal day), so three empty hours at the very start or end of a file
# mean the export was cut part-way through a day.
EDGE_HOURS = 3
HOURS_PER_DAY = 24


@dataclass(frozen=True)
class Dataset:
    """hourly: one row per hour with calls. holidays: the holidays table.
    sources: one dict per data source, database first."""
    hourly: pd.DataFrame
    holidays: pd.DataFrame
    sources: tuple[dict, ...]


# =============================================================================
# Merging (pure)
# =============================================================================

def _daily_offered(hourly: pd.DataFrame) -> pd.Series:
    return hourly.groupby(hourly["hour_start"].dt.normalize())["offered"].sum()


def merge_hourly(db_hourly: pd.DataFrame, extra_hourly: pd.DataFrame) -> pd.DataFrame:
    """Return a NEW hourly frame: every database row, plus the rows of
    `extra_hourly` for days the database has no calls on."""
    db_days = _daily_offered(db_hourly)
    extra_days = _daily_offered(extra_hourly)
    shared = db_days.index.intersection(extra_days.index)
    conflicts = [day for day in shared if db_days[day] != extra_days[day]]
    if conflicts:
        shown = ", ".join(f"{day.date()} (database {db_days[day]}, file {extra_days[day]})"
                          for day in conflicts[:MAX_DAYS_IN_ERROR])
        raise ValueError(f"{len(conflicts)} day(s) differ between the database and the file: {shown}")

    is_new_day = ~extra_hourly["hour_start"].dt.normalize().isin(db_days.index)
    merged = pd.concat([db_hourly[list(HOURLY_COLUMNS)], extra_hourly.loc[is_new_day, list(HOURLY_COLUMNS)]],
                       ignore_index=True)
    return merged.sort_values("hour_start", kind="stable").reset_index(drop=True)


def missing_days(hourly: pd.DataFrame) -> pd.DatetimeIndex:
    """Calendar days between the first and last day that have no calls at
    all. The line is 24/7, so such a day is unreported data, not a quiet day."""
    present = pd.DatetimeIndex(hourly["hour_start"].dt.normalize().unique())
    every_day = pd.date_range(present.min(), present.max(), freq="D")
    return every_day.difference(present)


def partial_edge_days(hourly: pd.DataFrame) -> list[str]:
    """The first and/or last day of a file if it looks cut short: no call in
    the first EDGE_HOURS hours of the first day, or in the last EDGE_HOURS
    hours of the last day. A partial day merged as a whole day would be
    learned as a quiet day."""
    day = hourly["hour_start"].dt.normalize()
    hour = hourly["hour_start"].dt.hour
    first, last = day.min(), day.max()
    starts_late = hour[day == first].min() >= EDGE_HOURS
    stops_early = hour[day == last].max() < HOURS_PER_DAY - EDGE_HOURS
    flagged = ([first] if starts_late else []) + ([last] if stops_early else [])
    return [str(d.date()) for d in sorted(set(flagged))]


def describe_supplement(name: str, db_hourly: pd.DataFrame, extra_hourly: pd.DataFrame) -> dict:
    """What one supplemental file holds and how much of it is new."""
    db_days = _daily_offered(db_hourly).index
    extra_days = _daily_offered(extra_hourly)
    new = extra_days[~extra_days.index.isin(db_days)]
    return {
        "file": name,
        "calls": int(extra_days.sum()),
        "first_day": str(extra_days.index.min().date()),
        "last_day": str(extra_days.index.max().date()),
        "days_added": int(len(new)),
        "days_already_in_db": int(len(extra_days) - len(new)),
        "calls_added": int(new.sum()),
    }


# =============================================================================
# Loading
# =============================================================================

def _database_source(hourly: pd.DataFrame) -> dict:
    days = _daily_offered(hourly)
    return {"file": "database", "calls": int(days.sum()),
            "first_day": str(days.index.min().date()), "last_day": str(days.index.max().date()),
            "days": int(len(days))}


def load_dataset(dsn: str, supplement: list[Path] | tuple[Path, ...] = ()) -> Dataset:
    """Database rows (read-only) merged with each supplemental workbook in
    the order given. A later file never overrides an earlier source."""
    import psycopg  # local import: pure functions above need no driver

    with psycopg.connect(dsn) as conn:
        hourly = load_hourly(conn)[list(HOURLY_COLUMNS)]
        holidays = load_holidays(conn)

    sources = [_database_source(hourly)]
    for path in supplement:
        extra = hourly_from_calls(read_call_records(path))
        cut_short = partial_edge_days(extra)
        if cut_short:
            raise ValueError(f"{Path(path).name} starts or stops part-way through a day ({', '.join(cut_short)}); "
                             f"export whole days")
        sources.append(describe_supplement(Path(path).name, hourly, extra))
        hourly = merge_hourly(hourly, extra)
    return Dataset(hourly=hourly, holidays=holidays, sources=tuple(sources))


# =============================================================================
# Snapshot (local, under data/, never committed)
# =============================================================================

def save_snapshot(dataset: Dataset, folder: Path) -> None:
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    dataset.hourly.to_csv(folder / HOURLY_FILE, index=False)
    dataset.holidays.to_csv(folder / HOLIDAYS_FILE, index=False)
    (folder / SOURCES_FILE).write_text(json.dumps(list(dataset.sources), indent=2))


def load_snapshot(folder: Path) -> Dataset:
    folder = Path(folder)
    missing = [name for name in (HOURLY_FILE, HOLIDAYS_FILE, SOURCES_FILE) if not (folder / name).exists()]
    if missing:
        raise FileNotFoundError(f"no dataset snapshot in {folder} (missing {missing})")
    return Dataset(
        hourly=pd.read_csv(folder / HOURLY_FILE, parse_dates=["hour_start"]),
        holidays=pd.read_csv(folder / HOLIDAYS_FILE, parse_dates=["holiday_date"]),
        sources=tuple(json.loads((folder / SOURCES_FILE).read_text())),
    )


# =============================================================================
# CLI:  python -m db.dataset --supplement a.xlsx b.xlsx --snapshot data/cache/x
# =============================================================================

def main(argv: list[str] | None = None) -> int:
    import argparse
    import os
    import sys

    from dotenv import load_dotenv

    load_dotenv()
    parser = argparse.ArgumentParser(description="Build the training dataset and report what it holds.")
    parser.add_argument("--supplement", nargs="*", type=Path, default=[],
                        help="client call-record workbooks for days the database lacks")
    parser.add_argument("--snapshot", type=Path, default=None, help="folder to freeze the dataset into")
    args = parser.parse_args(argv)

    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")
    absent = [str(path) for path in args.supplement if not path.exists()]
    if absent:
        sys.exit(f"file not found: {absent}")

    dataset = load_dataset(dsn, args.supplement)
    print(json.dumps(list(dataset.sources), indent=2))
    gaps = missing_days(dataset.hourly)
    days = dataset.hourly["hour_start"].dt.normalize()
    print(f"total calls {int(dataset.hourly['offered'].sum()):,}  days {days.nunique():,}  "
          f"{days.min().date()} to {days.max().date()}  missing days {len(gaps)}")
    if len(gaps):
        print("first missing days:", [str(day.date()) for day in gaps[:MAX_DAYS_IN_ERROR]])
    if args.snapshot:
        save_snapshot(dataset, args.snapshot)
        print(f"snapshot saved to {args.snapshot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
