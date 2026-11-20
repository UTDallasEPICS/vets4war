// GET /api/admin/runs: the last 30 runs, the active one, the one queued behind it, and
// what the call data holds.
import { defineEventHandler } from 'h3'
import type { RunsOverviewResponse } from '../../../../shared/types/api'
import { db } from '../../../utils/db'
import { toRunSummary } from '../../../utils/mappers'
import { useRetrainRunner } from '../../../utils/retrain'
import { runsOverview } from '../../../utils/retrain/runner'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event): RunsOverviewResponse => {
  requireAdmin(event)
  // A run whose process is gone (a shell's run killed with -9) shows as ended, not active.
  useRetrainRunner().reconcile()
  const { runs, activeRunId, queued, data } = runsOverview(db)
  return {
    runs: runs.map(toRunSummary),
    active_run_id: activeRunId,
    queued: queued && {
      mode: queued.mode,
      trigger: queued.trigger,
      requested_by: queued.requestedBy,
    },
    data,
  }
})
