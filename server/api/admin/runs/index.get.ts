// GET /api/admin/runs: the last 30 runs, the active one, and what the call data holds.
import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { toRunSummary } from '../../../utils/mappers'
import { useRetrainRunner } from '../../../utils/retrain'
import { runsOverview } from '../../../utils/retrain/runner'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  // A run whose process is gone (a shell's run killed with -9) shows as ended, not active.
  useRetrainRunner().reconcile()
  const { runs, activeRunId, data } = runsOverview(db)
  return { runs: runs.map(toRunSummary), active_run_id: activeRunId, data }
})
