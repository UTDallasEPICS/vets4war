// Keeps what the served forecast said for days whose calls an import is adding, inside
// the import's own transaction and so before those calls are in. The retrain the import
// starts then learns these days, and its forecast for them is no longer a test of the
// model; this copy still is. The first copy of a day is kept (INSERT OR IGNORE): a later
// replacement of the day's calls does not overwrite it.
import type Database from 'better-sqlite3'

// Returns how many hours were kept: 0 when nothing is served yet.
export function captureForecastSnapshots(
  client: Database.Database,
  days: readonly string[],
  uploadId: number,
  capturedAtSec: number
): number {
  const keep = client.prepare(
    `INSERT OR IGNORE INTO forecast_snapshots
       (date, hour, predicted_calls, model_id, run_id, upload_id, captured_at)
     SELECT h.date, h.hour, h.predicted_calls, s.model_id, s.run_id, ?, ?
     FROM forecast_hours h JOIN forecast_state s ON s.id = 1
     WHERE h.date = ?`
  )
  let kept = 0
  for (const day of days) kept += keep.run(uploadId, capturedAtSec, day).changes
  return kept
}
