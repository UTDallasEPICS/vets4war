<script setup lang="ts">
  // What a checked file holds and what importing it would do, day by day.
  import type { DayStatus, UploadDetail } from '#shared/types/api'
  import type { StatusTone } from '../StatusChip.vue'

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

  const STATUS: Record<DayStatus, { label: string; tone: StatusTone }> = {
    new: { label: 'New', tone: 'good' },
    identical: { label: 'Already loaded', tone: 'neutral' },
    conflict: { label: 'Different', tone: 'warn' },
  }
  const number = (n: number) => n.toLocaleString('en-US')
</script>

<template>
  <div class="space-y-4" data-testid="upload-report">
    <!-- A file refused while it was read has no days to count: zeros would mislead. -->
    <dl
      v-if="report.days.length"
      class="grid grid-cols-2 gap-2 lg:grid-cols-4"
      data-testid="report-summary"
    >
      <div class="bg-default space-y-2 rounded-xl p-4">
        <dt class="stat-label">First day</dt>
        <dd class="num text-[22px]">{{ report.summary.first_day ?? '–' }}</dd>
      </div>
      <div class="bg-default space-y-2 rounded-xl p-4">
        <dt class="stat-label">Last day</dt>
        <dd class="num text-[22px]">{{ report.summary.last_day ?? '–' }}</dd>
      </div>
      <div class="bg-default space-y-2 rounded-xl p-4">
        <dt class="stat-label">Calls in the file</dt>
        <dd class="num text-[22px]" data-testid="total-rows">
          {{ number(report.summary.total_rows) }}
        </dd>
      </div>
      <div class="bg-default space-y-2 rounded-xl p-4">
        <dt class="stat-label">Days</dt>
        <dd class="text-[13px] leading-snug font-medium" data-testid="day-counts">
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
      icon="i-heroicons-x-circle-20-solid"
      :title="issue.message"
      data-testid="file-error"
    />
    <UAlert
      v-for="warning in report.warnings"
      :key="warning"
      color="warning"
      variant="subtle"
      icon="i-heroicons-exclamation-triangle-20-solid"
      :title="warning"
      data-testid="file-warning"
    />

    <div v-if="report.days.length" class="bg-default rounded-xl px-4 pt-4 pb-2">
      <div class="relative max-h-[420px] overflow-auto">
        <table class="data-table" data-testid="day-table">
          <thead class="bg-default sticky top-0">
            <tr>
              <th>Date</th>
              <th class="text-right">Calls in the file</th>
              <th class="text-right">Calls stored</th>
              <th>What happens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in lines" :key="line.key">
              <td class="whitespace-nowrap">
                <template v-if="line.days === 1">{{ line.first }}</template>
                <template v-else>
                  {{ line.first }} to {{ line.last }}
                  <span class="text-muted">({{ number(line.days) }} days)</span>
                </template>
              </td>
              <td class="text-right">{{ number(line.rows) }}</td>
              <td class="text-right">{{ number(line.existing) }}</td>
              <td>
                <AdminStatusChip
                  :tone="STATUS[line.status].tone"
                  :label="STATUS[line.status].label"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="grouped" class="text-muted flex flex-wrap items-center gap-x-1 py-2 text-[13px]">
        Days in a row with the same outcome are shown as one line.
        <UButton
          variant="link"
          class="px-1 text-[13px]"
          :label="`Show all ${number(report.days.length)} days`"
          data-testid="show-all-days"
          @click="showAll = true"
        />
      </p>
    </div>
  </div>
</template>
