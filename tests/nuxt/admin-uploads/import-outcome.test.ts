// @vitest-environment nuxt
//
// After an import the outcome follows the retrain that reads the file until it ends.
// An import queued behind a running retrain is read by the re-run that follows it, never
// by the run that was running (review X-6); the panel waits for that re-run and shows
// how it ended.
import { describe, expect, it } from 'vitest'
import { defineEventHandler } from 'h3'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ImportOutcome from '../../../app/components/admin/uploads/ImportOutcome.vue'
import { run, upload } from './fixtures'

const RESULT = {
  inserted_rows: 365,
  deleted_rows: 0,
  added_days: ['2026-11-16', '2026-11-17'],
  replaced_days: [],
  skipped_days: [],
  calls_revision: 4,
}

// The re-run (4) has claimed the new revision, so the upload answers with it.
registerEndpoint(
  '/api/admin/uploads/5',
  defineEventHandler(() => ({
    upload: upload({ status: 'imported', run_id: 4, result: RESULT }),
  }))
)
registerEndpoint(
  '/api/admin/runs/4',
  defineEventHandler(() => ({
    run: {
      ...run({
        id: 4,
        status: 'failed',
        upload_id: null,
        requested_by: 'queued',
        message: 'Cannot retrain: 1 recent day(s) have no calls at all.',
      }),
      gate: null,
      log_tail: null,
      exit_code: 2,
    },
  }))
)

describe('ImportOutcome', () => {
  it('waits for the re-run behind a running retrain and shows how it ended', async () => {
    const wrapper = await mountSuspended(ImportOutcome, {
      props: {
        upload: upload({ status: 'imported', result: RESULT }),
        run: run({ id: 3, upload_id: 4 }),
        queued: true,
      },
    })
    for (let i = 0; i < 20 && !wrapper.find('[data-testid="retrain-ended"]').exists(); i++) {
      await flushPromises()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const ended = wrapper.find('[data-testid="retrain-ended"]').text()
    expect(ended).toContain('Retrain (run 4): Failed.')
    expect(ended).toContain('Cannot retrain: 1 recent day(s) have no calls at all.')
    expect(wrapper.text()).not.toContain('run 3')
    // the import worked, the retrain did not: not shown in the success colour
    expect(wrapper.find('[data-testid="import-outcome"]').classes().join(' ')).toContain('warning')
  })

  it('says a retrain is queued before the re-run has begun', async () => {
    registerEndpoint(
      '/api/admin/uploads/6',
      defineEventHandler(() => ({ upload: upload({ id: 6, status: 'imported', result: RESULT }) }))
    )
    const wrapper = await mountSuspended(ImportOutcome, {
      props: {
        upload: upload({ id: 6, status: 'imported', result: RESULT }),
        run: run({ id: 3, upload_id: null, requested_by: 'admin@example.org' }),
        queued: true,
      },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="retrain-queued"]').text()).toContain(
      'A retrain was already running (run 3); another one starts when it ends and reads this file.'
    )
  })
})
