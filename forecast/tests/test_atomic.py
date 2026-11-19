"""Files are replaced whole or not at all."""

import pytest

from db.atomic import atomic_write


def test_content_lands_under_the_final_name_and_no_temp_file_is_left(tmp_path):
    target = tmp_path / "sub" / "ledger.json"

    atomic_write(target, lambda tmp: tmp.write_text("new"))

    assert target.read_text() == "new"
    assert [p.name for p in target.parent.iterdir()] == ["ledger.json"]


def test_a_failed_write_leaves_the_old_file_untouched(tmp_path):
    target = tmp_path / "ledger.json"
    target.write_text("old")

    def half_written(tmp):
        tmp.write_text("half")
        raise OSError("disk full")

    with pytest.raises(OSError, match="disk full"):
        atomic_write(target, half_written)

    assert target.read_text() == "old"
    assert [p.name for p in tmp_path.iterdir()] == ["ledger.json"]
