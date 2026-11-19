// @vitest-environment nuxt
//
// The report of a checked file. The multi-year export has over 2,000 days: listed one
// per line, the table was about 70,000 px tall and the import form sat below it. Runs
// of consecutive days with the same outcome are one line; a different day stays its own.
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import UploadReport from '../../../app/components/admin/uploads/UploadReport.vue'
import { days, upload } from './fixtures'

function report(list: ReturnType<typeof days>) {
  const count = (s: string) => list.filter((d) => d.status === s).length
  return upload({
    report: {
      ok: true,
      nothing_to_import: false,
      summary: {
        total_rows: list.reduce((n, d) => n + d.rows, 0),
        first_day: list[0]!.day,
        last_day: list[list.length - 1]!.day,
        days: list.length,
        new_days: count('new'),
        identical_days: count('identical'),
        conflict_days: count('conflict'),
      },
      days: list,
      days_without_calls: [],
      file_errors: [],
      warnings: [],
    },
  })
}

const lines = (wrapper: Awaited<ReturnType<typeof mountSuspended>>) =>
  wrapper
    .findAll('[data-testid="day-table"] tbody tr')
    .map((tr: { findAll(selector: string): { text(): string }[] }) =>
      tr
        .findAll('td')
        .map((td: { text(): string }) => td.text().replace(/\s+/g, ' ').trim())
        .join(' | ')
    )

describe('UploadReport', () => {
  it('shows a multi-year file of new days as one line', async () => {
    const wrapper = await mountSuspended(UploadReport, {
      props: { upload: report(days('2021-01-01', 2138, 'new')) },
    })
    expect(lines(wrapper)).toEqual(['2021-01-01 to 2026-11-08 (2,138 days) | 384,840 | 0 | New'])
  })

  it('keeps a different day on its own line and groups the runs around it', async () => {
    const list = [
      ...days('2026-10-01', 20, 'identical'),
      ...days('2026-10-21', 1, 'conflict'),
      ...days('2026-10-22', 10, 'identical'),
      ...days('2026-11-01', 8, 'new'),
    ]
    const wrapper = await mountSuspended(UploadReport, { props: { upload: report(list) } })
    expect(lines(wrapper)).toEqual([
      '2026-10-01 to 2026-10-20 (20 days) | 3,600 | 3,600 | Already loaded',
      '2026-10-21 | 180 | 180 | Different',
      '2026-10-22 to 2026-10-31 (10 days) | 1,800 | 1,800 | Already loaded',
      '2026-11-01 to 2026-11-08 (8 days) | 1,440 | 0 | New',
    ])
    await wrapper.find('[data-testid="show-all-days"]').trigger('click')
    expect(lines(wrapper)).toHaveLength(39)
  })

  it('lists a short file day by day', async () => {
    const wrapper = await mountSuspended(UploadReport, {
      props: { upload: report(days('2026-11-09', 7, 'new')) },
    })
    expect(lines(wrapper)).toHaveLength(7)
    expect(wrapper.find('[data-testid="show-all-days"]').exists()).toBe(false)
  })
})

describe('UploadReport of a file refused while it was read', () => {
  it('shows the problem, not counts of zero calls and zero days', async () => {
    const refused = upload({
      status: 'invalid',
      report: {
        ok: false,
        nothing_to_import: false,
        summary: {
          total_rows: 0,
          first_day: null,
          last_day: null,
          days: 0,
          new_days: 0,
          identical_days: 0,
          conflict_days: 0,
        },
        days: [],
        days_without_calls: [],
        file_errors: [
          { code: 'bad_rows', message: 'Sheet "Sheet": Abandon is not Y or N on Excel row 9.' },
        ],
        warnings: [],
      },
    })
    const wrapper = await mountSuspended(UploadReport, { props: { upload: refused } })
    expect(wrapper.find('[data-testid="report-summary"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Calls in the file')
    expect(wrapper.find('[data-testid="file-error"]').text()).toContain('Excel row 9')
  })
})
