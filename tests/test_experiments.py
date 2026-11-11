"""Candidate families of the improvement loop: every family must offer
valid, distinct, uniquely labelled configurations."""

import pytest

from db.experiments import EXPERIMENTS, candidates, legacy_equivalent
from db.legacy import LEGACY_FEATURES
from db.procedure import ProcedureConfig


def test_legacy_equivalent_mirrors_the_oct_28_settings_in_the_new_procedure():
    config = legacy_equivalent()

    assert config.base.features == LEGACY_FEATURES
    assert config.base.halflife_days == 730.0
    assert (config.calibration.level_window_days, config.calibration.level_cap) == (7, 0.15)
    assert config.calibration.dow_strength is None
    assert config.calibration.hour_strength is None
    assert config.calibration.cell_strength is None


@pytest.mark.parametrize("name", sorted(EXPERIMENTS))
def test_every_family_offers_valid_distinct_candidates(name):
    offered = candidates(name, legacy_equivalent())

    labels = [label for label, _ in offered]
    configs = [config for _, config in offered]
    assert len(offered) >= 1
    assert len(set(labels)) == len(labels)
    assert all(isinstance(config, ProcedureConfig) for config in configs)
    assert len(set(configs)) == len(configs)


def test_an_unknown_family_raises_with_the_known_names():
    with pytest.raises(ValueError, match="level_window"):
        candidates("no-such-family", legacy_equivalent())
