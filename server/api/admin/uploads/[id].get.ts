// GET /api/admin/uploads/:id: one upload with its report (the page polls this while the
// file is being read).
import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { routeId } from '../../../utils/ingest'
import { getUpload, uploadDetail } from '../../../utils/ingest/service'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return { upload: uploadDetail(getUpload(db, routeId(event, 'upload'))) }
})
