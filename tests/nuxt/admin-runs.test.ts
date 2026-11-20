// @vitest-environment nuxt
//
// The Forecast runs tab's own pieces: the line that says what is served and how it
// relates to the stored calls (after a failed, a rejected and no retrain), the run
// detail with gate metrics the backtest could not measure (null), and the badge of a
// first model that was rejected. Endpoints are registered here; no server runs.

import { describe, it, expect } from 'vitest'
import { defineEventHandler } from 'h3'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import type {
  RunDetail as RunDetailBody,
  RunSummary,
  RunsOverviewResponse,
  StatusResponse,
} from '#shared/types/api'
import RunsPanel from '../../app/components/admin/RunsPanel.vue'
import ForecastState from '../../app/components/admin/runs/ForecastState.vue'
import RunDetail from '../../app/components/admin/runs/RunDetail.vue'
import StatusBadge from '../../app/components/admin/runs/StatusBadge.vue'

function run(values: Partial<RunSummary>): RunSummary {
  return {
    id: 1,
    trigger: 'manual',
    mode: 'full',
    status: 'succeeded',
    requested_by: 'admin@example.org',
    upload_id: null,
    created_at: '2026-11-19T10:00:00Z',
    started_at: '2026-11-19T10:00:00Z',
    finished_at: '2026-11-19T10:00:21Z',
    trained: true,
    gate_passed: true,
    forecast_written: true,
    model_id: 1,
    calls_count: 100,
    data_start: '2021-01-01',
    data_end: '2026-11-15',
    horizon_start: '2021-01-01',
    horizon_end: '2029-01-24',
    message: null,
    ...values,
  }
}

function status(
  forecast: Partial<NonNullable<StatusResponse['forecast']>> | null,
  trainEnd?: string
) {
  return {
    viewer: { email: 'admin@example.org', name: 'admin', role: 'admin' },
    data_source: { kind: 'synthetic', label: 'Synthetic data' },
    forecast: forecast && {
      run_id: 2,
      generated_at: '2026-11-19T10:00:21Z',
      horizon_start: '2021-01-01',
      horizon_end: '2029-01-24',
      data_start: '2021-01-01',
      data_end: '2026-11-15',
      calls_count: 100,
      stale: false,
      ...forecast,
    },
    model: forecast && {
      id: 7,
      created_at: '2026-11-19T10:00:21Z',
      train_start: '2021-01-01T00:00:00',
      train_end: trainEnd ?? '2026-11-15T23:00:00',
      train_rows: 1,
      model_sha256: 'x',
      label: 'production',
    },
    run: null,
  } as StatusResponse
}

async function stateText(props: InstanceType<typeof ForecastState>['$props']) {
  const wrapper = await mountSuspended(ForecastState, { props })
  return wrapper.text()
}

describe('forecast state line', () => {
  it('says nothing on a brand-new database', async () => {
    expect(
      await stateText({ status: status(null), runs: [], activeRunId: null, lastDay: null })
    ).toBe('')
  })

  it('no forecast yet: names the retrain that ended without one', async () => {
    const text = await stateText({
      status: status(null),
      runs: [run({ id: 3, status: 'failed', message: 'Cannot retrain: too little history.' })],
      activeRunId: null,
      lastDay: '2026-11-15',
    })
    expect(text).toContain('No forecast is served yet.')
    expect(text).toContain('The last retrain (run 3) failed: Cannot retrain: too little history.')
  })

  it('current forecast and model: only the serving line', async () => {
    const text = await stateText({
      status: status({}),
      runs: [run({ id: 2 })],
      activeRunId: null,
      lastDay: '2026-11-15',
    })
    expect(text).toContain('Serving the forecast of run 2')
    expect(text).toContain('Model 7 was trained on calls through 2026-11-15')
    expect(text).not.toContain('older than the data')
  })

  it('newer calls after a failed retrain on them: the forecast is behind, and why', async () => {
    const text = await stateText({
      status: status({ stale: true }),
      runs: [
        run({ id: 4, status: 'failed', data_end: '2026-11-17', message: 'Cannot retrain: gap.' }),
        run({ id: 2 }),
      ],
      activeRunId: null,
      lastDay: '2026-11-17',
    })
    expect(text).toContain('The stored calls (through 2026-11-17) are newer than this forecast.')
    expect(text).toContain('The last retrain (run 4) failed: Cannot retrain: gap.')
  })

  it('a rejected retrain: the forecast is on the new data, the model is the older one', async () => {
    const text = await stateText({
      status: status({ run_id: 5, data_end: '2026-11-17' }, '2026-11-15T23:00:00'),
      runs: [run({ id: 5, status: 'rejected', data_end: '2026-11-17', message: 'Kept it.' })],
      activeRunId: null,
      lastDay: '2026-11-17',
    })
    expect(text).toContain(
      'The model in use is older than the data: trained through 2026-11-15, data through 2026-11-17.'
    )
    expect(text).toContain(
      'The last retrain (run 5) did not beat the simple baseline, so it kept the previous model: Kept it.'
    )
  })

  it('newer calls while a run works on them', async () => {
    const text = await stateText({
      status: status({ stale: true }),
      runs: [run({ id: 6, status: 'running', finished_at: null })],
      activeRunId: 6,
      lastDay: '2026-11-17',
    })
    expect(text).toContain('A run is working on them now.')
  })
})

const GATE_NULLS: RunDetailBody = {
  ...run({
    id: 9,
    status: 'rejected',
    gate_passed: false,
    forecast_written: false,
    trained: false,
  }),
  exit_code: 3,
  log_tail: 'gate table',
  gate: {
    origins: 2,
    first_origin: '2026-10-01',
    last_origin: '2026-10-08',
    passed: false,
    model: {
      daily_mape_1_14: 7.5,
      daily_mape_15_28: null,
      hourly_mae_1_14: 3.25,
      block_wape_1_14: 9,
      week_acc_mean: 92,
      week_acc_std: null,
      week_acc_min: 90,
      week_total_ape: 4,
    },
    naive: {
      daily_mape_1_14: 8.5,
      daily_mape_15_28: null,
      hourly_mae_1_14: 4,
      block_wape_1_14: 10,
      week_acc_mean: 91,
      week_acc_std: 1,
      week_acc_min: 89,
      week_total_ape: 5,
    },
  },
}
registerEndpoint(
  '/api/admin/runs/9',
  defineEventHandler(() => ({ run: GATE_NULLS }))
)

describe('run detail', () => {
  it('shows a metric the backtest could not measure as a dash, not a stuck drawer', async () => {
    const wrapper = await mountSuspended(RunDetail, {
      props: { runId: null },
      attachTo: document.body,
    })
    await wrapper.setProps({ runId: 9 })
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await flushPromises()
    const table = document.querySelector('[data-testid="gate-table"]')
    expect(table).not.toBeNull()
    const rows = [...table!.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent!.trim())
    )
    expect(rows).toContainEqual(['Daily error, days 15 to 28', '–', '–'])
    expect(rows).toContainEqual(['Week accuracy, spread', '–', '1.00%'])
    expect(rows).toContainEqual(['Daily error, days 1 to 14', '7.50%', '8.50%'])
    expect(document.body.textContent).toContain('not better, and there was no previous model')
    wrapper.unmount()
  })
})

// The tab as loaded from the server: what is queued comes from GET /api/admin/runs, so
// it shows after a reload and goes once the queue is empty.
let overview: RunsOverviewResponse
registerEndpoint(
  '/api/admin/runs',
  defineEventHandler(() => overview)
)
registerEndpoint(
  '/api/status',
  defineEventHandler(() => status(null))
)

describe('runs panel', () => {
  const working = run({ id: 3, status: 'running', finished_at: null })
  const data = {
    calls_revision: 1,
    calls_count: 100,
    first_day: '2026-11-01',
    last_day: '2026-11-15',
  }

  it('says a run is queued, what kind and who asked, after a reload', async () => {
    overview = {
      runs: [working],
      active_run_id: 3,
      queued: { mode: 'forecast-only', trigger: 'manual', requested_by: 'b@example.org' },
      data,
    }
    const wrapper = await mountSuspended(RunsPanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="queued-run"]').text()).toBe(
      'One more forecast refresh is queued (asked by b@example.org). It starts when run 3 ends.'
    )
    wrapper.unmount()
  })

  it('says nothing about a queue when it is empty', async () => {
    overview = { runs: [working], active_run_id: 3, queued: null, data }
    const wrapper = await mountSuspended(RunsPanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="queued-run"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('status badge', () => {
  it('a rejected first model kept nothing', async () => {
    const first = await mountSuspended(StatusBadge, {
      props: { status: 'rejected', forecastWritten: false },
    })
    expect(first.text()).toBe('Rejected, nothing served')
    const later = await mountSuspended(StatusBadge, {
      props: { status: 'rejected', forecastWritten: true },
    })
    expect(later.text()).toBe('Kept the previous model')
  })
})
