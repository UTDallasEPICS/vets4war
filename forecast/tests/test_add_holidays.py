"""Official holidays by calendar rule, and the multipliers the table keeps
for dates not reached yet. Hand-built frames, except the last test (real
table; skipped without V4W_DATABASE_URL)."""

import os

import pandas as pd
import pytest

from db.add_holidays import official_holidays, rule_mismatches

DATES_2026 = {
    "New Year's Day": "2026-01-01", "MLK Day": "2026-01-19", "Presidents Day": "2026-02-16",
    "Memorial Day": "2026-05-25", "Juneteenth": "2026-06-19", "Independence Day": "2026-07-04",
    "Labor Day": "2026-09-07", "Columbus Day": "2026-10-12", "Veterans Day": "2026-11-11",
    "Thanksgiving": "2026-11-26", "Christmas": "2026-12-25",
}
DATES_2027 = {
    "New Year's Day": "2027-01-01", "MLK Day": "2027-01-18", "Presidents Day": "2027-02-15",
    "Memorial Day": "2027-05-31", "Juneteenth": "2027-06-19", "Independence Day": "2027-07-04",
    "Labor Day": "2027-09-06", "Columbus Day": "2027-10-11", "Veterans Day": "2027-11-11",
    "Thanksgiving": "2027-11-25", "Christmas": "2027-12-25",
}


@pytest.mark.parametrize("year, expected", [(2026, DATES_2026), (2027, DATES_2027)])
def test_the_eleven_official_holidays_of_a_year(year, expected):
    holidays = official_holidays(year)

    assert dict(zip(holidays["holiday_name"], holidays["holiday_date"].dt.strftime("%Y-%m-%d"))) == expected
    assert holidays["holiday_date"].is_monotonic_increasing


def test_a_table_row_on_a_different_date_than_the_rule_is_reported():
    table = official_holidays(2026)
    moved = table.assign(holiday_date=table["holiday_date"].where(table["holiday_name"] != "Labor Day",
                                                                  pd.Timestamp("2026-09-08")))

    assert rule_mismatches(table) == []
    assert rule_mismatches(moved) == ["Labor Day 2026: table 2026-09-08, rule 2026-09-07"]


def test_the_rules_reproduce_every_row_of_the_real_table():
    from db.features import load_holidays  # importing it loads .env

    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        pytest.skip("V4W_DATABASE_URL is not set")
    import psycopg

    with psycopg.connect(dsn) as conn:
        table = load_holidays(conn)

    assert len(table) >= 66
    assert rule_mismatches(table) == []
