"""Run admin DOM/auth/API interaction scenarios through Node, without a real tenant."""
from pathlib import Path
import shutil
import subprocess

import pytest


def test_admin_interactions():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for admin interaction checks")
    result = subprocess.run([node, str(Path(__file__).with_name("admin_checks.js"))],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Admin checks passed" in result.stdout
