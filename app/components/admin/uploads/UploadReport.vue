<script setup lang="ts">
  // What a checked file holds and what importing it would do, day by day.
  import type { DayStatus, UploadDetail } from '#shared/types/api'

  const props = defineProps<{ upload: UploadDetail }>()

  // A long file (the multi-year export has over 2,000 days) groups runs of consecutive
  // days with the same outcome into one line, so the import form below stays in reach;
  // a different day is always its own line. "Show every day" lists them all.
  const COLLAPSE_OVER = 14
  const showAll = ref(false)

  interface Line {
    key: string
    first: string
    last: string
    days: number
    rows: number
    existing: number
    status: DayStatus
  }

  const report = computed(() => props.upload.report!)
  const collapsed = computed(() => report.value.days.length > COLLAPSE_OVER && !showAll.value)
  const nextDay = (day: string) => {
    const date = new Date(`${day}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + 1)
    return date.toISOString().slice(0, 10)
  }
  const lines = computed<Line[]>(() => {
    const out: Line[] = []
    for (const day of report.value.days) {
      const last = out[out.length - 1]
      if (
        collapsed.value &&
        last &&
        day.status !== 'conflict' &&
        last.status === day.status &&
        nextDay(last.last) === day.day
      ) {
        last.last = day.day
        last.days++
        last.rows += day.rows
        last.existing += day.existing_rows
        continue
      }
      out.push({
        key: day.day,
        first: day.day,
        last: day.day,
        days: 1,
        rows: day.rows,
        existing: day.existing_rows,
        status: day.status,
      })
    }
    return out
  })
  const grouped = computed(() => lines.value.length < report.value.days.length)

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
            v-for="line in lines"
            :key="line.key"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="py-1 pr-4 whitespace-nowrap tabular-nums">
              <template v-if="line.days === 1">{{ line.first }}</template>
              <template v-else>
                {{ line.first }} to {{ line.last }}
                <span class="text-gray-500 dark:text-gray-400">({{ number(line.days) }} days)</span>
              </template>
            </td>
            <td class="py-1 pr-4 text-right tabular-nums">{{ number(line.rows) }}</td>
            <td class="py-1 pr-4 text-right tabular-nums">{{ number(line.existing) }}</td>
            <td class="py-1">
              <UBadge :color="STATUS[line.status].color" variant="subtle">
                {{ STATUS[line.status].label }}
              </UBadge>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="grouped" class="mt-2 text-sm text-gray-600 dark:text-gray-300">
        Days in a row with the same outcome are shown as one line.
        <UButton
          variant="link"
          class="px-1"
          :label="`Show all ${number(report.days.length)} days`"
          data-testid="show-all-days"
          @click="showAll = true"
        />
      </p>
    </div>
  </div>
</template>
