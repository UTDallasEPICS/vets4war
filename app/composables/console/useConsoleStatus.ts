// Whether the forecast on the page is behind the call data (GET /api/status). Asked
// once on load, again when the tab becomes visible, and every 60 s while a run is
// queued or running. A failed status request only means there is nothing to say: the
// console never depends on it.
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import type { StatusResponse } from '#shared/types/api'
import { shortDate } from '~/utils/console/format'

const POLL_MS = 60_000

export type StatusNote =
  { kind: 'processing'; text: string } | { kind: 'failed'; text: string } | null

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

// onSettled runs when a run that was active has ended, so the page can load the new
// forecast.
export function useConsoleStatus(onSettled: () => void) {
  const status = shallowRef<StatusResponse | null>(null)
  const note = computed(() => statusNote(status.value))
  const active = computed(() => note.value?.kind === 'processing')
  let timer: ReturnType<typeof setInterval> | undefined

  async function load() {
    try {
      status.value = await apiFetch<StatusResponse>('/api/status')
    } catch {
      status.value = null
    }
  }
  function onVisible() {
    if (document.visibilityState === 'visible') void load()
  }

  watch(active, (now, before) => {
    clearInterval(timer)
    timer = undefined
    if (now) timer = setInterval(() => void load(), POLL_MS)
    else if (before) onSettled()
  })

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisible)
    void load()
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisible)
    clearInterval(timer)
  })

  return { status, note, load }
}
