// POST /api/admin/uploads: one multipart part named `file` (PLAN.md 8.4). Answers 202
// while the file is read in the background, or 200 with the upload that already holds
// these exact bytes.
import {
  defineEventHandler,
  getRequestHeader,
  readMultipartFormData,
  setResponseHeader,
  setResponseStatus,
} from 'h3'
import { db } from '../../../utils/db'
import { apiError, validationError } from '../../../utils/http'
import { useIngestDeps } from '../../../utils/ingest'
import { receiveUpload } from '../../../utils/ingest/service'
import { toUploadSummary } from '../../../utils/mappers'
import { requireAdmin } from '../../../utils/session'

// Room for the multipart boundaries and part headers around the file itself.
const MULTIPART_OVERHEAD = 64 * 1024

export default defineEventHandler(async (event) => {
  const user = requireAdmin(event)
  const deps = useIngestDeps()

  // Refuse by the declared size before reading the body into memory. A body without a
  // declared size cannot be bounded before it is read, so it is refused too.
  const declared = getRequestHeader(event, 'content-length')
  if (declared === undefined) {
    throw apiError(411, 'length_required', 'Send the file as a normal form upload.')
  }
  if (Number(declared) > deps.maxBytes + MULTIPART_OVERHEAD) {
    const limit = Math.floor(deps.maxBytes / (1024 * 1024))
    throw apiError(
      413,
      'too_large',
      `The file is larger than the upload limit of ${limit} MB. Split it into smaller files (one year per file works).`
    )
  }

  const parts = (await readMultipartFormData(event)) ?? []
  const file = parts.find((part) => part.name === 'file')
  if (!file) {
    throw validationError([{ path: 'file', message: 'Choose a .xlsx file to upload.' }])
  }

  try {
    const { upload, existing } = await receiveUpload(db, deps, {
      filename: file.filename ?? 'upload.xlsx',
      data: file.data,
      user: { id: user.id, email: user.email },
    })
    setResponseStatus(event, existing ? 200 : 202)
    return { upload: toUploadSummary(upload) }
  } catch (error) {
    if ((error as { data?: { code?: string } }).data?.code === 'busy') {
      setResponseHeader(event, 'Retry-After', 5)
    }
    throw error
  }
})
