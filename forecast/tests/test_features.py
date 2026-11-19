"""db/features.py on the hourly grain read from a migrated database.

The database holds SYNTHETIC calls (tests/conftest.py, seeded_db) and the
official holidays of their year.
"""

import numpy as np
import pandas as pd
import pytest

from conftest import SEEDED_DAYS
from db import store
from db.features import build_features, load_holidays, load_hourly

UNIT_CIRCLE_TOLERANCE = 1e-9


@pytest.fixture(scope="module")
def hourly_and_holidays(seeded_db):
    conn = store.connect(seeded_db, readonly=True)
    try:
        return load_hourly(conn), load_holidays(conn)
    finally:
        conn.close()


@pytest.fixture(scope="module")
def featured(hourly_and_holidays):
    hourly, holidays = hourly_and_holidays
    return build_features(hourly, holidays)


def test_hourly_counts_every_call_once(seeded_db, hourly_and_holidays):
    hourly, _ = hourly_and_holidays
    calls = store.read_snapshot(store.connect(seeded_db, readonly=True)).calls

    assert hourly["offered"].sum() == len(calls)
    assert hourly["hour_start"].is_monotonic_increasing
    assert hourly["hour_start"].dt.normalize().nunique() == SEEDED_DAYS


def test_an_empty_calls_table_is_refused(migrated_db):
    with pytest.raises(ValueError, match="empty"):
        load_hourly(store.connect(migrated_db))


def test_no_nulls_in_any_column(featured):
    # Act
    null_counts = featured.isna().sum()

    # Assert
    assert null_counts.sum() == 0, null_counts[null_counts > 0]


def test_row_count_unchanged(hourly_and_holidays, featured):
    # Arrange
    hourly, _ = hourly_and_holidays

    # Assert
    assert len(featured) == len(hourly)
    assert featured.index.equals(hourly.index)


def test_hour_encoding_on_unit_circle(featured):
    # Act
    radius_sq = featured["hour_sin"] ** 2 + featured["hour_cos"] ** 2

    # Assert
    assert np.allclose(radius_sq, 1.0, atol=UNIT_CIRCLE_TOLERANCE)


def test_is_holiday_sums_to_plausible_count(hourly_and_holidays, featured):
    # Arrange: holidays that fall inside the data's date range
    hourly, holidays = hourly_and_holidays
    lo = hourly["hour_start"].min().normalize()
    hi = hourly["hour_start"].max().normalize()
    in_range = holidays["holiday_date"].between(lo, hi).sum()

    # Act
    flagged_hours = int(featured["is_holiday"].sum())

    # Assert: at least half of each holiday's hours have calls, never more
    # than every hour of every in-range holiday.
    assert in_range > 0
    assert in_range * 12 <= flagged_hours <= in_range * 24, (
        f"{flagged_hours} flagged hours for {in_range} in-range holidays"
    )


def test_holidays_come_from_the_table_as_dates(hourly_and_holidays):
    _, holidays = hourly_and_holidays

    assert pd.api.types.is_datetime64_any_dtype(holidays["holiday_date"])
    assert len(holidays) == 11
