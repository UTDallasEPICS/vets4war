<script setup lang="ts">
  // What a checked file holds and what importing it would do, day by day.
  import type { DayStatus, UploadDetail } from '#shared/types/api'

  const props = defineProps<{ upload: UploadDetail }>()

  // Long files show only the days that would change something, unless asked.
  const COLLAPSE_OVER = 14
  const showAll = ref(false)

  const report = computed(() => props.upload.report!)
  const changing = computed(() => report.value.days.filter((d) => d.status !== 'identical'))
  const collapsed = computed(() => report.value.days.length > COLLAPSE_OVER && !showAll.value)
  const shown = computed(() => (collapsed.value ? changing.value : report.value.days))

  const STATUS: Record<DayStatus, { label: string; color: 'success' | 'neutral' | 'warning' }> = {
    new: { label: 'New', color: 'success' },
    identical: { label: 'Already loaded', color: 'neutral' },
    conflict: { label: 'Different', color: 'warning' },
  }
  const number = (n: number) => n.toLocaleString('en-US')
</script>

<template>
  <div class="space-y-4" data-testid="upload-report">
    <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
      <div>
        <dt class="text-gray-500 dark:text-gray-400">First day</dt>
        <dd class="font-medium">{{ report.summary.first_day ?? '–' }}</dd>
      </div>
      <div>
        <dt class="text-gray-500 dark:text-gray-400">Last day</dt>
        <dd class="font-medium">{{ report.summary.last_day ?? '–' }}</dd>
      </div>
      <div>
        <dt class="text-gray-500 dark:text-gray-400">Calls in the file</dt>
        <dd class="font-medium" data-testid="total-rows">
          {{ number(report.summary.total_rows) }}
        </dd>
      </div>
      <div>
        <dt class="text-gray-500 dark:text-gray-400">Days</dt>
        <dd class="font-medium" data-testid="day-counts">
          {{ report.summary.new_days }} new, {{ report.summary.identical_days }} already loaded,
          {{ report.summary.conflict_days }} different
        </dd>
      </div>
    </dl>

    <UAlert
      v-for="issue in report.file_errors"
      :key="issue.code + issue.message"
      color="error"
      variant="subtle"
      :title="issue.message"
      data-testid="file-error"
    />
    <UAlert
      v-for="warning in report.warnings"
      :key="warning"
      color="warning"
      variant="subtle"
      :title="warning"
      data-testid="file-warning"
    />

    <div v-if="report.days.length" class="relative overflow-x-auto">
      <table class="w-full text-left text-sm" data-testid="day-table">
        <thead class="text-gray-500 dark:text-gray-400">
          <tr>
            <th class="py-1 pr-4 font-medium">Date</th>
            <th class="py-1 pr-4 text-right font-medium">Calls in the file</th>
            <th class="py-1 pr-4 text-right font-medium">Calls stored</th>
            <th class="py-1 font-medium">What happens</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="day in shown"
            :key="day.day"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="py-1 pr-4 tabular-nums">{{ day.day }}</td>
            <td class="py-1 pr-4 text-right tabular-nums">{{ number(day.rows) }}</td>
            <td class="py-1 pr-4 text-right tabular-nums">{{ number(day.existing_rows) }}</td>
            <td class="py-1">
              <UBadge :color="STATUS[day.status].color" variant="subtle">
                {{ STATUS[day.status].label }}
              </UBadge>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="collapsed" class="mt-2 text-sm text-gray-600 dark:text-gray-300">
        Showing the {{ changing.length }} day(s) that would change; the other
        {{ report.days.length - changing.length }} are already loaded.
        <UButton variant="link" class="px-1" label="Show all days" @click="showAll = true" />
      </p>
    </div>
  </div>
</template>
