// Start-up and shut-down of the write side: uploads a stopped process was reading are
// failed, runs it left behind are interrupted (and their process stopped), a retrain
// starts when the data is newer than anything that ran on it; on close the running
// retrain is stopped and its run marked interrupted.
import { db } from '../utils/db'
import { removeLeftoverUploadFiles } from '../utils/ingest'
import { recoverUploads } from '../utils/ingest/service'
import { useRetrainRunner } from '../utils/retrain'

export default defineNitroPlugin((nitroApp) => {
  try {
    const failed = recoverUploads(db)
    if (failed)
      console.log(`[uploads] ${failed} upload(s) left unread by the last stop marked failed`)
    const { interrupted, started } = useRetrainRunner().recover()
    if (interrupted.length) console.log(`[retrain] interrupted run(s) ${interrupted.join(', ')}`)
    if (started)
      console.log(`[retrain] start-up run ${started} for call data no run has finished on`)
  } catch (error) {
    if (!isMissingTable(error)) throw error
    // The health route must stay up on an empty file, as in 01.bootstrap-admins.
    console.warn('[retrain] database is not migrated: run pnpm db:migrate')
  }
  void removeLeftoverUploadFiles().then((count) => {
    if (count) console.log(`[uploads] removed ${count} leftover upload folder(s)`)
  })
  nitroApp.hooks.hook('close', () => useRetrainRunner().shutdown())
})

function isMissingTable(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/no such table/i.test(e.message)) return true
  }
  return false
}
