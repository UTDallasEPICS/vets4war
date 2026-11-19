"""Tests for db/real_calls.py: the share of calls with over 2 minutes of talk time.

The arithmetic is tested on small hand-made frames with no database. One test
reads the shared database (read-only) to check the SQL's definition of a real
call against a direct count.

Run from the repo root:  python -m pytest tests/test_real_calls.py -v
"""

import os

import pandas as pd
import psycopg
import pytest
from dotenv import load_dotenv

from db.real_calls import MIN_CELL_CALLS, REAL_CALL_MIN_TALK_SEC, estimate_real_share, real_share_table

load_dotenv()


def _rows(*rows):
    return pd.DataFrame(rows, columns=["call_date", "dow", "call_hour", "n_calls", "n_real"]).assign(
        call_date=lambda f: pd.to_datetime(f["call_date"]))


def test_real_call_threshold_is_two_minutes():
    assert REAL_CALL_MIN_TALK_SEC == 120


def test_share_is_real_calls_over_all_calls_in_the_cell():
    # Arrange
    rows = _rows(("2026-10-05", 1, 9, 40, 10))

    # Act
    table = real_share_table(rows, halflife_days=None)

    # Assert
    assert table[(1, 9)] == pytest.approx(0.25)


def test_recent_calls_count_more_with_a_halflife():
    # Arrange: the older day (one halflife back) weighs half the newer day.
    rows = _rows(("2026-10-05", 1, 9, 40, 0), ("2026-10-12", 1, 9, 40, 40))

    # Act
    table = real_share_table(rows, halflife_days=7)

    # Assert: (0 * 0.5 + 40 * 1) / (40 * 0.5 + 40 * 1) = 2/3
    assert table[(1, 9)] == pytest.approx(2 / 3)


def test_thin_cell_falls_back_to_the_overall_share():
    # Arrange
    rows = _rows(("2026-10-05", 1, 9, MIN_CELL_CALLS - 1, 0), ("2026-10-05", 2, 9, 100, 50))

    # Act
    table = real_share_table(rows, halflife_days=None)

    # Assert
    expected = 50 / (MIN_CELL_CALLS - 1 + 100)
    assert table[(1, 9)] == pytest.approx(expected)
    assert table[(2, 9)] == pytest.approx(0.5)


def test_table_covers_every_weekday_and_hour():
    table = real_share_table(_rows(("2026-10-05", 1, 9, 40, 10)), halflife_days=None)
    assert set(table) == {(dow, hour) for dow in range(1, 8) for hour in range(24)}


def test_no_calls_raises_instead_of_inventing_a_share():
    with pytest.raises(ValueError):
        real_share_table(_rows(), halflife_days=None)


@pytest.mark.skipif(not os.environ.get("V4W_DATABASE_URL"), reason="V4W_DATABASE_URL is not set")
def test_unweighted_shares_match_a_direct_count_in_the_database():
    # Arrange
    sql = """SELECT count(*)::float, count(*) FILTER (WHERE NOT abandoned AND agent_sec > 120)::float
             FROM calls WHERE extract(isodow FROM start_ts) = 1 AND extract(hour FROM start_ts) = 20"""

    # Act
    with psycopg.connect(os.environ["V4W_DATABASE_URL"]) as conn:
        table = estimate_real_share(conn, None)
        total, real = conn.execute(sql).fetchone()

    # Assert
    assert table[(1, 20)] == pytest.approx(real / total)
