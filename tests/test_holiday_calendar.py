"""Holiday-type days: the holidays table plus the four days the client asked for.

Hand-built frames, except the last test, which checks the calendar rule
against the real holidays table (skipped when V4W_DATABASE_URL is not set).
"""

import os

import pandas as pd
import pytest

from db.holiday_calendar import ADJACENT, OFFICIAL, adjacent_days, holiday_type_days, thanksgiving

OFFICIAL_2026 = pd.DataFrame({
    "holiday_date": pd.to_datetime(["2026-11-11", "2026-11-26", "2026-12-25"]),
    "holiday_name": ["Veterans Day", "Thanksgiving", "Christmas"],
})


@pytest.mark.parametrize("year, expected", [
    (2021, "2021-11-25"), (2022, "2022-11-24"), (2023, "2023-11-23"),
    (2024, "2024-11-28"), (2025, "2025-11-27"), (2026, "2026-11-26"), (2027, "2027-11-25"),
])
def test_thanksgiving_is_the_fourth_thursday_of_november(year, expected):
    assert thanksgiving(year) == pd.Timestamp(expected)


def test_the_four_client_days_of_one_year():
    days = adjacent_days([2026]).set_index("holiday_name")["holiday_date"]

    assert days.to_dict() == {
        "Day Before Thanksgiving": pd.Timestamp("2026-11-25"),
        "Day After Thanksgiving": pd.Timestamp("2026-11-27"),
        "Christmas Eve": pd.Timestamp("2026-12-24"),
        "New Year's Eve": pd.Timestamp("2026-12-31"),
    }


def test_adjacent_days_cover_every_year_asked_for():
    assert len(adjacent_days(range(2021, 2027))) == 6 * 4


def test_holiday_type_days_are_official_plus_adjacent_in_date_order():
    days = holiday_type_days(OFFICIAL_2026, first_year=2026, last_year=2026)

    assert days["holiday_date"].is_monotonic_increasing
    assert days["kind"].value_counts().to_dict() == {ADJACENT: 4, OFFICIAL: 3}
    assert days.loc[days["holiday_name"] == "Christmas Eve", "kind"].item() == ADJACENT
    assert days.loc[days["holiday_name"] == "Thanksgiving", "kind"].item() == OFFICIAL


def test_an_official_holiday_wins_when_a_client_day_falls_on_it():
    official = pd.DataFrame({
        "holiday_date": pd.to_datetime(["2026-12-24"]),
        "holiday_name": ["Christmas Eve (observed)"],
    })

    days = holiday_type_days(official, first_year=2026, last_year=2026)

    on_the_24th = days[days["holiday_date"] == pd.Timestamp("2026-12-24")]
    assert on_the_24th["holiday_name"].tolist() == ["Christmas Eve (observed)"]
    assert on_the_24th["kind"].tolist() == [OFFICIAL]


def test_new_years_eve_exists_even_when_the_table_stops_at_christmas():
    days = holiday_type_days(OFFICIAL_2026, first_year=2026, last_year=2026)

    assert pd.Timestamp("2026-12-31") in set(days["holiday_date"])


def test_holiday_type_days_does_not_change_the_table_it_is_given():
    before = OFFICIAL_2026.copy()

    holiday_type_days(OFFICIAL_2026, first_year=2026, last_year=2026)

    pd.testing.assert_frame_equal(OFFICIAL_2026, before)


def test_the_rule_matches_every_thanksgiving_in_the_real_table():
    from db.features import load_holidays  # importing it loads .env

    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        pytest.skip("V4W_DATABASE_URL is not set")
    import psycopg

    with psycopg.connect(dsn) as conn:
        holidays = load_holidays(conn)
    table = holidays[holidays["holiday_name"] == "Thanksgiving"]

    assert len(table) > 0
    for date in table["holiday_date"]:
        assert thanksgiving(date.year) == date
