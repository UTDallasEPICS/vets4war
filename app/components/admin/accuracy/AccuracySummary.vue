<script setup lang="ts">
  // The period's numbers: the partner's daily accuracy first, then the error measures the
  // old Python monitor reported. Counted over held-out days only.
  import type { AccuracyResponse, AccuracyStatus } from '#shared/types/api'
  import type { StatusTone } from '../StatusChip.vue'

  const props = defineProps<{ report: AccuracyResponse | null }>()

  const STATUS: Record<AccuracyStatus, { tone: StatusTone; label: string }> = {
    success: { tone: 'good', label: 'Measured' },
    not_held_out: { tone: 'warn', label: 'Nothing to measure' },
    no_forecast: { tone: 'warn', label: 'No forecast' },
    no_data: { tone: 'neutral', label: 'No calls' },
  }
  const EMPTY: Record<AccuracyStatus, string> = {
    success: '',
    not_held_out:
      'Every day with calls in these dates was in the training data of the model that ' +
      'forecast it, so it cannot show how accurate the forecast is.',
    no_forecast: 'There is no forecast for the days with calls in these dates.',
    no_data: 'No calls are stored for these dates. Load the actual calls under Call data.',
  }

  const chip = computed(() => (props.report ? STATUS[props.report.status] : null))
  const metrics = computed(() => props.report?.metrics ?? null)
  const biasWord = computed(() => {
    const bias = metrics.value?.total_bias_pct
    if (bias === null || bias === undefined || Math.abs(bias) < 0.05) return 'on the total'
    return bias > 0 ? 'forecast too high' : 'forecast too low'
  })
</script>

<template>
  <section class="tile space-y-5" aria-labelledby="accuracy-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="accuracy-title" class="tile-title">How close the forecast was</h2>
      <AdminStatusChip
        v-if="chip"
        :tone="chip.tone"
        :label="chip.label"
        data-testid="accuracy-status"
      />
    </div>

    <p v-if="!report" class="text-muted text-sm">Loading…</p>
    <template v-else-if="metrics">
      <div class="flex flex-wrap items-end gap-x-10 gap-y-4" data-testid="accuracy-headline">
        <div>
          <p class="num text-[44px]">{{ accuracyPct(metrics.daily_accuracy_pct) }}</p>
          <p class="stat-label mt-2">daily accuracy</p>
        </div>
        <div>
          <p class="num text-[22px]">
            {{
              metrics.total_bias_pct === null ? '–' : accuracySigned(metrics.total_bias_pct, 1, '%')
            }}
          </p>
          <p class="stat-label mt-2">{{ biasWord }}</p>
        </div>
      </div>

      <dl class="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4" data-testid="accuracy-metrics">
        <div>
          <dt class="stat-label">Miss per hour (MAE)</dt>
          <dd class="num mt-1.5 text-[17px]">{{ accuracyCalls(metrics.hourly_mae, 2, true) }}</dd>
        </div>
        <div>
          <dt class="stat-label">Hourly RMSE</dt>
          <dd class="num mt-1.5 text-[17px]">{{ accuracyCalls(metrics.hourly_rmse, 2, true) }}</dd>
        </div>
        <div>
          <dt class="stat-label">Miss per day</dt>
          <dd class="num mt-1.5 text-[17px]">
            {{ accuracyCalls(metrics.daily_total_mae, 1, true) }}
          </dd>
        </div>
        <div>
          <dt class="stat-label">Bias per hour</dt>
          <dd class="num mt-1.5 text-[17px]">{{ accuracySigned(metrics.signed_bias, 2) }}</dd>
        </div>
      </dl>

      <p class="text-muted text-[13px]">
        {{ metrics.days }} {{ metrics.days === 1 ? 'day' : 'days' }}:
        {{ accuracyCalls(metrics.actual_calls) }} calls came, the forecast said
        {{ accuracyCalls(metrics.predicted_calls) }}. Daily accuracy is 100 minus the average
        percentage miss on each day's total; the other figures are in calls.
      </p>
    </template>
    <p v-else class="text-muted text-sm" data-testid="accuracy-empty">
      {{ EMPTY[report.status] }}
    </p>

    <ul
      v-if="report?.warnings.length"
      class="text-toned space-y-1.5 text-[13px]"
      data-testid="accuracy-warnings"
    >
      <li v-for="warning in report.warnings" :key="warning" class="flex gap-2">
        <UIcon
          name="i-heroicons-information-circle-20-solid"
          class="text-warning mt-0.5 size-4 shrink-0"
        />
        <span>{{ warning }}</span>
      </li>
    </ul>
  </section>
</template>
