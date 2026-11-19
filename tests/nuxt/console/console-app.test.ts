// @vitest-environment nuxt
//
// The console in the Nuxt environment: apiFetch and useSessionUser are mocked, so no
// server, database or network is involved. The forecast is a SYNTHETIC two-day fixture
// built here with the shared staffForHour (today and tomorrow, as the page asks for the
// browser's today).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { enableAutoUnmount } from '@vue/test-utils'
import { computed } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import type {
  ForecastResponse,
  HourRow,
  ForecastDay,
  RunStatus,
  StatusResponse,
} from '#shared/types/api'
import { capForHour, staffForHour } from '#shared/utils/staffing'
import ConsoleApp from '../../../app/components/console/ConsoleApp.vue'
import { computeHours, summarize } from '../../../app/utils/console/logic'
import { isoDate, shortDate } from '../../../app/utils/console/format'

const mocks = vi.hoisted(() => ({
  // /api/forecast
  apiFetch: vi.fn(),
  // /api/status
  status: vi.fn(),
  role: 'admin' as 'admin' | 'viewer',
}))

// every mounted console is unmounted after its test, so no document listener of an
// earlier test answers a later one
enableAutoUnmount(afterEach)

mockNuxtImport('apiFetch', () => {
  return (url: string, options?: unknown) =>
    url === '/api/status' ? mocks.status() : mocks.apiFetch(url, options)
})
mockNuxtImport('useSessionUser', () => {
  return async () => ({
    user: computed(() => ({ id: 'u1', email: 'a@example.org', name: 'a', role: mocks.role })),
    isAdmin: computed(() => mocks.role === 'admin'),
    signOut: () => Promise.resolve(),
  })
})

const PATIENCE = 251
const EFF = 0.656
// Calls per hour: quiet nights, a busier day, a heavy evening (over the cap of 6).
const callsAt = (hour: number) => (hour < 8 ? 3 : hour < 16 ? 10 : 22)

function fixture(): ForecastResponse {
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const dates = [isoDate(today), isoDate(tomorrow)]
  const hours: HourRow[] = dates.flatMap((date) =>
    Array.from({ length: 24 }, (_, hour) => {
      const calls = callsAt(hour)
      const s = staffForHour(calls, 650, EFF, 0.8, 30, PATIENCE, capForHour(hour))
      return {
        date,
        hour,
        predicted_calls: calls,
        predicted_real_calls: calls * 0.7,
        aht_sec: 650,
        load_erlangs: s.load_erlangs,
        agents_required: s.agents_required,
        staff_to_schedule: s.staff_to_schedule,
        effective_agents: s.effective_agents,
        service_level_delivered: s.service_level_delivered,
        over_cap: s.over_cap,
        implausible: s.implausible,
        reason: s.reason,
        expected_talk_sec: s.load_erlangs * 3600,
        expected_talk: '',
        abandon_share: s.abandon_share,
      }
    })
  )
  const days: ForecastDay[] = dates.map((date) => ({
    date,
    predicted_calls: 0,
    shifts: { Overnight: null, Day: null, Evening: null },
    is_weekend: false,
    holiday: null,
    expected_talk_sec: 0,
    expected_talk: '',
  }))
  return {
    params: {
      start: dates[0]!,
      end: dates[1]!,
      efficiency: EFF,
      target_pct: 0.8,
      target_sec: 30,
      queue_model: 'erlang_a',
      patience_sec: PATIENCE,
      patience_source: { kind: 'estimated', n_abandoned: 1234, n_calls: 5678 },
      recency: 'weighted',
      include_holidays: true,
    },
    data_source: {
      kind: 'synthetic',
      label: 'Synthetic data',
      start: '2021-01-01',
      end: '2026-11-15',
    },
    holiday_coverage: { last_known_holiday: '2027-12-25', covered: true, message: null },
    hours,
    days,
    window: {
      start: dates[0]!,
      end: dates[1]!,
      expected_calls: 0,
      expected_talk_sec: 0,
      expected_talk: '',
      mean_aht_sec: 650,
      expected_abandoned_calls: null,
      abandon_share: null,
      expected_abandoned_one_fewer: null,
      recency: 'weighted',
      recency_effect_pct: 0,
      caveat: 'Caveat text.',
    },
    quick_hangups: {
      threshold_sec: 10,
      window_days: 90,
      first_day: '2026-08-18',
      last_day: '2026-11-15',
      n_calls: 100,
      n_abandoned: 10,
      n_quick: 5,
      quick_share_of_abandoned: 0.5,
      quick_share_of_calls: 0.05,
    },
  }
}

const controls = (efficiency: number) => ({
  efficiency,
  targetPct: 0.8,
  targetSec: 30,
  patienceSec: PATIENCE,
})
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 5000, interval: 20 })
function setInput(el: Element, value: string, event = 'input') {
  ;(el as HTMLInputElement).value = value
  el.dispatchEvent(new Event(event, { bubbles: true }))
}
// Once an answer is in, nothing on the page may still say it is loading.
function expectNothingLoading(wrapper: {
  text: () => string
  find: (s: string) => { exists: () => boolean; attributes: (n: string) => string | undefined }
}) {
  expect(wrapper.text()).not.toContain('Loading the forecast')
  expect(wrapper.text()).not.toContain('Checking data source')
  expect(wrapper.find('#sourceBadge').attributes('hidden')).toBeDefined()
}
function apiError(status: number, code: string, message: string, extra: object = {}) {
  return Object.assign(new Error(message), { status, code, data: { code, ...extra } })
}

describe('console', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset()
    mocks.status.mockReset()
    // no status route (the comparison's set-up): no note
    mocks.status.mockRejectedValue(apiError(404, 'error', 'Page not found: /api/status'))
    mocks.role = 'admin'
    localStorage.clear()
  })

  it('draws 48 hour cells with the cap state of every hour, from one request', async () => {
    const data = fixture()
    mocks.apiFetch.mockResolvedValue(data)
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.findAll('td.h[data-k]')).toHaveLength(48))
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mocks.apiFetch.mock.calls[0]!
    expect(url).toBe('/api/forecast')
    expect(options.query).toEqual({
      start: data.params.start,
      end: isoDate(new Date(Date.now() + 29 * 86_400_000)),
      queue_model: 'erlang_a',
      recency: 'weighted',
      include_holidays: 'true',
      efficiency: '0.66',
      target_pct: '0.80',
      target_sec: '30',
    })
    const expected = computeHours(data.hours, controls(EFF))
    const states = new Set<string>()
    for (const h of expected) {
      const td = wrapper.get(`td.h[data-k="${h.date}:${h.hour}"]`)
      expect(td.classes()).toContain(`cap-${h.cap_state}`)
      expect(td.find('.n').text()).toBe(String(h.staff_to_schedule))
      states.add(h.cap_state)
    }
    expect([...states].sort()).toEqual(['at', 'over', 'under'])
    // the six roster cells, one per tour and day
    expect(wrapper.findAll('td.roster[data-plan]')).toHaveLength(6)
  })

  it('shows the fixture in the badge, the sub-title and the tiles', async () => {
    const data = fixture()
    mocks.apiFetch.mockResolvedValue(data)
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.findAll('#summary .stat')).toHaveLength(4))
    expect(wrapper.get('#sourceBadge').text()).toBe(
      `Synthetic data, ${shortDate('2021-01-01')} 2021 to ${shortDate('2026-11-15')} 2026`
    )
    expect(wrapper.get('#sourceBadge').classes()).toContain('src-synthetic')
    expect(wrapper.get('#pageSub').text()).toContain('2 days')
    const s = summarize(computeHours(data.hours, controls(EFF)))
    const tiles = wrapper
      .findAll('#summary .stat')
      .map((t) => [t.get('.k').text(), t.get('.v').text()])
    expect(tiles[0]).toEqual(['Predicted calls', Math.round(s.calls).toLocaleString()])
    // Real calls sit right beside the total.
    expect(tiles[1]).toEqual(['Real calls', Math.round(s.realCalls).toLocaleString()])
    expect(tiles[3]).toEqual(['Person-hours to schedule', s.personHours!.toLocaleString()])
    expect(wrapper.get('#caveat').text()).toContain('measured from 1,234 past hang-ups')
  })

  it('recomputes in the browser when efficiency moves, without a second request', async () => {
    const data = fixture()
    mocks.apiFetch.mockResolvedValue(data)
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.findAll('td.h[data-k]')).toHaveLength(48))
    setInput(wrapper.get('#effNum').element, '50')
    const at50 = computeHours(data.hours, controls(0.5))
    await until(() => {
      for (const h of at50) {
        expect(wrapper.get(`td.h[data-k="${h.date}:${h.hour}"] .n`).text()).toBe(
          String(h.staff_to_schedule)
        )
      }
    })
    expect(wrapper.get('#changed').text()).toMatch(/hours? changed/)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('makes one request when a date changes', async () => {
    mocks.apiFetch.mockResolvedValue(fixture())
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1))
    await until(() => expect(wrapper.findAll('td.h[data-k]')).toHaveLength(48))
    setInput(wrapper.get('#end').element, '2027-01-31', 'change')
    await until(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2))
    expect(mocks.apiFetch.mock.calls[1]![1].query.end).toBe('2027-01-31')
    await new Promise((r) => setTimeout(r, 200))
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
  })

  it('shows the verdict of a planned number and keeps it across a remount', async () => {
    const data = fixture()
    mocks.apiFetch.mockResolvedValue(data)
    const first = await mountSuspended(ConsoleApp)
    await until(() => expect(first.findAll('td.roster[data-plan]')).toHaveLength(6))
    const cell = `td.roster[data-plan="${data.params.start}|Day"]`
    setInput(first.get(`${cell} input`).element, '1')
    await until(() => expect(first.get(cell).classes()).toContain('own'))
    expect(first.get(`${cell} .verdict`).text()).toMatch(/^Under -\d/)
    expect(first.get(`${cell} .verdict .lost`).text()).toMatch(/^\d+ lost · \d+%$/)
    expect(first.get(`${cell} .verdict`).classes()).toContain('v-understaffed')
    first.unmount()

    const second = await mountSuspended(ConsoleApp)
    await until(() => expect(second.find(cell).exists()).toBe(true))
    await until(() => expect(second.get(cell).classes()).toContain('own'))
    expect((second.get(`${cell} input`).element as HTMLInputElement).value).toBe('1')
    expect(localStorage.getItem('v4w.planned.v1')).toBe(
      JSON.stringify({ [`${data.params.start}|Day`]: 1 })
    )
  })

  it('one-day mode asks for one day and shows the hour-by-hour board', async () => {
    const data = fixture()
    mocks.apiFetch.mockResolvedValue(data)
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.findAll('td.h[data-k]')).toHaveLength(48))
    await wrapper.get('#modeDay').trigger('click')
    await until(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2))
    const q = mocks.apiFetch.mock.calls[1]![1].query
    expect(q.start).toBe(data.params.start)
    expect(q.end).toBe(data.params.start)
    await until(() => expect(wrapper.find('#dayFocus table.focus').exists()).toBe(true))
    expect(wrapper.get('#modeDay').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('#datesLabel').text()).toBe('Day')
    // 24 hours of the first date: the board's hour row
    expect(wrapper.findAll('#dayFocus tr.f-hours td')).toHaveLength(24)
    expect(wrapper.findAll('#dayFocusList button.hrow')).toHaveLength(24)
  })

  it('shows the no-forecast state, with the admin link for admins only', async () => {
    mocks.apiFetch.mockRejectedValue(
      apiError(
        503,
        'no_forecast',
        'No forecast yet. An admin needs to load call data and run a retrain.'
      )
    )
    const admin = await mountSuspended(ConsoleApp)
    await until(() => expect(admin.find('#noForecast').exists()).toBe(true))
    expect(admin.get('#noForecast').text()).toContain(
      'No forecast yet. An admin needs to load call data and run a retrain.'
    )
    await until(() => expect(admin.find('#noForecast a[href="/admin"]').exists()).toBe(true))
    expect(admin.find('#gridScroll').exists()).toBe(false)
    expect(admin.get('#error').attributes('hidden')).toBeDefined()
    expect(admin.get('#pageSub').text()).toBe('No forecast yet')
    expect(admin.find('#legend').exists()).toBe(false)
    expectNothingLoading(admin)
    admin.unmount()

    mocks.role = 'viewer'
    const viewer = await mountSuspended(ConsoleApp)
    await until(() => expect(viewer.find('#noForecast').exists()).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(viewer.find('#noForecast a').exists()).toBe(false)
    expect(viewer.find('#adminLink').exists()).toBe(false)
  })

  it('shows an error banner when the forecast does not load', async () => {
    mocks.apiFetch.mockRejectedValue(apiError(500, 'error', 'boom'))
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.get('#error').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#error').text()).toBe(
      'The forecast did not load (boom). Change a date to retry.'
    )
    expect(wrapper.findAll('td.h')).toHaveLength(0)
    expect(wrapper.get('#pageSub').text()).toBe('The forecast did not load')
    expectNothingLoading(wrapper)
  })

  it('shows the server sentence for dates outside the forecast', async () => {
    mocks.apiFetch.mockRejectedValue(
      apiError(400, 'outside_horizon', 'The forecast covers 2026-11-16 to 2029-01-24.')
    )
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.get('#error').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#error').text()).toBe('The forecast covers 2026-11-16 to 2029-01-24.')
    expect(wrapper.get('#pageSub').text()).toBe('No forecast for these dates')
    expectNothingLoading(wrapper)
  })

  // The read API refuses (503) to compute with a stored caller-patience estimate below
  // its minimum. Changing a date cannot help, and the server's sentence ends with advice
  // for API callers, so the page words it itself.
  it('says what is wrong with the call data when the stored caller patience is implausible', async () => {
    const server =
      'The stored caller-patience estimate (2 s) is implausibly small: the waiting times in ' +
      'the call data look wrong. An admin should fix them, reload the call data and run a ' +
      'retrain. Until then, send patience_sec (10 to 3600 s) or use queue_model=erlang_c.'
    mocks.apiFetch.mockRejectedValue(
      apiError(503, 'implausible_patience', server, { patience_sec: 2 })
    )
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.get('#error').attributes('hidden')).toBeUndefined())
    const text = wrapper.get('#error').text()
    expect(text).toBe(
      'The forecast cannot be shown. Measured from the call data, callers give up after 2 s ' +
        'on average, which is implausibly short: the waiting times in the call data look ' +
        'wrong. An admin needs to correct the call data and run a retrain.'
    )
    expect(text).not.toContain('Change a date')
    expect(text).not.toContain('patience_sec')
    expect(text).not.toContain('erlang_c')
    expect(wrapper.find('#noForecast').exists()).toBe(false)
    expect(wrapper.findAll('td.h')).toHaveLength(0)
    expect(wrapper.get('#pageSub').text()).toBe('The forecast did not load')
    expectNothingLoading(wrapper)
  })

  it('still names the problem when the stored caller patience is not a number at all', async () => {
    mocks.apiFetch.mockRejectedValue(
      apiError(503, 'implausible_patience', 'whatever the server says', { patience_sec: null })
    )
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.get('#error').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#error').text()).toBe(
      'The forecast cannot be shown. How long callers wait before they give up could not be ' +
        'measured from the call data: its waiting times look wrong. An admin needs to ' +
        'correct the call data and run a retrain.'
    )
  })

  it('a failed reload keeps the known data source and says the dates did not load', async () => {
    mocks.apiFetch.mockResolvedValueOnce(fixture())
    mocks.apiFetch.mockRejectedValueOnce(
      apiError(400, 'outside_horizon', 'The forecast covers 2026-11-16 to 2029-01-24.')
    )
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.findAll('td.h[data-k]')).toHaveLength(48))
    setInput(wrapper.get('#end').element, '2031-01-31', 'change')
    await until(() => expect(wrapper.get('#error').attributes('hidden')).toBeUndefined())
    expect(wrapper.get('#pageSub').text()).toBe('No forecast for these dates')
    expect(wrapper.get('#sourceBadge').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#sourceBadge').text()).toContain('Synthetic data')
  })

  it('an efficiency or service level the arithmetic refuses keeps the last valid numbers and says why', async () => {
    const data = fixture()
    mocks.apiFetch.mockResolvedValue(data)
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.findAll('td.h[data-k]')).toHaveLength(48))
    const cellText = () => wrapper.findAll('td.h[data-k] .n').map((n) => n.text())
    const atDefault = cellText()
    expect(wrapper.get('#controlError').attributes('hidden')).toBeDefined()

    for (const [field, value, words] of [
      ['#effNum', '150', 'Staff efficiency must be a number from 0 to 100%.'],
      ['#effNum', '-5', 'Staff efficiency must be a number from 0 to 100%.'],
      ['#slNum', '100', 'Calls answered in time must be a number from 1 to 99%.'],
      ['#slNum', '99.6', 'Calls answered in time must be a number from 1 to 99%.'],
      ['#slNum', '0', 'Calls answered in time must be a number from 1 to 99%.'],
      ['#tsec', '301', 'Answer time must be a number from 0 to 300 s.'],
    ] as const) {
      setInput(wrapper.get(field).element, value)
      await until(() => expect(wrapper.get('#controlError').attributes('hidden')).toBeUndefined())
      expect(wrapper.get('#controlError').text()).toBe(
        `${words} The numbers below are for the last valid setting.`
      )
      expect(cellText()).toEqual(atDefault)
      if (field !== '#tsec') {
        // leaving the field puts the slider's value back, as on the old page
        wrapper.get(field).element.dispatchEvent(new Event('change', { bubbles: true }))
        await until(() => expect(wrapper.get('#controlError').attributes('hidden')).toBeDefined())
      }
      // back to the default for the next case
      setInput(
        wrapper.get(field).element,
        field === '#effNum' ? '65.6' : field === '#slNum' ? '80' : '30'
      )
      wrapper.get(field).element.dispatchEvent(new Event('change', { bubbles: true }))
      await until(() => expect(cellText()).toEqual(atDefault))
      await until(() => expect(wrapper.get('#controlError').attributes('hidden')).toBeDefined())
    }
    // a date change while a value is refused still loads, with the last valid setting
    setInput(wrapper.get('#slNum').element, '100')
    setInput(wrapper.get('#tsec').element, '500')
    setInput(wrapper.get('#end').element, '2027-01-31', 'change')
    await until(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2))
    expect(mocks.apiFetch.mock.calls[1]![1].query).toMatchObject({
      target_pct: '0.80',
      target_sec: '30',
    })
    setInput(wrapper.get('#tsec').element, '30')
    expect(mocks.apiFetch.mock.calls[1]![1].query.target_pct).not.toBe('1.00')

    // a value both accept is used as typed (the old page did the same)
    wrapper.get('#slNum').element.dispatchEvent(new Event('change', { bubbles: true }))
    setInput(wrapper.get('#slNum').element, '50')
    const at50 = computeHours(data.hours, { ...controls(EFF), targetPct: 0.5 })
    await until(() => expect(cellText()).toEqual(at50.map((h) => String(h.staff_to_schedule))))
    expect(wrapper.get('#controlError').attributes('hidden')).toBeDefined()
  })

  describe('status note', () => {
    function status(runStatus: RunStatus | null, stale: boolean, forecast = true): StatusResponse {
      return {
        viewer: { email: 'a@example.org', name: 'a', role: mocks.role },
        data_source: { kind: 'synthetic', label: 'Synthetic data' },
        forecast: forecast
          ? {
              run_id: 3,
              generated_at: '2026-11-19T08:40:00Z',
              horizon_start: '2026-11-16',
              horizon_end: '2029-01-24',
              data_start: '2021-01-01',
              data_end: '2026-11-15',
              calls_count: 389234,
              stale,
            }
          : null,
        model: null,
        run:
          runStatus === null
            ? null
            : {
                id: 4,
                trigger: 'import',
                mode: 'full',
                status: runStatus,
                requested_by: 'admin@example.org',
                upload_id: 2,
                created_at: '2026-11-19T09:00:00Z',
                started_at: null,
                finished_at: null,
                trained: null,
                gate_passed: null,
                forecast_written: null,
                model_id: null,
                calls_count: null,
                data_start: null,
                data_end: null,
                horizon_start: null,
                horizon_end: null,
                message: null,
              },
      }
    }
    const through = `The forecast below still uses calls through ${shortDate('2026-11-15')} 2026.`
    async function mountWith(answer: StatusResponse) {
      mocks.apiFetch.mockResolvedValue(fixture())
      mocks.status.mockResolvedValue(answer)
      const wrapper = await mountSuspended(ConsoleApp)
      await until(() => expect(wrapper.findAll('td.h[data-k]')).toHaveLength(48))
      await until(() => expect(mocks.status).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 50))
      return wrapper
    }

    it('says nothing in the normal state', async () => {
      for (const answer of [
        status('succeeded', false),
        status(null, false),
        // a rejected run refreshed the forecast with the previous model: current
        status('rejected', false),
        status('failed', false),
      ]) {
        const wrapper = await mountWith(answer)
        expect(wrapper.find('#statusNote').exists()).toBe(false)
        wrapper.unmount()
      }
    })

    it('says nothing when the status request fails', async () => {
      const wrapper = await mountWith(status('running', true))
      wrapper.unmount()
      mocks.status.mockReset()
      mocks.status.mockRejectedValue(apiError(500, 'error', 'boom'))
      const again = await mountSuspended(ConsoleApp)
      await until(() => expect(again.findAll('td.h[data-k]')).toHaveLength(48))
      await until(() => expect(mocks.status).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 50))
      expect(again.find('#statusNote').exists()).toBe(false)
      expect(again.get('#error').attributes('hidden')).toBeDefined()
    })

    it('tells that new call data is being processed while a run is queued or running', async () => {
      for (const runStatus of ['queued', 'running'] as const) {
        const wrapper = await mountWith(status(runStatus, true))
        await until(() => expect(wrapper.find('#statusNote').exists()).toBe(true))
        expect(wrapper.get('#statusNote').text()).toBe(
          `New call data is being processed. ${through}`
        )
        expect(wrapper.get('#statusNote').classes()).toEqual(['banner', 'note'])
        expect(wrapper.find('#statusNote a').exists()).toBe(false)
        wrapper.unmount()
      }
    })

    it('tells that the forecast could not be updated, with the runs link for admins', async () => {
      for (const runStatus of ['failed', 'interrupted'] as const) {
        const wrapper = await mountWith(status(runStatus, true))
        await until(() => expect(wrapper.find('#statusNote').exists()).toBe(true))
        expect(wrapper.get('#statusNote').text()).toBe(
          `New call data was loaded but the forecast could not be updated. ${through} See the forecast runs`
        )
        await until(() =>
          expect(wrapper.get('#statusNote a').attributes('href')).toBe('/admin?tab=runs')
        )
        wrapper.unmount()
      }
      mocks.role = 'viewer'
      const viewer = await mountWith(status('failed', true))
      await until(() => expect(viewer.find('#statusNote').exists()).toBe(true))
      expect(viewer.get('#statusNote').text()).toBe(
        `New call data was loaded but the forecast could not be updated. ${through}`
      )
      expect(viewer.find('#statusNote a').exists()).toBe(false)
    })

    it('running, a failed answer, then succeeded: keeps the note, then reloads the forecast once', async () => {
      const wrapper = await mountWith(status('running', true))
      await until(() => expect(wrapper.find('#statusNote').exists()).toBe(true))
      const forecastCalls = mocks.apiFetch.mock.calls.length
      const visible = () => document.dispatchEvent(new Event('visibilitychange'))

      for (const failure of [
        apiError(500, 'error', 'boom'),
        { forecast: { data_end: 20261115, stale: 'x' }, run: { status: 'running' } },
      ]) {
        const statusCalls = mocks.status.mock.calls.length
        if (failure instanceof Error) mocks.status.mockRejectedValue(failure)
        else mocks.status.mockResolvedValue(failure)
        visible()
        await until(() => expect(mocks.status.mock.calls.length).toBe(statusCalls + 1))
        await new Promise((r) => setTimeout(r, 100))
        // a failed or malformed answer changes nothing the page shows
        expect(wrapper.get('#statusNote').text()).toBe(
          `New call data is being processed. ${through}`
        )
        expect(mocks.apiFetch.mock.calls.length).toBe(forecastCalls)
      }

      mocks.status.mockResolvedValue(status('succeeded', false))
      visible()
      await until(() => expect(wrapper.find('#statusNote').exists()).toBe(false))
      await until(() => expect(mocks.apiFetch.mock.calls.length).toBe(forecastCalls + 1))
      // asking again later reloads nothing more
      visible()
      await new Promise((r) => setTimeout(r, 300))
      expect(mocks.apiFetch.mock.calls.length).toBe(forecastCalls + 1)
    }, 30_000)
  })

  it('has Sign out always and Admin for admins', async () => {
    mocks.apiFetch.mockResolvedValue(fixture())
    const wrapper = await mountSuspended(ConsoleApp)
    await until(() => expect(wrapper.find('#adminLink').exists()).toBe(true))
    expect(wrapper.get('#adminLink').attributes('href')).toBe('/admin')
    expect(wrapper.get('#signOut').text()).toBe('Sign out')
    const actions = wrapper.findAll('.actions > *').map((e) => e.attributes('id'))
    expect(actions.slice(-2)).toEqual(['adminLink', 'signOut'])
  })
})
