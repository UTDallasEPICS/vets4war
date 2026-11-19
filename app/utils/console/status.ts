// Whether the forecast on the console is behind the call data, from GET /api/status:
// the note to show, the check of an answer's shape, and the polling while a run is
// active. No Vue and no fetch here, so the timing is testable with fake timers.
import type { RunStatus, StatusResponse } from '#shared/types/api'
import { shortDate } from './format'

// How often to ask while a run is queued or running.
export const POLL_MS = 60_000
// After a failed, slow or malformed answer the next question waits twice as long each
// time, up to this.
export const MAX_POLL_DELAY_MS = 600_000
// After this many failures in a row the page stops asking on its own (about 55 minutes
// of a server that does not answer); a tab that becomes visible asks once more.
export const MAX_POLL_FAILURES = 8

export type StatusNote =
  { kind: 'processing'; text: string } | { kind: 'failed'; text: string } | null

const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'succeeded',
  'rejected',
  'failed',
  'interrupted',
]
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// The parts of an answer the console reads, checked before any of them is used. Anything
// else (an error page, {}, null, wrong types) counts as a failed question.
export function isStatusResponse(x: unknown): x is StatusResponse {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (!('forecast' in o) || !('run' in o)) return false
  const f = o.forecast as Record<string, unknown> | null
  if (f !== null) {
    if (typeof f !== 'object') return false
    if (typeof f.data_end !== 'string' || !ISO_DATE.test(f.data_end)) return false
    if (typeof f.stale !== 'boolean') return false
  }
  const r = o.run as Record<string, unknown> | null
  if (r !== null) {
    if (typeof r !== 'object') return false
    if (!RUN_STATUSES.includes(r.status as RunStatus)) return false
  }
  return true
}

const dayText = (iso: string) => `${shortDate(iso)} ${iso.slice(0, 4)}`

// The note for a status answer: nothing when the forecast is current and no run is
// active. A rejected run refreshed the forecast with the previous model, so it is not a
// failure for the people reading the forecast.
export function statusNote(status: StatusResponse | null): StatusNote {
  const forecast = status?.forecast
  const run = status?.run
  if (!forecast || !run) return null
  const through = `The forecast below still uses calls through ${dayText(forecast.data_end)}.`
  if (run.status === 'queued' || run.status === 'running') {
    return { kind: 'processing', text: `New call data is being processed. ${through}` }
  }
  if (forecast.stale && (run.status === 'failed' || run.status === 'interrupted')) {
    return {
      kind: 'failed',
      text: `New call data was loaded but the forecast could not be updated. ${through}`,
    }
  }
  return null
}

export const runActive = (s: StatusResponse | null) =>
  s?.run?.status === 'queued' || s?.run?.status === 'running'

export interface StatusPollerOptions {
  // asks the server; may throw, hang until its own timeout, or return anything
  fetch: () => Promise<unknown>
  // a well-formed answer arrived
  onStatus: (status: StatusResponse) => void
  // a run that was last seen active has been seen ended: load the new forecast
  onSettled: () => void
}

// Keeps the last well-formed answer: a failed, slow or malformed answer never changes
// what the page believes. While the last known run is active it asks again after
// POLL_MS, backing off after failures and stopping after MAX_POLL_FAILURES of them in a
// row. When an answer shows the run ended, onSettled runs once. In the normal state (no
// active run) nothing is scheduled.
export function createStatusPoller(o: StatusPollerOptions) {
  let last: StatusResponse | null = null
  let failures = 0
  let inflight = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function schedule() {
    clearTimeout(timer)
    timer = undefined
    if (stopped || !runActive(last) || failures >= MAX_POLL_FAILURES) return
    const delay = failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** failures, MAX_POLL_DELAY_MS)
    timer = setTimeout(() => void poll(), delay)
  }

  async function poll(): Promise<void> {
    if (inflight || stopped) return
    inflight = true
    clearTimeout(timer)
    timer = undefined
    const answer = await Promise.resolve()
      .then(() => o.fetch())
      .then(
        (raw) => (isStatusResponse(raw) ? raw : null),
        () => null
      )
    inflight = false
    if (stopped) return
    if (answer) {
      const wasActive = runActive(last)
      last = answer
      failures = 0
      o.onStatus(answer)
      if (wasActive && !runActive(answer)) o.onSettled()
    } else {
      failures++
    }
    schedule()
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
    timer = undefined
  }

  return {
    poll,
    stop,
    get failures() {
      return failures
    },
    get scheduled() {
      return timer !== undefined
    },
  }
}
