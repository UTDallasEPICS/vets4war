// DELETE /api/admin/uploads/:id: discard a checked file that will not be imported.
import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { routeId } from '../../../utils/ingest'
import { discardUpload } from '../../../utils/ingest/service'
import { toUploadSummary } from '../../../utils/mappers'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return { upload: toUploadSummary(discardUpload(db, routeId(event, 'upload'))) }
})
