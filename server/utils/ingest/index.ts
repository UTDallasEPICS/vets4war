// The upload service wired to this process: limits from the environment, today's date on
// the partner's line, and the retrain that starts after an import.
import { getRouterParam, type H3Event } from 'h3'
import { easternToday } from '../../../shared/utils/dates'
import { env } from '../env'
import { apiError } from '../http'
import { useRetrainRunner } from '../retrain'
import type { IngestDeps } from './service'

export { removeLeftoverUploadFiles } from './tempfiles'

const MB = 1024 * 1024

export function useIngestDeps(): IngestDeps {
  return {
    maxBytes: env.V4W_UPLOAD_MAX_MB * MB,
    maxRows: env.V4W_UPLOAD_MAX_ROWS,
    today: () => easternToday(),
    onImported: env.V4W_RETRAIN_ON_IMPORT
      ? ({ uploadId, userLabel }) =>
          useRetrainRunner().request({
            trigger: 'import',
            mode: 'full',
            requestedBy: userLabel,
            uploadId,
          })
      : undefined,
  }
}

// The numeric :id of an admin route; anything else is an unknown id.
export function routeId(event: H3Event, what: string): number {
  const raw = getRouterParam(event, 'id') ?? ''
  const id = /^\d{1,9}$/.test(raw) ? Number(raw) : 0
  if (id < 1) throw apiError(404, 'not_found', `There is no ${what} ${raw}.`)
  return id
}
