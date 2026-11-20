<script setup lang="ts">
  // Every day of the period with calls: what came, what the forecast said, and which
  // forecast it was compared with. Days the model had been trained on are marked.
  import type { AccuracyDay } from '#shared/types/api'
  import type { StatusTone } from '../StatusChip.vue'

  defineProps<{ days: AccuracyDay[] }>()

  function compared(day: AccuracyDay): { tone: StatusTone; label: string } {
    if (!day.held_out) return { tone: 'warn', label: 'In training, not counted' }
    return day.source === 'snapshot'
      ? { tone: 'info', label: 'Kept at import' }
      : { tone: 'neutral', label: 'Forecast in use' }
  }
  const weekday = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    })
</script>

<template>
  <section class="tile space-y-4" aria-labelledby="accuracy-days-title">
    <h2 id="accuracy-days-title" class="tile-title">Day by day</h2>
    <p v-if="!days.length" class="text-muted text-sm">No day to compare in these dates.</p>
    <div v-else class="relative overflow-x-auto">
      <table class="data-table" data-testid="accuracy-days">
        <thead>
          <tr>
            <th>Day</th>
            <th class="text-right">Calls</th>
            <th class="text-right">Forecast</th>
            <th class="text-right">Difference</th>
            <th class="text-right">Miss</th>
            <th class="text-right">Miss per hour</th>
            <th>Compared with</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="day in days" :key="day.date" :class="{ 'text-muted': !day.held_out }">
            <td class="whitespace-nowrap">
              <span class="text-muted mr-1.5 inline-block w-8">{{ weekday(day.date) }}</span>
              {{ day.date }}
            </td>
            <td class="num text-right text-[15px]">{{ accuracyCalls(day.actual_calls) }}</td>
            <td class="num text-right text-[15px]">
              {{ accuracyCalls(day.predicted_calls, 1, true) }}
            </td>
            <td class="text-right whitespace-nowrap">{{ accuracySigned(day.error_calls) }}</td>
            <td class="text-right whitespace-nowrap">{{ accuracyPct(day.abs_pct_error) }}</td>
            <td class="text-right whitespace-nowrap">
              {{ accuracyCalls(day.hourly_mae, 2, true) }}
            </td>
            <td>
              <AdminStatusChip v-bind="compared(day)" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
