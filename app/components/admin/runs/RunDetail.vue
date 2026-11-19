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
  const format = (value: number, percent: boolean) =>
    percent ? `${value.toFixed(2)}%` : value.toFixed(2)
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' }) : '–'
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
          <AdminRunsStatusBadge :status="run.status" />
          <span>{{ run.message }}</span>
        </div>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
          <dt class="text-gray-500 dark:text-gray-400">Created</dt>
          <dd>{{ when(run.created_at) }}</dd>
          <dt class="text-gray-500 dark:text-gray-400">Started</dt>
          <dd>{{ when(run.started_at) }}</dd>
          <dt class="text-gray-500 dark:text-gray-400">Finished</dt>
          <dd>{{ when(run.finished_at) }}</dd>
          <dt class="text-gray-500 dark:text-gray-400">Calls read</dt>
          <dd>
            <template v-if="run.calls_count !== null">
              {{ run.calls_count.toLocaleString('en-US') }} ({{ run.data_start }} to
              {{ run.data_end }})
            </template>
            <template v-else>–</template>
          </dd>
          <dt class="text-gray-500 dark:text-gray-400">Forecast covers</dt>
          <dd>
            <template v-if="run.horizon_start"
              >{{ run.horizon_start }} to {{ run.horizon_end }}</template
            >
            <template v-else>–</template>
          </dd>
          <dt class="text-gray-500 dark:text-gray-400">New model</dt>
          <dd>{{ run.trained === null ? '–' : run.trained ? 'Yes' : 'No' }}</dd>
          <dt class="text-gray-500 dark:text-gray-400">Exit code</dt>
          <dd>{{ run.exit_code ?? '–' }}</dd>
        </dl>

        <div v-if="run.gate">
          <h3 class="mb-2 font-semibold">
            Model against the simple baseline:
            {{ run.gate.passed ? 'passed' : 'not better, kept the previous model' }}
          </h3>
          <p class="mb-2 text-gray-500 dark:text-gray-400">
            {{ run.gate.origins }} backtests from {{ run.gate.first_origin }} to
            {{ run.gate.last_origin }}.
          </p>
          <table class="w-full text-left" data-testid="gate-table">
            <thead class="text-gray-500 dark:text-gray-400">
              <tr>
                <th class="py-1 pr-4 font-medium">Measure</th>
                <th class="py-1 pr-4 text-right font-medium">Model</th>
                <th class="py-1 text-right font-medium">Simple baseline</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="metric in METRICS"
                :key="metric.key"
                class="border-t border-gray-100 dark:border-gray-800"
              >
                <td class="py-1 pr-4">{{ metric.label }}</td>
                <td class="py-1 pr-4 text-right tabular-nums">
                  {{ format(run.gate.model[metric.key], metric.percent) }}
                </td>
                <td class="py-1 text-right tabular-nums">
                  {{ format(run.gate.naive[metric.key], metric.percent) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3 class="mb-2 font-semibold">Output (last part)</h3>
          <pre
            class="max-h-96 overflow-auto rounded-md bg-gray-50 p-3 text-xs break-all whitespace-pre-wrap dark:bg-gray-800"
            data-testid="log-tail"
            >{{ run.log_tail || 'No output.' }}</pre>
        </div>
      </div>
      <p v-else>Loading…</p>
    </template>
  </USlideover>
</template>
