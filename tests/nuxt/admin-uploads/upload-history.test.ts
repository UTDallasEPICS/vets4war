// @vitest-environment nuxt
//
// The uploads history: an import that no retrain has read yet says so, and on a phone
// the file name keeps a readable width (review W3-6: `break-all` in a scrolling table
// collapsed it to two characters per line and rows of about 480 px).
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import UploadHistory from '../../../app/components/admin/uploads/UploadHistory.vue'
import { upload } from './fixtures'

describe('UploadHistory', () => {
  it('says an import waits for a retrain until a run has read it', async () => {
    const wrapper = await mountSuspended(UploadHistory, {
      props: {
        uploads: [
          upload({ status: 'imported', run_id: null }),
          upload({ id: 4, status: 'imported', run_id: 2 }),
        ],
      },
    })
    const rows = wrapper.findAll('tbody tr').map((tr) => tr.text())
    expect(rows[0]).toContain('Waiting for a retrain')
    expect(rows[1]).toContain('Run 2')
  })

  it('gives the file name a minimum width instead of breaking it after every character', async () => {
    const wrapper = await mountSuspended(UploadHistory, {
      props: {
        uploads: [
          upload({ filename: 'SYNTHETIC V4W Call Records - Nov 9th 2026 thru Nov 15th 2026.xlsx' }),
        ],
      },
    })
    const cell = wrapper.find('tbody tr td')
    expect(cell.classes()).toContain('min-w-48')
    expect(cell.classes()).not.toContain('break-all')
  })
})
