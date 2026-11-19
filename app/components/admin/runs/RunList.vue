<script setup lang="ts">
  // Recent runs: when, what started them, what they did, how they ended.
  import type { RunSummary, RunTrigger } from '#shared/types/api'

  defineProps<{ runs: RunSummary[] }>()
  defineEmits<{ open: [id: number] }>()

  const TRIGGER: Record<RunTrigger, string> = {
    import: 'After an import',
    schedule: 'Scheduled',
    manual: 'By hand',
    startup: 'Server start',
    cli: 'Command line',
  }
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
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
  <section class="tile space-y-4" aria-labelledby="runs-title">
    <h2 id="runs-title" class="tile-title">Recent runs</h2>
    <p v-if="!runs.length" class="text-muted text-sm">
      No runs yet. A retrain starts by itself after an import, or with Retrain now.
    </p>
    <div v-else class="relative overflow-x-auto">
      <table class="data-table" data-testid="run-list">
        <thead>
          <tr>
            <th>Run</th>
            <th>When</th>
            <th>Started by</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Took</th>
            <th class="min-w-64">Message</th>
            <th><span class="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.id">
            <td class="num text-[17px]">{{ run.id }}</td>
            <td class="text-muted whitespace-nowrap">{{ when(run.created_at) }}</td>
            <td>
              {{ TRIGGER[run.trigger] }}
              <span
                v-if="run.requested_by && run.requested_by !== run.trigger"
                class="text-muted block text-xs"
                >({{ run.requested_by }})</span
              >
            </td>
            <td class="whitespace-nowrap">
              {{ run.mode === 'full' ? 'Retrain' : 'Forecast refresh' }}
            </td>
            <td>
              <AdminRunsStatusBadge :status="run.status" :forecast-written="run.forecast_written" />
            </td>
            <td class="whitespace-nowrap">
              {{ duration(run.started_at ?? run.created_at, run.finished_at) }}
            </td>
            <td class="text-toned min-w-64">{{ run.message }}</td>
            <td class="text-right">
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                class="bg-default"
                label="Details"
                trailing-icon="i-heroicons-chevron-right-16-solid"
                @click="$emit('open', run.id)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
