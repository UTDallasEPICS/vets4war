"""Holiday features of db.features.build_features, including the four
client-requested days. Hand-built frames; no database."""

import pandas as pd
import pytest

from db.diagnostics import special_day_mape
from db.features import build_features
from db.holiday_calendar import KIND_NAMES, NO_HOLIDAY, OTHER_HOLIDAY, kind_code

HOURS = 24
HOLIDAYS = pd.DataFrame({
    "holiday_date": pd.to_datetime(["2025-11-27", "2025-12-25", "2026-11-26", "2026-12-25"]),
    "holiday_name": ["Thanksgiving", "Christmas", "Thanksgiving", "Christmas"],
})


def _featured(first: str, last: str, holidays: pd.DataFrame = HOLIDAYS) -> pd.DataFrame:
    hours = pd.date_range(first, pd.Timestamp(last) + pd.Timedelta(hours=23), freq="h")
    return build_features(pd.DataFrame({"hour_start": hours, "offered": 1}), holidays)


def _on(featured: pd.DataFrame, day: str) -> pd.DataFrame:
    return featured[featured["hour_start"].dt.normalize() == pd.Timestamp(day)]


def test_official_flag_still_marks_only_the_table_holidays():
    featured = _featured("2026-11-20", "2026-12-31")

    flagged = sorted(featured.loc[featured["is_holiday"] == 1, "hour_start"].dt.strftime("%Y-%m-%d").unique())

    assert flagged == ["2026-11-26", "2026-12-25"]


def test_adjacent_flag_marks_the_four_client_days_for_all_24_hours():
    featured = _featured("2026-11-20", "2026-12-31")

    flagged = featured.loc[featured["is_holiday_adjacent"] == 1, "hour_start"].dt.strftime("%Y-%m-%d").value_counts()

    assert flagged.to_dict() == {"2026-11-25": HOURS, "2026-11-27": HOURS, "2026-12-24": HOURS, "2026-12-31": HOURS}


def test_holiday_kind_names_the_day_and_is_zero_on_ordinary_days():
    featured = _featured("2026-11-20", "2026-12-31")

    assert (_on(featured, "2026-11-26")["holiday_kind"] == kind_code("Thanksgiving")).all()
    assert (_on(featured, "2026-11-25")["holiday_kind"] == kind_code("Day Before Thanksgiving")).all()
    assert (_on(featured, "2026-12-24")["holiday_kind"] == kind_code("Christmas Eve")).all()
    assert (_on(featured, "2026-12-01")["holiday_kind"] == NO_HOLIDAY).all()


def test_major_holiday_flag_marks_thanksgiving_and_christmas_only():
    holidays = pd.concat([HOLIDAYS, pd.DataFrame({"holiday_date": pd.to_datetime(["2026-11-11"]),
                                                  "holiday_name": ["Veterans Day"]})], ignore_index=True)
    featured = _featured("2026-11-01", "2026-12-31", holidays)

    flagged = sorted(featured.loc[featured["is_major_holiday"] == 1, "hour_start"].dt.strftime("%Y-%m-%d").unique())

    assert flagged == ["2026-11-26", "2026-12-25"]
    assert (_on(featured, "2026-11-11")["is_holiday"] == 1).all()


def test_the_same_holiday_has_the_same_kind_every_year():
    featured = _featured("2025-11-20", "2026-12-31")

    assert _on(featured, "2025-11-28")["holiday_kind"].iloc[0] == _on(featured, "2026-11-27")["holiday_kind"].iloc[0]
    assert _on(featured, "2025-12-25")["holiday_kind"].iloc[0] == _on(featured, "2026-12-25")["holiday_kind"].iloc[0]


def test_new_years_eve_is_marked_although_the_table_stops_at_christmas():
    featured = _featured("2026-12-26", "2026-12-31")

    assert (_on(featured, "2026-12-31")["is_holiday_adjacent"] == 1).all()
    assert (_on(featured, "2026-12-31")["holiday_kind"] == kind_code("New Year's Eve")).all()


def test_kind_codes_are_distinct_fixed_and_leave_zero_for_no_holiday():
    codes = [kind_code(name) for name in KIND_NAMES]

    assert len(set(codes)) == len(KIND_NAMES) == 15
    assert NO_HOLIDAY == 0 and NO_HOLIDAY not in codes and OTHER_HOLIDAY not in codes
    assert kind_code("Thanksgiving") == KIND_NAMES.index("Thanksgiving") + 1


def test_a_holiday_name_the_model_has_never_seen_gets_the_other_code():
    holidays = pd.DataFrame({"holiday_date": pd.to_datetime(["2026-12-03"]), "holiday_name": ["Founders Day"]})

    featured = _featured("2026-12-01", "2026-12-05", holidays)

    assert (_on(featured, "2026-12-03")["holiday_kind"] == OTHER_HOLIDAY).all()
    assert kind_code("Founders Day") == OTHER_HOLIDAY


def test_a_table_without_names_still_gives_every_holiday_feature():
    featured = _featured("2026-11-20", "2026-11-30", HOLIDAYS[["holiday_date"]])

    assert (_on(featured, "2026-11-26")["is_holiday"] == 1).all()
    assert (_on(featured, "2026-11-26")["holiday_kind"] == OTHER_HOLIDAY).all()
    assert (_on(featured, "2026-11-25")["is_holiday_adjacent"] == 1).all()


def test_holiday_features_keep_rows_and_have_no_gaps():
    featured = _featured("2026-11-20", "2026-12-31")

    assert len(featured) == 42 * HOURS
    assert featured[["is_holiday", "is_holiday_adjacent", "holiday_kind", "days_to_nearest_holiday"]].isna().sum().sum() == 0


# ---- special-day error -----------------------------------------------------------------

def test_special_day_error_counts_only_the_special_days():
    hours = pd.date_range("2026-11-24", periods=4 * HOURS, freq="h")
    is_eve = hours.normalize() == pd.Timestamp("2026-11-25")
    predictions = pd.DataFrame({"origin": pd.Timestamp("2026-11-23"), "hour_start": hours,
                                "horizon_day": (pd.RangeIndex(4 * HOURS) // HOURS) + 1, "actual": 10.0,
                                "predicted": [12.0 if eve else 20.0 for eve in is_eve]})

    result = special_day_mape(predictions, frozenset({pd.Timestamp("2026-11-25")}))

    assert result == {"days": 1, "daily_mape": pytest.approx(20.0)}


def test_special_day_error_is_empty_when_no_special_day_was_predicted():
    hours = pd.date_range("2026-06-02", periods=HOURS, freq="h")
    predictions = pd.DataFrame({"origin": pd.Timestamp("2026-06-01"), "hour_start": hours, "horizon_day": 1,
                                "actual": 10.0, "predicted": 10.0})

    result = special_day_mape(predictions, frozenset({pd.Timestamp("2026-11-25")}))

    assert result["days"] == 0


# ---- calendar features added for the final run ---------------------------------------

def test_hour_of_week_counts_from_monday_midnight():
    featured = _featured("2026-11-02", "2026-11-08")          # Monday to Sunday

    assert featured["hour_of_week"].tolist() == list(range(7 * HOURS))


def test_day_of_month_and_payday_window():
    featured = _featured("2026-11-01", "2026-11-30")
    days_in_window = sorted(featured.loc[featured["is_payday_window"] == 1, "hour_start"].dt.day.unique())

    assert featured["day_of_month"].min() == 1 and featured["day_of_month"].max() == 30
    assert days_in_window == [1, 2, 3, 14, 15, 16]


def test_yearly_cycle_features_return_to_the_same_value_a_year_later_and_sit_on_the_unit_circle():
    featured = _featured("2025-11-20", "2026-11-20")
    first, last = featured.iloc[0], featured.iloc[-HOURS]

    assert first["doy_sin"] == pytest.approx(last["doy_sin"], abs=0.02)
    assert first["doy_cos"] == pytest.approx(last["doy_cos"], abs=0.02)
    assert (featured["doy_sin"] ** 2 + featured["doy_cos"] ** 2).to_numpy() == pytest.approx(1.0)
    assert (featured["doy_sin2"] ** 2 + featured["doy_cos2"] ** 2).to_numpy() == pytest.approx(1.0)
