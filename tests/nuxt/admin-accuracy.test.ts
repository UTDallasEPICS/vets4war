// @vitest-environment nuxt
//
// The Accuracy tab: the period's numbers, every day with which forecast it was compared
// with, the warnings, a new period, and the refusal of a bad one. The endpoint is
// registered here and answers by the query; no server runs.

import { describe, it, expect } from 'vitest'
import { defineEventHandler, getQuery, setResponseStatus } from 'h3'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import type { AccuracyDay, AccuracyResponse } from '#shared/types/api'
import AccuracyPanel from '../../app/components/admin/AccuracyPanel.vue'

function day(values: Partial<AccuracyDay>): AccuracyDay {
  return {
    date: '2026-11-16',
    actual_calls: 264,
    predicted_calls: 242,
    error_calls: -22,
    abs_pct_error: (22 / 264) * 100,
    hourly_mae: 1.5,
    source: 'snapshot',
    held_out: true,
    ...values,
  }
}

const MEASURED: AccuracyResponse = {
  status: 'success',
  period: { start: '2026-11-04', end: '2026-11-17' },
  calls_range: { first_day: '2025-01-01', last_day: '2026-11-17' },
  model: { id: 3, train_end: '2026-11-17T23:00:00' },
  days: [
    day({ date: '2026-11-15', source: 'replay', held_out: false, error_calls: 2 }),
    day({}),
    day({ date: '2026-11-17', actual_calls: 216, error_calls: 26, abs_pct_error: 12.037 }),
  ],
  metrics: {
    days: 2,
    hours: 48,
    actual_calls: 480,
    predicted_calls: 484,
    hourly_mae: 1.234,
    hourly_rmse: 1.5,
    daily_total_mae: 24,
    signed_bias: 0.0833,
    daily_accuracy_pct: 89.81,
    total_bias_pct: 0.833,
  },
  warnings: ['1 day is in the training data of the model in use.'],
}

const NOTHING_HELD_OUT: AccuracyResponse = {
  ...MEASURED,
  status: 'not_held_out',
  period: { start: '2026-11-14', end: '2026-11-15' },
  days: [MEASURED.days[0]!],
  metrics: null,
  warnings: [],
}

registerEndpoint(
  '/api/admin/accuracy',
  defineEventHandler((event) => {
    const { start, end } = getQuery(event)
    if (start === undefined) return MEASURED
    if (start === '2026-11-14' && end === '2026-11-15') return NOTHING_HELD_OUT
    setResponseStatus(event, 400, 'Bad Request')
    return {
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: `end ${end} is before start ${start}`,
      data: { code: 'end_before_start' },
    }
  })
)

async function mounted() {
  const wrapper = await mountSuspended(AccuracyPanel)
  await flushPromises()
  return wrapper
}

function field(wrapper: VueWrapper, testid: string) {
  const found = wrapper.find(`[data-testid="${testid}"]`)
  return found.element.tagName === 'INPUT' ? found : found.find('input')
}

async function check(wrapper: VueWrapper, start: string, end: string) {
  await field(wrapper, 'accuracy-start').setValue(start)
  await field(wrapper, 'accuracy-end').setValue(end)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

describe('accuracy panel', () => {
  it('shows the daily accuracy, the bias and the error measures of the held-out days', async () => {
    const wrapper = await mounted()
    expect(wrapper.find('[data-testid="accuracy-status"]').text()).toBe('Measured')
    const headline = wrapper.find('[data-testid="accuracy-headline"]').text()
    expect(headline).toContain('89.8%')
    expect(headline).toContain('daily accuracy')
    expect(headline).toContain('+0.8%')
    expect(headline).toContain('forecast too high')
    const metrics = wrapper.find('[data-testid="accuracy-metrics"]').text()
    expect(metrics).toContain('1.23')
    expect(metrics).toContain('24')
    expect(metrics).toContain('+0.08')
    expect(wrapper.text()).toContain('2 days: 480 calls came, the forecast said 484.')
  })

  it('lists every day with the forecast it was compared with', async () => {
    const wrapper = await mounted()
    const rows = wrapper.findAll('[data-testid="accuracy-days"] tbody tr')
    expect(rows.map((row) => row.findAll('td')[0]!.text())).toEqual([
      'Sun 2026-11-15',
      'Mon 2026-11-16',
      'Tue 2026-11-17',
    ])
    expect(rows.map((row) => row.find('.status').text())).toEqual([
      'In training, not counted',
      'Kept at import',
      'Kept at import',
    ])
    expect(rows[1]!.text()).toContain('−22')
    expect(rows[2]!.text()).toContain('+26')
    expect(rows[2]!.text()).toContain('12.0%')
  })

  it('shows the warnings and fills the dates with the period it measured', async () => {
    const wrapper = await mounted()
    expect(wrapper.find('[data-testid="accuracy-warnings"]').text()).toBe(
      '1 day is in the training data of the model in use.'
    )
    expect((field(wrapper, 'accuracy-start').element as HTMLInputElement).value).toBe('2026-11-04')
    expect(wrapper.text()).toContain('Calls are stored from 2025-01-01 to 2026-11-17.')
  })

  it('checks other dates, and says why nothing could be measured', async () => {
    const wrapper = await mounted()
    await check(wrapper, '2026-11-14', '2026-11-15')
    expect(wrapper.find('[data-testid="accuracy-status"]').text()).toBe('Nothing to measure')
    expect(wrapper.find('[data-testid="accuracy-empty"]').text()).toContain(
      'was in the training data'
    )
    expect(wrapper.find('[data-testid="accuracy-headline"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="accuracy-days"] tbody tr')).toHaveLength(1)
  })

  it('shows the refusal of a bad period and keeps the last answer', async () => {
    const wrapper = await mounted()
    await check(wrapper, '2026-11-17', '2026-11-16')
    expect(wrapper.find('[data-testid="accuracy-problem"]').text()).toContain(
      'end 2026-11-16 is before start 2026-11-17'
    )
    expect(wrapper.find('[data-testid="accuracy-status"]').text()).toBe('Measured')
  })
})
