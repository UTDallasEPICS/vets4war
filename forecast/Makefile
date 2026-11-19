# Vets4Warriors staffing forecast: the batch side of the web app
#
#   make test                   the pytest suite
#   make retrain DB=/abs/app.db retrain the model and write the forecast into that database
#
# Override the interpreter:  make test PYTHON=.venv/bin/python
# Run from this folder (forecast/); the web app starts the same script itself.

PYTHON ?= .venv/bin/python
DB     ?=

.PHONY: test retrain

test:
	$(PYTHON) -m pytest tests -q

retrain:
	@test -n "$(DB)" || { echo "set DB to the absolute path of the SQLite file" >&2; exit 2; }
	$(PYTHON) -m db.retrain --db $(DB)
