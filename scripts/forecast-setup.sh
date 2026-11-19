#!/usr/bin/env bash
# Create forecast/.venv (Python 3.12) with the pinned requirements.
#   bash scripts/forecast-setup.sh [requirements file, relative to forecast/]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../forecast"
REQUIREMENTS="${1:-requirements.txt}"
if command -v uv >/dev/null 2>&1; then
  [ -d .venv ] || uv venv --quiet --python 3.12 .venv
  uv pip install --quiet --python .venv/bin/python -r "$REQUIREMENTS"
else
  PYTHON="$(command -v python3.12 || true)"
  [ -n "$PYTHON" ] || { echo "Python 3.12 is required (or install uv)" >&2; exit 1; }
  [ -d .venv ] || "$PYTHON" -m venv .venv
  .venv/bin/pip install --disable-pip-version-check --quiet -r "$REQUIREMENTS"
fi
.venv/bin/python -c "import sys; assert sys.version_info[:2] == (3, 12), sys.version; print('forecast/.venv ready: Python', sys.version.split()[0])"
