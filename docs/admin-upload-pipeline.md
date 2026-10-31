# Admin monthly upload pipeline

How a partner admin goes from signing in, to uploading a monthly Excel
file, to that data reaching the forecast. This is the team handoff for
the `feature/admin-integration` work.

Related docs: [Excel validation](ingestion.md), [ingestion ledger](ingestion-integration.md).

## Four stages

```
1. Sign in          Auth0 in the browser; API must check the token
2. Upload           File is checked and parked in pipeline_batches
3. Import           Parked rows are copied into the real calls table
4. Forecast         Some numbers update on restart; volume needs make train
```

Upload does **not** change the forecast. Import changes `calls`. Retraining
the model is a separate, manual step.

## Stage 1: Sign in

The admin opens `/admin.html` and logs in with Auth0. Auth0 returns an
access token (audience `https://api.vets4warriors.admin`). That token is
proof of who they are.

The page currently uses the token only to show or hide the admin UI.
Hiding the page is not security: anyone can call the API directly, so the
server must check the token too.

`require_admin()` in `api/main.py` is a placeholder. It returns 401 unless
`V4W_INSECURE_DEV_ADMIN` is set, in which case every request is treated as
that user. **Never set that variable on a shared or deployed server.**
Step 3 replaces this with a real Auth0 check in `api/auth.py` that returns
`{"sub": ...}`. The three `/api/admin/uploads*` routes already call
`require_admin`; they do not need to change when the real check lands.

`POST /api/admin/validate` does not require sign-in. It stores nothing.

## Stage 2: Upload (staging)

The admin picks a **completed** reporting month (`YYYY-MM`) and one `.xlsx`
file. The page sends both to `POST /api/admin/uploads`.

The server then:

1. Checks sign-in (`require_admin`).
2. Rejects the current month and any future month. In October 2026 the
   latest allowed month is September. Default the month picker to last month.
3. Rejects empty files, files over 25 MB, non-`.xlsx` archives, and
   workbooks that expand past 100 MB / 2,000 ZIP entries / 100,000 rows.
4. Reads the `Call Log` sheet using the export contract mapping, and
   checks every row (timestamps, Y/N abandon, numeric seconds, all calls
   inside the selected month).
5. Writes a **batch** to `pipeline_batches`: who uploaded, the month, a
   file fingerprint, the validation report, and (if every row is valid)
   the cleaned rows. The original workbook is never stored.

Response: `{id, status, validation}` where `status` is `validated` or
`invalid`. `validation` is the same report shape as
`parse_partner_excel(...).report()`: `ok`, `summary` (valid / invalid /
duplicate counts), `file_errors`, `row_errors` (capped at 200),
`days_without_calls`, `warnings`. Normalized call records are never sent
back to the browser.

At this point **`calls` is unchanged**. A batch that is not imported
within 7 days expires. Re-uploading the exact same bytes for the same
month returns the existing batch.

`POST /api/admin/validate` runs the same checks and stores nothing. Use it
for a quick "is this file OK?" check.

## Stage 3: Import

The admin reads the report, confirms the row count, and clicks **Import**.
The page sends `POST /api/admin/uploads/{id}/import` with
`{expected_rows, replace_batch_id?}`.

The server refuses unless all of these hold:

- the export contract has `"confirmed": true` and a nonempty `confirmed_by`
- the batch is `validated`, not expired, and was checked with the current
  contract
- `expected_rows` matches the batch exactly
- no other import is running
- the month does not already contain rows loaded outside this pipeline
- if the month was already imported, the request names that batch as
  `replace_batch_id`

Then, in **one transaction**, it removes the old rows for that month (if
replacing), inserts the new rows into `calls`, records which batch each
row came from in `pipeline_call_links`, marks the batch `imported`, and
increments `pipeline_state.revision`. If anything fails, all of it is
undone.

`GET /api/admin/uploads` returns the last 100 batches for a history table.
The admin never types their name or email; the server records `uploader`
and `imported_by` from `require_admin`.

### Two different switches

| | Import button | `"confirmed"` in the contract |
| --- | --- | --- |
| Who | Partner admin | This team, once |
| Where | `admin.html` | `config/export-contract.json` on the server |
| How often | Every monthly upload | Once |
| What it does | Copies that month into `calls` | Allows the Import button to work at all |

The example file `config/export-contract.example.json` is a template. Do
not edit it. Copy it to `config/export-contract.json`, set `"confirmed":
true` and `"confirmed_by"` (who flipped the switch, and when), and point
`V4W_EXPORT_CONTRACT` at the copy. The file is read from disk; the
browser never sends it.

Leave `"confirmed": false` on the real project until the team agrees that
imports are safe. Uploading and validating still work while it is false.

Changing the contract after a file was uploaded invalidates that batch
("The export contract changed. Validate the file again."). Upload it
again.

## Stage 4: How the forecast uses new data

Importing does **not** retrain the model. Nothing does that automatically.

| Number on the dashboard | Uses new `calls` rows? | When it updates |
| --- | --- | --- |
| Predicted calls per hour | Only through retraining. The model predicts from dates and holidays. | After someone runs `make train` |
| Handle time, caller patience, quick hang-ups, data date range | Yes, read from `calls` | Next API server restart |

After an import:

1. Without retraining, the next restart updates handle time and patience.
   Staffing recommendations shift a little; predicted volume stays the same.
2. With retraining, someone runs `make train` (~30 seconds). It retrains
   on all of `calls`, tests against the last 12 months, and refuses to
   save if the new model is worse than seasonal naive. The API reloads
   the model on the next request.

`pipeline_state.revision` is incremented on every successful import, but
nothing reads it yet. The "Model retraining" card on the admin page is a
placeholder.

Open questions for the team (do not flip `"confirmed"` on the real
project until these are answered):

1. Is it OK for imports to change handle time and patience on the next
   restart, without a retrain?
2. How often should the model be retrained (monthly, when numbers drift,
   never)?
3. Who runs `make train`, and how?
4. Should the server pick up new data without a restart (read `revision`)?

## API

All four routes live in `api/main.py`, above the static-file mount.

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| `POST` | `/api/admin/validate` | No | multipart `file` + `month=YYYY-MM` | validation report |
| `POST` | `/api/admin/uploads` | Yes | multipart `file` + `month=YYYY-MM` | `{id, status, validation}` (201) |
| `POST` | `/api/admin/uploads/{id}/import` | Yes | JSON `{expected_rows, replace_batch_id?}` | `{id, status: "imported"}` |
| `GET` | `/api/admin/uploads` | Yes | none | last 100 batches |

Send the Auth0 token as `Authorization: Bearer <token>` once step 3 lands.
Error responses use `{"detail": "..."}` with the pipeline's status:

| Code | Meaning |
| --- | --- |
| 400 | Bad month, not a valid `.xlsx` |
| 401 | Not signed in |
| 404 | Batch not found |
| 409 | Invalid/expired batch, wrong row count, month already imported, contract unconfirmed or changed, unmanaged overlap |
| 413 | Empty or larger than 25 MB |
| 503 | Database or export contract not configured |

File size limit is 25 MB. The frontend preview currently uses 10 MB; pick
one when wiring the page.

## Database tables

The migration `db/migrations/001_ingestion.sql` assumes `calls` already
exists with a database-generated `bigint` `id`. It adds:

- `pipeline_batches` — staged and imported uploads
- `pipeline_call_links` — which `calls.id` came from which batch
- `pipeline_state` — a singleton `revision` counter

Row-level security is on with no browser policies. The backend connects
as a privileged role via `V4W_DATABASE_URL` (Supabase **session pooler**,
port 5432, not the transaction pooler on 6543).

Months already loaded with `db/load_week.py` cannot be imported: those
rows have no batch link. Only months after the last loaded month import
cleanly.

Apply explicitly:

```sh
.venv/bin/python -m db.pipeline migrate
```

Check first (read-only):

```sql
SELECT column_name, data_type, column_default, is_identity
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'calls'
ORDER BY ordinal_position;

SELECT date_trunc('month', start_ts)::date AS month, count(*)
FROM calls GROUP BY 1 ORDER BY 1;

SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'pipeline_%';
```

After migrating: `SELECT * FROM pipeline_state;` should show one row with
`revision` 0.

Uploading (staging) on the real project only writes `pipeline_batches`.
Test **imports** on a throwaway database first. Keep `"confirmed": false`
on the real project until the team signs off.

## Local try

```sh
# .env: V4W_DATABASE_URL, V4W_EXPORT_CONTRACT=config/export-contract.example.json
# LOCAL ONLY:
V4W_INSECURE_DEV_ADMIN=you@example.com .venv/bin/uvicorn api.main:app --reload

curl -F month=2026-09 -F file=@calls.xlsx http://127.0.0.1:8000/api/admin/validate
```

Validate needs no database. The other three routes need the migration.
Import still refuses until the contract is confirmed.

Never commit partner `.xlsx` files; `.gitignore` already blocks `*.xlsx`,
`*.csv`, and `data/`.

## Status and owners

| Piece | Status | Owner |
| --- | --- | --- |
| Merge onto `feature/admin-integration` | Done | Backend |
| Upload / validate / import / history routes | Done (`api/main.py`, `tests/test_admin_api.py`) | Backend |
| Auth0 token check (`require_admin`) | Placeholder | Frontend / Auth0 |
| `admin.js` calling the routes | Not connected | Frontend |
| Supabase migration | Not applied | Backend + Supabase owner |
| `"confirmed": true` on the real project | Off on purpose | Team decision |
| Retrain after import | Manual `make train` | Model owner |

Frontend notes for wiring `admin.js`:

- Default the upload month to **last month**, not the current month.
- Send `Authorization: Bearer` + the Auth0 token.
- Fill valid / invalid / duplicate from `validation.summary`.
- Enable Import only when `status === "validated"`.
- Confirm `expected_rows` against the source export.
- If import returns 409 "already imported", offer replace with
  `replace_batch_id`.
- Show `detail` from error responses on the page.
