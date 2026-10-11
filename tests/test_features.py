"""Tests for db/features.py against the real calls table.

Needs V4W_DATABASE_URL (loaded via dotenv). No synthetic input: the only
data source is the database. If the connection fails, the test run fails.

Run from the repo root:  python -m pytest tests/test_features.py -v
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from db.features import build_features, load_holidays, load_hourly  # noqa: E402

import psycopg  # noqa: E402

UNIT_CIRCLE_TOLERANCE = 1e-9


@pytest.fixture(scope="module")
def hourly_and_holidays():
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        pytest.skip("V4W_DATABASE_URL is not set; feature tests need the database")
    with psycopg.connect(dsn) as conn:
        hourly = load_hourly(conn)
        holidays = load_holidays(conn)
    return hourly, holidays


@pytest.fixture(scope="module")
def featured(hourly_and_holidays):
    hourly, holidays = hourly_and_holidays
    return build_features(hourly, holidays)


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
