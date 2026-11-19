"""db.load_week.parse_call_records: partner Excel rows -> `calls` rows.
Pure parsing only; no database is touched here."""

import pandas as pd
import pytest

from db.load_week import CALLS_COLUMNS, parse_call_records


def _raw(**overrides) -> pd.DataFrame:
    """Two synthetic calls in the partner layout, out of time order."""
    base = {
        "Skill_Name": ["Vets4Warriors_Call", "Vets4Warriors_Call"],
        "Start_Date": [pd.Timestamp("2026-01-02"), pd.Timestamp("2026-01-01")],
        "start_time": ["00:05:00", "23:59:30"],
        "InQueue": [12, 40],
        "Agent_Time": [300, 0],
        "Abandon_Time": [0, 40],
        "Routing_Time": [11, 39],
        "Abandon": ["N", "Y"],
    }
    return pd.DataFrame({**base, **overrides})


def test_columns_match_calls_table_order():
    assert tuple(parse_call_records(_raw()).columns) == CALLS_COLUMNS


def test_date_and_time_combine_and_rows_sort_by_start():
    parsed = parse_call_records(_raw())
    assert parsed["start_ts"].tolist() == [
        pd.Timestamp("2026-01-01 23:59:30"),
        pd.Timestamp("2026-01-02 00:05:00"),
    ]


def test_seconds_and_abandon_flag_map_to_the_right_call():
    parsed = parse_call_records(_raw())
    abandoned = parsed.iloc[0]
    answered = parsed.iloc[1]
    assert bool(abandoned["abandoned"]) is True and abandoned["abandon_sec"] == 40.0
    assert bool(answered["abandoned"]) is False and answered["agent_sec"] == 300.0
    assert answered["in_queue_sec"] == 12.0 and answered["routing_sec"] == 11.0


def test_input_is_not_mutated():
    raw = _raw()
    before = raw.copy()
    parse_call_records(raw)
    pd.testing.assert_frame_equal(raw, before)


def test_missing_column_is_rejected():
    with pytest.raises(ValueError, match="missing columns"):
        parse_call_records(_raw().drop(columns="Abandon"))


def test_unknown_abandon_flag_is_rejected():
    with pytest.raises(ValueError, match="Y or N"):
        parse_call_records(_raw(Abandon=["N", "maybe"]))


def test_bad_time_is_rejected_with_excel_row():
    with pytest.raises(ValueError, match=r"Excel rows \[3\]"):
        parse_call_records(_raw(start_time=["00:05:00", "not a time"]))


def test_negative_seconds_are_rejected():
    with pytest.raises(ValueError, match="negative"):
        parse_call_records(_raw(InQueue=[-1, 40]))


def test_empty_file_is_rejected():
    with pytest.raises(ValueError, match="no call rows"):
        parse_call_records(_raw().iloc[0:0])
