// Whether the forecast on the page is behind the call data (GET /api/status). Asked
// once on load, again when the tab becomes visible, and while a run is queued or
// running every 60 s (backing off after failures; app/utils/console/status.ts). A
// failed, slow or malformed answer never changes what the page shows: the console never
// depends on it.
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import type { StatusResponse } from '#shared/types/api'
import { createStatusPoller, statusNote } from '~/utils/console/status'

export { statusNote }
export type { StatusNote } from '~/utils/console/status'

// A status answer that takes longer than this counts as a failed one.
const STATUS_TIMEOUT_MS = 20_000

// onSettled runs when a run that was active has been seen ended, so the page can load
// the new forecast.
export function useConsoleStatus(onSettled: () => void) {
  const status = shallowRef<StatusResponse | null>(null)
  const note = computed(() => statusNote(status.value))
  const poller = createStatusPoller({
    fetch: () => apiFetch<unknown>('/api/status', { timeout: STATUS_TIMEOUT_MS }),
    onStatus: (s) => {
      status.value = s
    },
    onSettled,
  })

  function onVisible() {
    if (document.visibilityState === 'visible') void poller.poll()
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisible)
    void poller.poll()
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisible)
    poller.stop()
  })

  return { status, note, load: poller.poll }
}
