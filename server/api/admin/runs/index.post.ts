// POST /api/admin/runs: start a retrain by hand (202). While one runs, nothing new is
// started: one more run is queued behind it and the active run is returned.
import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { z } from 'zod'
import { issuesFromZod, validationError } from '../../../utils/http'
import { toRunSummary } from '../../../utils/mappers'
import { useRetrainRunner } from '../../../utils/retrain'
import { requireAdmin } from '../../../utils/session'

const body = z.object({ mode: z.enum(['full', 'forecast-only']).optional() }).strict()

export default defineEventHandler(async (event) => {
  const user = requireAdmin(event)
  // No body means the default; a body that is not JSON is refused like a wrong one.
  const raw: unknown = await readBody(event).catch(() => null)
  const parsed = body.safeParse(raw === undefined ? {} : raw)
  if (!parsed.success) throw validationError(issuesFromZod(parsed.error))
  const { run, queued } = useRetrainRunner().request({
    trigger: 'manual',
    mode: parsed.data.mode ?? 'full',
    requestedBy: user.email,
  })
  setResponseStatus(event, 202)
  return { run: toRunSummary(run), queued }
})
