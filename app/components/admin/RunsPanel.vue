<script setup lang="ts">
  // Forecast runs: what the call data holds, the run in progress, buttons to retrain or
  // refresh by hand, and every recent run with its gate table and output. No props, no
  // emits (the admin page's contract).
  import type { RunMode, RunSummary, StatusResponse } from '#shared/types/api'

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
  const status = ref<StatusResponse | null>(null)
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
      ;[overview.value, status.value] = await Promise.all([
        apiFetch<Overview>('/api/admin/runs'),
        apiFetch<StatusResponse>('/api/status'),
      ])
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
  <div class="space-y-4">
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <section class="tile space-y-5" aria-labelledby="forecast-title">
        <h2 id="forecast-title" class="tile-title">Forecast in use</h2>
        <div data-testid="data-line">
          <p v-if="!overview" class="text-muted text-sm">Loading…</p>
          <div v-else-if="hasCalls" class="flex flex-wrap items-end gap-x-10 gap-y-4">
            <div>
              <p class="num text-[44px]">
                {{ overview.data.calls_count.toLocaleString('en-US') }}
              </p>
              <p class="stat-label mt-2">calls stored</p>
            </div>
            <div>
              <p class="num text-[22px]">
                {{ overview.data.first_day }} to {{ overview.data.last_day }}
              </p>
              <p class="stat-label mt-2">days they cover</p>
            </div>
          </div>
          <p v-else class="text-muted text-sm">
            No call data yet. Load a call-records file under
            <NuxtLink to="/admin?tab=uploads" class="text-link">Call data</NuxtLink>.
          </p>
        </div>

        <AdminRunsForecastState
          :status="status"
          :runs="overview?.runs ?? []"
          :active-run-id="overview?.active_run_id ?? null"
          :last-day="overview?.data.last_day ?? null"
        />
      </section>

      <section class="tile flex flex-col gap-4" aria-labelledby="update-title">
        <h2 id="update-title" class="tile-title">Update the forecast</h2>

        <div
          v-if="active"
          class="text-primary flex items-center gap-3 rounded-xl bg-[var(--v4w-accent-soft)] px-4 py-3 text-sm"
          data-testid="active-run"
        >
          <span
            class="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          <span class="font-medium">
            Run {{ active.id }} ({{ active.mode === 'full' ? 'retrain' : 'forecast refresh' }}) is
            running: {{ elapsed(active.started_at ?? active.created_at) }} so far.
          </span>
        </div>

        <div class="space-y-3">
          <div class="bg-default flex flex-col gap-2 rounded-xl p-4">
            <UButton
              label="Retrain now"
              icon="i-heroicons-arrow-path-20-solid"
              class="self-start"
              :disabled="!hasCalls || starting !== null"
              :loading="starting === 'full'"
              data-testid="retrain-now"
              @click="start('full')"
            />
            <p class="text-muted text-[13px]">
              Fits a new model on all stored calls and keeps it only if it beats the simple
              baseline. Takes a few minutes.
            </p>
          </div>
          <div class="bg-default flex flex-col gap-2 rounded-xl p-4">
            <UButton
              label="Refresh forecast"
              icon="i-heroicons-forward-20-solid"
              color="neutral"
              variant="soft"
              class="self-start"
              :disabled="!hasCalls || starting !== null"
              :loading="starting === 'forecast-only'"
              data-testid="refresh-forecast"
              @click="start('forecast-only')"
            />
            <p class="text-muted text-[13px]">
              Keeps the model in use and moves the forecast forward from the newest calls.
            </p>
          </div>
        </div>

        <UAlert
          v-if="notice"
          color="info"
          variant="subtle"
          icon="i-heroicons-information-circle-20-solid"
          :title="notice"
          data-testid="run-notice"
        />
        <UAlert
          v-if="problem"
          color="error"
          variant="subtle"
          icon="i-heroicons-exclamation-triangle-20-solid"
          :title="problem"
        />
      </section>
    </div>

    <AdminRunsRunList :runs="overview?.runs ?? []" @open="detailId = $event" />
    <AdminRunsRunDetail :run-id="detailId" @close="detailId = null" />
  </div>
</template>
