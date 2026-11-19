// GET /api/admin/runs: the last 30 runs, the active one, and what the call data holds.
import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { toRunSummary } from '../../../utils/mappers'
import { runsOverview } from '../../../utils/retrain/runner'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const { runs, activeRunId, data } = runsOverview(db)
  return { runs: runs.map(toRunSummary), active_run_id: activeRunId, data }
})
