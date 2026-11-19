// The console's /api/status handling: the shape check, the note, and the polling while a
// run is active, driven with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunStatus, StatusResponse } from '#shared/types/api'
import {
  MAX_POLL_FAILURES,
  POLL_MS,
  createStatusPoller,
  isStatusResponse,
  statusNote,
} from '../../../app/utils/console/status'

function status(runStatus: RunStatus | null, stale = false): StatusResponse {
  return {
    viewer: { email: 'a@example.org', name: 'a', role: 'viewer' },
    data_source: { kind: 'synthetic', label: 'Synthetic data' },
    forecast: {
      run_id: 3,
      generated_at: '2026-11-19T08:40:00Z',
      horizon_start: '2026-11-16',
      horizon_end: '2029-01-24',
      data_start: '2021-01-01',
      data_end: '2026-11-15',
      calls_count: 389234,
      stale,
    },
    model: null,
    run:
      runStatus === null
        ? null
        : ({ id: 4, status: runStatus } as unknown as StatusResponse['run']),
  }
}

const MALFORMED: unknown[] = [
  null,
  {},
  '<html>Bad gateway</html>',
  'not json',
  { forecast: { data_end: 20261115, stale: 'yes' }, run: { status: 'running' } },
  { forecast: null, run: { status: 'sleeping' } },
  { forecast: { data_end: '15/11/2026', stale: false }, run: null },
]

// fetch answers in order: a value resolves, an Error rejects, 'slow' rejects after 20 s
// (what apiFetch's timeout does)
function answers(list: unknown[]) {
  const queue = [...list]
  return vi.fn(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next === 'slow') {
      return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000))
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
}

function poller(list: unknown[]) {
  const fetch = answers(list)
  const onStatus = vi.fn()
  const onSettled = vi.fn()
  const p = createStatusPoller({ fetch, onStatus, onSettled })
  return { p, fetch, onStatus, onSettled }
}

const HOUR = 3_600_000

describe('isStatusResponse and statusNote', () => {
  it('accepts the documented shape and refuses anything else', () => {
    expect(isStatusResponse(status('running'))).toBe(true)
    expect(isStatusResponse({ ...status(null), forecast: null })).toBe(true)
    for (const m of MALFORMED) expect(isStatusResponse(m)).toBe(false)
  })

  it('never throws on what it is given after the check', () => {
    for (const m of MALFORMED) {
      expect(() => statusNote(isStatusResponse(m) ? m : null)).not.toThrow()
    }
    expect(statusNote(null)).toBeNull()
  })
})

describe('status polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks once and never again in the normal state', async () => {
    for (const first of [status('succeeded'), status(null), status('rejected'), status('failed')]) {
      const { p, fetch, onSettled } = poller([first])
      await p.poll()
      expect(p.scheduled).toBe(false)
      await vi.advanceTimersByTimeAsync(5 * HOUR)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(onSettled).not.toHaveBeenCalled()
      p.stop()
    }
  })

  it('asks nothing more when the first answer fails (nothing known to follow)', async () => {
    const { p, fetch } = poller([new Error('500')])
    await p.poll()
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('asks every 60 s while a run is active and reloads once when it ends', async () => {
    const { p, fetch, onSettled } = poller([
      status('queued'),
      status('running'),
      status('running'),
      status('succeeded'),
    ])
    await p.poll()
    await vi.advanceTimersByTimeAsync(POLL_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(p.scheduled).toBe(false)
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('running, one failed answer, then succeeded: keeps the status and reloads once', async () => {
    const { p, fetch, onStatus, onSettled } = poller([
      status('running'),
      new Error('500 Internal Server Error'),
      status('succeeded'),
    ])
    await p.poll()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    // the failure changed nothing the page believes
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onSettled).not.toHaveBeenCalled()
    expect(p.failures).toBe(1)
    // the next question waits twice as long
    await vi.advanceTimersByTimeAsync(2 * POLL_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onStatus).toHaveBeenLastCalledWith(status('succeeded'))
    expect(onSettled).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('a server that keeps failing is asked less and less often, then no more', async () => {
    const { p, fetch, onSettled } = poller([status('running'), new Error('down')])
    await p.poll()
    // seconds after start at which the page asks again: 60, then doubling to a 10 min cap
    const expected = [60, 180, 420, 900, 1500, 2100, 2700, 3300]
    let now = 0
    for (const at of expected) {
      await vi.advanceTimersByTimeAsync((at - now) * 1000 - 1)
      const before = fetch.mock.calls.length
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch.mock.calls.length).toBe(before + 1)
      now = at
    }
    expect(p.failures).toBe(MAX_POLL_FAILURES)
    expect(p.scheduled).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(fetch).toHaveBeenCalledTimes(1 + expected.length)
    expect(onSettled).not.toHaveBeenCalled()
    // a tab that becomes visible asks once more; an answer brings polling back
    fetch.mockImplementation(() => Promise.resolve(status('running')))
    await p.poll()
    expect(p.failures).toBe(0)
    expect(p.scheduled).toBe(true)
    fetch.mockImplementation(() => Promise.resolve(status('succeeded')))
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('malformed answers count as failed ones and change nothing', async () => {
    const { p, fetch, onStatus, onSettled } = poller([
      status('running'),
      ...MALFORMED,
      status('succeeded'),
    ])
    await p.poll()
    expect(onStatus).toHaveBeenCalledTimes(1)
    // MALFORMED.length failures (7, under the bound of 8), then the good answer
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(fetch).toHaveBeenCalledTimes(MALFORMED.length + 2)
    expect(onStatus).toHaveBeenCalledTimes(2)
    expect(onStatus).toHaveBeenLastCalledWith(status('succeeded'))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('a slow answer is a failed one, and no second question goes out meanwhile', async () => {
    const { p, fetch, onSettled } = poller([status('running'), 'slow', status('succeeded')])
    await p.poll()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    // a visibility change while the slow question is out asks nothing more
    void p.poll()
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(p.failures).toBe(1)
    await vi.advanceTimersByTimeAsync(2 * POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('stop() ends the polling', async () => {
    const { p, fetch } = poller([status('running')])
    await p.poll()
    p.stop()
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
