# Forecast performance monitoring — Milestone 1

`python -m db.monitor` performs **retrospective_replay** of the existing volume
model. It reads PostgreSQL and prints one structured JSON report to stdout.
It does not import calls, archive contemporaneous forecasts, train models,
change staffing calculations, or write database objects. A successful replay
does not establish what the dashboard predicted at an earlier time.

## Local invocation

Use the existing Python environment and requirements. Set `V4W_DATABASE_URL`
through the process environment or the application's existing dotenv setup.
Use a database account restricted to SELECT. The command additionally requests
a read-only, repeatable-read transaction and a 15-second connection timeout.
Do not put connection strings on command lines or in reports.

```powershell
python -m db.monitor --help
python -m db.monitor --start 2026-09-01 --end 2026-09-14
python -m db.monitor --start 2026-09-01 --end 2026-09-14 --completeness C:/private/completeness.json > C:/private/monitor-report.json
```

The second invocation deliberately withholds metrics because completeness
evidence is absent. Run from the repository root. Model paths default to
`models/volume_lgbm.txt` and `models/metadata.json`; `--model` and `--metadata`
allow an explicitly paired deployed artifact bundle. No artifacts are changed.

The loader validates metadata dates, target, feature names/order, and an
optional metadata `model_sha256`. Both artifact hashes are reported. Existing
metadata has no binding model hash, so exact training-run pairing cannot be
proven; the report explicitly warns about this. Operators must supply the
matching deployed pair. Local files alone do not prove which model is deployed.

## Establishing completeness

The repository has no import ledger or authoritative completeness watermark.
Neither a maximum timestamp nor an occupied hourly bin proves a complete
import. Metrics therefore require a loader/operator JSON attestation:

```json
{
  "complete_start": "2026-09-01",
  "complete_end": "2026-09-14",
  "timezone": "Eastern naive wall-clock",
  "source": "partner export batch identifier",
  "evidence": "reference to reconciled export and successful import record",
  "offered_count": 2520
}
```

The count above is illustrative. Use the authoritative source's actual count
for exactly these full dates, after validating import completion, duplicates,
and corrections. Keep this evidence outside the repository. The command
checks the fields, exact effective dates, and database offered-count agreement
in its read snapshot. It cannot independently authenticate an attestation;
matching counts cannot detect compensating omissions and duplicates.
Missing evidence, date mismatch, or count mismatch withholds all metrics.

Only after reconciliation are unoccupied hours zero-filled. A window with no
observations is reported as `no_data`, even if the attested count is zero.
This conservative milestone does not score an entirely empty interval.

Evaluation starts at the first full day after `train_end`; a requested earlier
start is clipped. Default end is UTC today minus two days, conservatively
excluding unfinished Eastern days. Later requested ends are clipped too.
The attestation must match these effective dates. Default start is the first
eligible day; pass explicit dates for a particular reporting interval.

Aggregation reuses `db.features.load_hourly()`: all offered calls, including
abandonments, grouped by `date_trunc('hour', start_ts)`. Feature generation
reuses `build_features()` with metadata's original training epoch. Prediction
uses the volume booster multiplied by the saved metadata `level_factor`, exactly
as `db.forecast.forecast_range()` does. Missing `level_factor` defaults to 1.0
for older artifacts. It does not estimate a new correction from evaluation
actuals or use AHT or patience estimates from later calls.
The current holidays table is used; its historical availability is unknown
and calendar coverage warnings appear in the report.

Time follows the existing naive Eastern wall-clock convention: 24 bins per
day, a spring-forward zero bin, and combined repeated fall-back hour. These
are wall-clock metrics, not elapsed-hour metrics. Timestamp modernization is
outside this milestone.

## Report and statuses

The JSON includes schema version, evaluation kind, UTC execution timestamp,
model identity, effective evaluation period, completeness evidence, metrics,
warnings, and status. No raw call records or database connection details are
included. Treat evidence text as operator-controlled; never include secrets.

Metrics reuse `db.train.score()` for hourly MAE, hourly RMSE, and daily-total
MAE. Signed bias is mean **predicted minus actual** calls/hour: positive means
overprediction. At least one full, verified day with observations is required.
The archive-free replay is not a measure of historical serving behavior.

`db.snapshot` and `db.score_week` remain the separate frozen-forecast workflow:
they preserve predictions before actuals arrive and score Excel actuals,
including AHT and roster-based service level and abandonment. Replay evaluates
volume only. Its signed bias is calls/hour; `score_week` reports percentage
week-total bias. Do not present these as interchangeable metrics.

Choose dates strictly after the selected artifact's `train_end`. For example,
the current October 20, 2026 training cutoff makes the September examples above
ineligible; use a later complete, reconciled interval or an older paired model.

| Status | Exit code | Meaning |
|---|---|---|
| `success` | 0 | Verified interval scored; review warnings too |
| `incomplete` | 2 | Completeness not established; metrics null |
| `no_data` | 2 | No eligible window or observations; metrics null |
| `error` | 1 | Missing files/configuration, malformed input/model, database or evaluation failure |

Database errors are redacted; raw driver exceptions are not reported.
Invalid command-line syntax uses argparse's standard stderr and exit code 2.
The command does not send notifications or persist report history itself.

## Docker

The existing Dockerfile already copies `db/` and models and includes the
required dependencies. Override its default Uvicorn command:

```text
docker build -t v4w-monitor .
docker run --rm --env-file /private/runtime.env --mount type=bind,src=/private/completeness.json,dst=/run/completeness.json,readonly v4w-monitor python -m db.monitor --start 2026-09-01 --end 2026-09-14 --completeness /run/completeness.json
```

Use absolute host paths suitable for your Docker host. Inject secrets through
the scheduler's secret store in hosted environments. Capture stdout as a
report artifact; no writable container volume is required.

## Every-two-week hosted invocation

Configure the host's scheduler to launch a single job every **14 days**,
anchored to an explicit UTC start time. For example, an interval scheduler
can use `rate(14 days)`. A cron expression using `*/14` in day-of-month does
not guarantee a continuous two-week cadence across month boundaries.

The job runs the same command/image, injects database access, and supplies
explicit full-day evaluation dates and a freshly reconciled attestation.
The loader/operator must make that evidence available first. The scheduler
should retain JSON stdout, record exit status, and notify on exit 1 or 2;
notification delivery and scheduler provisioning are outside this milestone.
Retries are safe because the job performs no persistent writes. Avoid
overlapping runs to limit database load. The shared aggregation currently
reads all call history before filtering, so schedule during a quiet period.

## Offline tests

```text
python -m pytest tests/test_monitor.py -q -p no:cacheprovider
```

Tests use synthetic frames, temporary artifact files, and mocked model and
database connections. Dotenv discovery is disabled during shared-module import;
no partner database or existing model files are required.

Calibration tests cover a non-unit saved factor. Production parity tests compare
feature inputs and replay metrics against `forecast_range()` volume predictions
with mocked data/AHT, covering missing, identity, upward, and downward factors.
