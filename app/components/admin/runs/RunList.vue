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
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-lg font-semibold">Recent runs</h2>
    </template>
    <p v-if="!runs.length" class="text-sm text-gray-600 dark:text-gray-300">No runs yet.</p>
    <div v-else class="relative overflow-x-auto">
      <table class="w-full text-left text-sm" data-testid="run-list">
        <thead class="text-gray-500 dark:text-gray-400">
          <tr>
            <th class="py-1 pr-4 font-medium">Run</th>
            <th class="py-1 pr-4 font-medium">When</th>
            <th class="py-1 pr-4 font-medium">Started by</th>
            <th class="py-1 pr-4 font-medium">Kind</th>
            <th class="py-1 pr-4 font-medium">Status</th>
            <th class="py-1 pr-4 font-medium">Message</th>
            <th class="py-1"><span class="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="run in runs"
            :key="run.id"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="py-1 pr-4 tabular-nums">{{ run.id }}</td>
            <td class="py-1 pr-4 whitespace-nowrap">{{ when(run.created_at) }}</td>
            <td class="py-1 pr-4">
              {{ TRIGGER[run.trigger] }}
              <span
                v-if="run.requested_by && run.requested_by !== run.trigger"
                class="text-gray-500 dark:text-gray-400"
                >({{ run.requested_by }})</span
              >
            </td>
            <td class="py-1 pr-4">{{ run.mode === 'full' ? 'Retrain' : 'Forecast refresh' }}</td>
            <td class="py-1 pr-4"><AdminRunsStatusBadge :status="run.status" /></td>
            <td class="py-1 pr-4">{{ run.message }}</td>
            <td class="py-1 text-right">
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                label="Details"
                @click="$emit('open', run.id)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </UCard>
</template>
