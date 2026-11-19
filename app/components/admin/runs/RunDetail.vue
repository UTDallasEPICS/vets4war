<script setup lang="ts">
  // One run in a side panel: what it read, the gate table (the model against the simple
  // baseline) and the end of its output.
  import type { GateMetrics, RunDetail } from '#shared/types/api'

  const props = defineProps<{ runId: number | null }>()
  const emit = defineEmits<{ close: [] }>()

  const run = ref<RunDetail | null>(null)
  const problem = ref<string | null>(null)

  const open = computed({
    get: () => props.runId !== null,
    set: (value: boolean) => {
      if (!value) emit('close')
    },
  })

  watch(
    () => props.runId,
    async (id) => {
      run.value = null
      problem.value = null
      if (id === null) return
      try {
        run.value = (await apiFetch<{ run: RunDetail }>(`/api/admin/runs/${id}`)).run
      } catch (error) {
        problem.value = error instanceof Error ? error.message : 'The run could not be loaded.'
      }
    }
  )

  // Values arrive as Python's gate wrote them: percentages already, except the hourly
  // error, which is in calls. Errors are lower-is-better; week accuracy higher-is-better.
  const METRICS: { key: keyof GateMetrics; label: string; percent: boolean }[] = [
    { key: 'daily_mape_1_14', label: 'Daily error, days 1 to 14', percent: true },
    { key: 'daily_mape_15_28', label: 'Daily error, days 15 to 28', percent: true },
    { key: 'hourly_mae_1_14', label: 'Hourly error in calls, days 1 to 14', percent: false },
    { key: 'block_wape_1_14', label: 'Shift-block error, days 1 to 14', percent: true },
    { key: 'week_acc_mean', label: 'Week accuracy, mean', percent: true },
    { key: 'week_acc_std', label: 'Week accuracy, spread', percent: true },
    { key: 'week_acc_min', label: 'Week accuracy, worst week', percent: true },
    { key: 'week_total_ape', label: 'Week total error', percent: true },
  ]
  // A metric the backtest could not measure arrives as null.
  const format = (value: number | null, percent: boolean) =>
    value === null ? '–' : percent ? `${value.toFixed(2)}%` : value.toFixed(2)
  const runDuration = (r: RunDetail) => duration(r.started_at ?? r.created_at, r.finished_at)
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' }) : '–'
  // How long a run took, or "running" while it has not finished.
  function duration(start: string, end: string | null): string {
    if (!end) return 'running'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    const seconds = Math.max(0, Math.round(ms / 1000))
    const minutes = Math.floor(seconds / 60)
    return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`
  }
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="runId ? `Run ${runId}` : 'Run'"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <UAlert v-if="problem" color="error" variant="subtle" :title="problem" />
      <div v-else-if="run" class="min-w-0 space-y-6 text-sm break-words" data-testid="run-detail">
        <div class="flex items-center gap-3">
          <AdminRunsStatusBadge :status="run.status" :forecast-written="run.forecast_written" />
          <span>{{ run.message }}</span>
        </div>
        <dl
          class="bg-elevated grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 rounded-xl p-4"
        >
          <dt class="text-muted">Created</dt>
          <dd>{{ when(run.created_at) }}</dd>
          <dt class="text-muted">Started</dt>
          <dd>{{ when(run.started_at) }}</dd>
          <dt class="text-muted">Finished</dt>
          <dd>{{ when(run.finished_at) }}</dd>
          <dt class="text-muted">Took</dt>
          <dd>{{ runDuration(run) }}</dd>
          <dt class="text-muted">Calls read</dt>
          <dd>
            <template v-if="run.calls_count !== null">
              {{ run.calls_count.toLocaleString('en-US') }} ({{ run.data_start }} to
              {{ run.data_end }})
            </template>
            <template v-else>–</template>
          </dd>
          <dt class="text-muted">Forecast covers</dt>
          <dd>
            <template v-if="run.horizon_start"
              >{{ run.horizon_start }} to {{ run.horizon_end }}</template
            >
            <template v-else>–</template>
          </dd>
          <dt class="text-muted">New model</dt>
          <dd>{{ run.trained === null ? '–' : run.trained ? 'Yes' : 'No' }}</dd>
          <dt class="text-muted">Exit code</dt>
          <dd>{{ run.exit_code ?? '–' }}</dd>
        </dl>

        <div v-if="run.gate">
          <h3 class="mb-2 text-[15px] font-semibold">
            Model against the simple baseline:
            {{
              run.gate.passed
                ? 'passed'
                : run.forecast_written
                  ? 'not better, kept the previous model'
                  : 'not better, and there was no previous model'
            }}
          </h3>
          <p class="text-muted mb-3">
            {{ run.gate.origins }} backtests from {{ run.gate.first_origin }} to
            {{ run.gate.last_origin }}.
          </p>
          <table class="data-table" data-testid="gate-table">
            <thead class="text-muted">
              <tr>
                <th>Measure</th>
                <th class="text-right">Model</th>
                <th class="text-right">Simple baseline</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="metric in METRICS" :key="metric.key">
                <td>{{ metric.label }}</td>
                <td class="text-right">
                  {{ format(run.gate.model[metric.key], metric.percent) }}
                </td>
                <td class="text-right">
                  {{ format(run.gate.naive[metric.key], metric.percent) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3 class="mb-2 text-[15px] font-semibold">Output (last part)</h3>
          <pre
            class="bg-elevated max-h-96 overflow-auto rounded-xl p-4 text-xs leading-relaxed break-all whitespace-pre-wrap"
            data-testid="log-tail"
            >{{ run.log_tail || 'No output.' }}</pre>
        </div>
      </div>
      <p v-else>Loading…</p>
    </template>
  </USlideover>
</template>
