"""Add one year of official holidays to the shared `holidays` table.

    python -m db.add_holidays 2027            # dry run: prints the rows
    python -m db.add_holidays 2027 --commit   # inserts them

The table lists 11 official holidays per year on their calendar date (not
the observed weekday). official_holidays() derives them by rule, and before
anything is written the rules are checked against every row already in the
table: if one row disagrees, nothing is inserted.

Multipliers. The table keeps a measured volume and evening multiplier per
holiday; for dates not reached yet it carries the mean of that holiday's
measured years (2026-12-25 held the mean of Christmas 2021 to 2025 when
this was written). New rows follow the same convention, with "measured" =
dated on or before the last day of call data. The volume model does not
read these columns (it learns holiday effects from the calls).

Safety: dry run by default; refuses a year that already has rows; only
INSERT, the schema is never altered. The four client holiday-type days
(db.holiday_calendar) are derived in code and are NOT stored here.
"""

from __future__ import annotations

import argparse
import os
import sys

import pandas as pd
from dotenv import load_dotenv

from db.holiday_calendar import thanksgiving

load_dotenv()

MONDAY = 0                      # pandas dayofweek
DAYS_PER_WEEK = 7
LAST = -1
MULTIPLIER_COLUMNS = ("volume_multiplier", "evening_multiplier")
MULTIPLIER_DECIMALS = 3
FIXED_DATES = {"New Year's Day": (1, 1), "Juneteenth": (6, 19), "Independence Day": (7, 4),
               "Veterans Day": (11, 11), "Christmas": (12, 25)}
# name -> (month, which Monday); LAST = the last Monday of the month
MONDAY_RULES = {"MLK Day": (1, 3), "Presidents Day": (2, 3), "Memorial Day": (5, LAST),
                "Labor Day": (9, 1), "Columbus Day": (10, 2)}


def _nth_monday(year: int, month: int, nth: int) -> pd.Timestamp:
    first = pd.Timestamp(year=year, month=month, day=1)
    first_monday = first + pd.Timedelta(days=(MONDAY - first.dayofweek) % DAYS_PER_WEEK)
    if nth != LAST:
        return first_monday + pd.Timedelta(days=DAYS_PER_WEEK * (nth - 1))
    mondays = pd.date_range(first_monday, first + pd.offsets.MonthEnd(0), freq="7D")
    return mondays[-1]


def official_holidays(year: int) -> pd.DataFrame:
    """holiday_date, holiday_name for the 11 official holidays, in date order."""
    rows = [(pd.Timestamp(year=year, month=month, day=day), name) for name, (month, day) in FIXED_DATES.items()]
    rows += [(_nth_monday(year, month, nth), name) for name, (month, nth) in MONDAY_RULES.items()]
    rows.append((thanksgiving(year), "Thanksgiving"))
    frame = pd.DataFrame(rows, columns=["holiday_date", "holiday_name"])
    return frame.sort_values("holiday_date").reset_index(drop=True)


def rule_mismatches(table: pd.DataFrame) -> list[str]:
    """Rows of `table` whose date differs from the rule for that name and
    year, as readable strings. Empty = the rules reproduce the table."""
    dates = pd.to_datetime(table["holiday_date"])
    problems = []
    for year in sorted(dates.dt.year.unique()):
        by_rule = official_holidays(int(year)).set_index("holiday_name")["holiday_date"]
        for name, date in zip(table.loc[dates.dt.year == year, "holiday_name"], dates[dates.dt.year == year]):
            if name not in by_rule.index or by_rule[name] != date:
                expected = by_rule[name].date() if name in by_rule.index else "no rule"
                problems.append(f"{name} {year}: table {date.date()}, rule {expected}")
    return problems


def future_multipliers(table: pd.DataFrame, last_data_day: pd.Timestamp) -> pd.DataFrame:
    """Per holiday name, the mean multipliers over the rows already measured
    (dated on or before `last_data_day`)."""
    measured = table[pd.to_datetime(table["holiday_date"]) <= pd.Timestamp(last_data_day)]
    return measured.groupby("holiday_name", as_index=False)[list(MULTIPLIER_COLUMNS)].mean()


def new_rows(table: pd.DataFrame, year: int, last_data_day: pd.Timestamp) -> pd.DataFrame:
    """The rows to insert for `year`. Raises if the year is already there or
    the rules do not reproduce the existing table."""
    if (pd.to_datetime(table["holiday_date"]).dt.year == year).any():
        raise ValueError(f"the holidays table already has rows for {year}")
    problems = rule_mismatches(table)
    if problems:
        raise ValueError(f"the calendar rules do not reproduce the table: {problems[:5]}")
    rows = official_holidays(year).merge(future_multipliers(table, last_data_day), on="holiday_name", how="left")
    if rows[list(MULTIPLIER_COLUMNS)].isna().any().any():
        raise ValueError("a holiday has no measured year to take its multipliers from")
    # The table stores three decimals.
    return rows.assign(**{column: rows[column].round(MULTIPLIER_DECIMALS) for column in MULTIPLIER_COLUMNS})


def main(argv: list[str] | None = None) -> int:
    import psycopg

    from db.features import load_holidays

    parser = argparse.ArgumentParser(description="Add one year of official holidays to the holidays table.")
    parser.add_argument("year", type=int)
    parser.add_argument("--commit", action="store_true", help="insert the rows (default: dry run)")
    args = parser.parse_args(argv)
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")

    with psycopg.connect(dsn) as conn:
        table = load_holidays(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT max(start_ts)::date FROM calls")
            last_data_day = pd.Timestamp(cur.fetchone()[0])
            rows = new_rows(table, args.year, last_data_day)
            print(rows.assign(holiday_date=rows["holiday_date"].dt.strftime("%Y-%m-%d")).round(3).to_string(index=False))
            if args.commit:
                cur.executemany(
                    "INSERT INTO holidays (holiday_date, holiday_name, volume_multiplier, evening_multiplier) "
                    "VALUES (%s, %s, %s, %s)",
                    [(r.holiday_date.date(), r.holiday_name, float(r.volume_multiplier), float(r.evening_multiplier))
                     for r in rows.itertuples(index=False)],
                )
    print(f"{'inserted' if args.commit else 'dry run: would insert'} {len(rows)} rows for {args.year} "
          f"(multipliers = mean of years measured up to {last_data_day.date()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
