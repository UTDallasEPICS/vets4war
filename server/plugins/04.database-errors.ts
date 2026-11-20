import type { H3Error, H3Event } from 'h3'
import { shapeDatabaseError } from '../utils/db-errors'

// A busy, read-only or full database answers in the API's error shape, with a sentence,
// instead of a bare 500 (server/utils/db-errors.ts). Nitro calls this hook, synchronously,
// before its error handler writes the answer.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error, context) => {
    shapeDatabaseError(error as H3Error, (context as { event?: H3Event }).event)
  })
})
