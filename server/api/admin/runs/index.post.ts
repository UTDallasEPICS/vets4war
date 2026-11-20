// POST /api/admin/runs: start a retrain by hand (202). While one runs, nothing new is
// started: one more run is queued behind it and the active run is returned.
import { defineEventHandler, setResponseStatus } from 'h3'
import { z } from 'zod'
import { issuesFromZod, readJsonObject, validationError } from '../../../utils/http'
import { toRunSummary } from '../../../utils/mappers'
import { useRetrainRunner } from '../../../utils/retrain'
import { requireAdmin } from '../../../utils/session'

const body = z.strictObject({
  mode: z
    .enum(['full', 'forecast-only'], { message: 'must be "full" or "forecast-only"' })
    .optional(),
})

export default defineEventHandler(async (event) => {
  const user = requireAdmin(event)
  // No body is the default (a retrain); a body must be a JSON object.
  const parsed = body.safeParse(await readJsonObject(event))
  if (!parsed.success) throw validationError(issuesFromZod(parsed.error))
  const { run, queued } = useRetrainRunner().request({
    trigger: 'manual',
    mode: parsed.data.mode ?? 'full',
    requestedBy: user.email,
  })
  setResponseStatus(event, 202)
  return { run: toRunSummary(run), queued }
})
