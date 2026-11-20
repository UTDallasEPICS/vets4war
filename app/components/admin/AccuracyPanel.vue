<script setup lang="ts">
  // Forecast accuracy: the forecast against the calls that came, for a period of days
  // (GET /api/admin/accuracy). No props, no emits (the admin page's contract).
  import type { AccuracyResponse } from '#shared/types/api'

  const report = ref<AccuracyResponse | null>(null)
  const problem = ref<string | null>(null)
  const loading = ref(false)
  const range = reactive({ start: '', end: '' })

  async function load(query?: { start?: string; end?: string }) {
    loading.value = true
    try {
      report.value = await apiFetch<AccuracyResponse>('/api/admin/accuracy', { query })
      problem.value = null
      range.start = report.value.period?.start ?? ''
      range.end = report.value.period?.end ?? ''
    } catch (error) {
      problem.value = error instanceof Error ? error.message : 'The accuracy could not be loaded.'
    } finally {
      loading.value = false
    }
  }

  function check() {
    load({ start: range.start || undefined, end: range.end || undefined })
  }

  onMounted(() => load())
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <AdminAccuracySummary :report="report" />

      <section class="tile flex flex-col gap-4" aria-labelledby="accuracy-dates-title">
        <h2 id="accuracy-dates-title" class="tile-title">Dates to check</h2>
        <form class="flex flex-wrap items-end gap-3" @submit.prevent="check">
          <UFormField label="From" name="start">
            <UInput v-model="range.start" type="date" class="w-40" data-testid="accuracy-start" />
          </UFormField>
          <UFormField label="To" name="end">
            <UInput v-model="range.end" type="date" class="w-40" data-testid="accuracy-end" />
          </UFormField>
          <UButton
            type="submit"
            label="Check"
            icon="i-heroicons-magnifying-glass-20-solid"
            :loading="loading"
            data-testid="accuracy-check"
          />
        </form>
        <p v-if="report?.calls_range" class="text-muted text-[13px]">
          Calls are stored from {{ report.calls_range.first_day }} to
          {{ report.calls_range.last_day }}. Without dates, the last two weeks of them.
        </p>
        <p class="text-muted text-[13px]">
          Each day is compared with the forecast kept when its calls were imported, or else with the
          forecast in use now. A day the model was trained on shows how well it fits, not how well
          it forecasts, so it is listed but not counted.
        </p>
        <UAlert
          v-if="problem"
          color="error"
          variant="subtle"
          icon="i-heroicons-exclamation-triangle-20-solid"
          :title="problem"
          data-testid="accuracy-problem"
        />
      </section>
    </div>

    <AdminAccuracyDays :days="report?.days ?? []" />
  </div>
</template>
