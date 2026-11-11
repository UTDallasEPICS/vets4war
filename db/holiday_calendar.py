"""Holiday-type days: the holidays table plus four days the client asked for.

The shared `holidays` table lists the 11 official holidays per year. On
2026-11-10 the client asked the model to also treat these as holidays:

    Christmas Eve              December 24
    New Year's Eve             December 31
    Day Before Thanksgiving    Wednesday before the fourth Thursday of November
    Day After Thanksgiving     Friday after it

They are derived here by calendar rule, so nothing is written to the shared
table and they exist for any year, including years the table does not reach.

    thanksgiving(year)                     -> the fourth Thursday of November
    adjacent_days(years)                   -> the four client days per year
    holiday_type_days(holidays, y0, y1)    -> official + adjacent, with `kind`
"""

from __future__ import annotations

from collections.abc import Iterable

import pandas as pd

OFFICIAL = "official"
ADJACENT = "adjacent"

# `holiday_kind` feature codes. The order is FIXED: a trained model stores
# these numbers, so new names go at the end and nothing is ever reordered.
# 0 = not a holiday-type day; a name not listed here = OTHER_HOLIDAY.
KIND_NAMES = (
    "New Year's Day", "MLK Day", "Presidents Day", "Memorial Day", "Juneteenth",
    "Independence Day", "Labor Day", "Columbus Day", "Veterans Day", "Thanksgiving", "Christmas",
    "Day Before Thanksgiving", "Day After Thanksgiving", "Christmas Eve", "New Year's Eve",
)
NO_HOLIDAY = 0
OTHER_HOLIDAY = len(KIND_NAMES) + 1
UNNAMED = "Holiday"

# The two holidays on which the line is clearly and consistently quieter:
# 2021 to 2025, Christmas ran at 0.83 and Thanksgiving at 0.84 of a normal
# same weekday, below normal in every one of those years. Every other
# holiday-type day moved less and in no consistent direction.
MAJOR_HOLIDAYS = ("Thanksgiving", "Christmas")


def kind_code(name: str) -> int:
    """The `holiday_kind` code of a holiday name (1-based position in KIND_NAMES)."""
    return KIND_NAMES.index(name) + 1 if name in KIND_NAMES else OTHER_HOLIDAY

NOVEMBER = 11
DECEMBER = 12
THURSDAY = 3            # pandas dayofweek: Monday = 0
DAYS_PER_WEEK = 7
FOURTH = 4


def thanksgiving(year: int) -> pd.Timestamp:
    """The fourth Thursday of November."""
    first = pd.Timestamp(year=year, month=NOVEMBER, day=1)
    to_first_thursday = (THURSDAY - first.dayofweek) % DAYS_PER_WEEK
    return first + pd.Timedelta(days=to_first_thursday + DAYS_PER_WEEK * (FOURTH - 1))


def adjacent_days(years: Iterable[int]) -> pd.DataFrame:
    """holiday_date, holiday_name for the four client-requested days of
    every year in `years`, in date order."""
    rows = []
    for year in years:
        turkey = thanksgiving(year)
        rows += [
            (turkey - pd.Timedelta(days=1), "Day Before Thanksgiving"),
            (turkey + pd.Timedelta(days=1), "Day After Thanksgiving"),
            (pd.Timestamp(year=year, month=DECEMBER, day=24), "Christmas Eve"),
            (pd.Timestamp(year=year, month=DECEMBER, day=31), "New Year's Eve"),
        ]
    frame = pd.DataFrame(rows, columns=["holiday_date", "holiday_name"])
    return frame.sort_values("holiday_date").reset_index(drop=True)


def holiday_type_days(holidays: pd.DataFrame, first_year: int, last_year: int) -> pd.DataFrame:
    """A NEW frame: every row of `holidays` (kind = official) plus the
    client days of first_year..last_year (kind = adjacent). When both fall
    on one date the official row is kept."""
    names = holidays["holiday_name"].astype(str) if "holiday_name" in holidays.columns else UNNAMED
    official = pd.DataFrame({
        "holiday_date": pd.to_datetime(holidays["holiday_date"]).dt.normalize(),
        "holiday_name": names,
        "kind": OFFICIAL,
    }).drop_duplicates(subset="holiday_date")
    extra = adjacent_days(range(first_year, last_year + 1)).assign(kind=ADJACENT)
    extra = extra[~extra["holiday_date"].isin(official["holiday_date"])]
    combined = pd.concat([official, extra], ignore_index=True)
    return combined.sort_values("holiday_date", kind="stable").reset_index(drop=True)
