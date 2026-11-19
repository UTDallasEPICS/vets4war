<script setup lang="ts">
  // Forecast runs: what the call data holds, the run in progress, buttons to retrain or
  // refresh by hand, and every recent run with its gate table and output. No props, no
  // emits (the admin page's contract).
  import type { RunMode, RunSummary } from '#shared/types/api'

  interface Overview {
    runs: RunSummary[]
    active_run_id: number | null
    data: {
      calls_revision: number
      calls_count: number
      first_day: string | null
      last_day: string | null
    }
  }

  const ACTIVE_POLL_MS = 3000
  const IDLE_POLL_MS = 30_000

  const overview = ref<Overview | null>(null)
  const problem = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const starting = ref<RunMode | null>(null)
  const detailId = ref<number | null>(null)
  const now = ref(Date.now())
  let poll: ReturnType<typeof setTimeout> | null = null
  let clock: ReturnType<typeof setInterval> | null = null

  const active = computed(
    () => overview.value?.runs.find((run) => run.id === overview.value?.active_run_id) ?? null
  )
  const hasCalls = computed(() => (overview.value?.data.calls_count ?? 0) > 0)

  function elapsed(since: string): string {
    const seconds = Math.max(0, Math.floor((now.value - new Date(since).getTime()) / 1000))
    const minutes = Math.floor(seconds / 60)
    return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`
  }

  async function load() {
    if (poll) clearTimeout(poll)
    try {
      overview.value = await apiFetch<Overview>('/api/admin/runs')
      problem.value = null
    } catch (error) {
      problem.value = error instanceof Error ? error.message : 'The runs could not be loaded.'
    }
    poll = setTimeout(load, overview.value?.active_run_id ? ACTIVE_POLL_MS : IDLE_POLL_MS)
  }

  async function start(mode: RunMode) {
    starting.value = mode
    notice.value = null
    problem.value = null
    try {
      const { run, queued } = await apiFetch<{ run: RunSummary; queued: boolean }>(
        '/api/admin/runs',
        { method: 'POST', body: { mode } }
      )
      notice.value = queued
        ? `Run ${run.id} is still in progress. One more retrain is queued and starts when it ends.`
        : `Run ${run.id} started.`
    } catch (error) {
      problem.value = error instanceof Error ? error.message : 'The run could not be started.'
    } finally {
      starting.value = null
      await load()
    }
  }

  onMounted(() => {
    load()
    clock = setInterval(() => (now.value = Date.now()), 1000)
  })
  onBeforeUnmount(() => {
    if (poll) clearTimeout(poll)
    if (clock) clearInterval(clock)
  })
</script>

<template>
  <div class="space-y-6">
    <UCard>
      <template #header>
        <h2 class="text-lg font-semibold">Forecast</h2>
      </template>
      <div class="space-y-4">
        <p class="text-sm" data-testid="data-line">
          <template v-if="!overview">Loading…</template>
          <template v-else-if="hasCalls">
            {{ overview.data.calls_count.toLocaleString('en-US') }} calls stored, from
            {{ overview.data.first_day }} to {{ overview.data.last_day }}.
          </template>
          <template v-else>No call data yet. Load a call-records file under Call data.</template>
        </p>

        <div
          v-if="active"
          class="bg-primary-50 dark:bg-primary-950 flex items-center gap-3 rounded-md p-3 text-sm"
          data-testid="active-run"
        >
          <span
            class="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          <span>
            Run {{ active.id }} ({{ active.mode === 'full' ? 'retrain' : 'forecast refresh' }}) is
            running: {{ elapsed(active.started_at ?? active.created_at) }} so far.
          </span>
        </div>

        <div class="flex flex-wrap gap-3">
          <UButton
            label="Retrain now"
            :disabled="!hasCalls || starting !== null"
            :loading="starting === 'full'"
            data-testid="retrain-now"
            @click="start('full')"
          />
          <UButton
            label="Refresh forecast"
            color="neutral"
            variant="outline"
            :disabled="!hasCalls || starting !== null"
            :loading="starting === 'forecast-only'"
            data-testid="refresh-forecast"
            @click="start('forecast-only')"
          />
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          Retrain fits a new model on all stored calls and keeps it only if it beats the simple
          baseline. Refresh keeps the current model and moves the forecast forward.
        </p>
        <UAlert
          v-if="notice"
          color="info"
          variant="subtle"
          :title="notice"
          data-testid="run-notice"
        />
        <UAlert v-if="problem" color="error" variant="subtle" :title="problem" />
      </div>
    </UCard>

    <AdminRunsRunList :runs="overview?.runs ?? []" @open="detailId = $event" />
    <AdminRunsRunDetail :run-id="detailId" @close="detailId = null" />
  </div>
</template>
