# Vets4Warriors staffing forecast
#
#   make db-check   connect with $V4W_DATABASE_URL and print row counts
#   make train      rolling-origin backtest, then save models/volume_lgbm.txt
#   make serve      FastAPI on http://127.0.0.1:8000 (serves web/index.html)
#
# Override the interpreter:  make train PYTHON=.venv/bin/python
# All targets run from the repo root; models/ and web/ are relative paths.

PYTHON ?= python3
HOST   ?= 127.0.0.1
PORT   ?= 8000

.PHONY: db-check train serve test

db-check:
	$(PYTHON) -c "\
import os, sys; \
from dotenv import load_dotenv; load_dotenv(); \
import psycopg; \
dsn = os.environ.get('V4W_DATABASE_URL') or sys.exit('V4W_DATABASE_URL is not set'); \
conn = psycopg.connect(dsn); cur = conn.cursor(); \
cur.execute('select count(*), min(start_ts), max(start_ts) from calls');              print('calls         ', cur.fetchone()); \
cur.execute('select count(*) from holidays');                                         print('holidays      ', cur.fetchone()); \
cur.execute('select count(distinct date_trunc(%s, start_ts)) from calls', ('hour',)); print('hours w/ calls', cur.fetchone()); \
conn.close()"

train:
	$(PYTHON) -m db.train

serve:
	$(PYTHON) -m uvicorn api.main:app --host $(HOST) --port $(PORT) --reload

test:
	$(PYTHON) -m pytest tests -q
