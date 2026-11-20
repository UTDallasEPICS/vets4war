"""The 11 official holidays of a year, derived by calendar rule.

    official_holidays(year) -> holiday_date, holiday_name in date order
    rule_mismatches(table)  -> rows of a holidays table the rules disagree with

The `holidays` table lists the 11 official holidays per year on their
calendar date (not the observed weekday). db.retrain checks every row
already in the table against these rules before each run (one row that
disagrees stops the run, nothing is guessed) and then adds the rule-derived
rows of the years the forecast needs. The four client holiday-type days
(db.holiday_calendar) are derived in code and are NOT stored in the table.
"""

from __future__ import annotations

import pandas as pd

from db.holiday_calendar import thanksgiving

MONDAY = 0                      # pandas dayofweek
DAYS_PER_WEEK = 7
LAST = -1
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
