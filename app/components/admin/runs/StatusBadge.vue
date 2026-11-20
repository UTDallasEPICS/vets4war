<script setup lang="ts">
  import type { RunStatus } from '#shared/types/api'
  import type { StatusTone } from '../StatusChip.vue'

  // forecastWritten: a rejected FIRST model leaves nothing served, so nothing was kept.
  const props = defineProps<{ status: RunStatus; forecastWritten?: boolean | null }>()

  const STATUS: Record<RunStatus, { label: string; tone: StatusTone; busy?: boolean }> = {
    queued: { label: 'Running', tone: 'info', busy: true },
    running: { label: 'Running', tone: 'info', busy: true },
    succeeded: { label: 'Done', tone: 'good' },
    rejected: { label: 'Kept the previous model', tone: 'warn' },
    failed: { label: 'Failed', tone: 'bad' },
    interrupted: { label: 'Interrupted', tone: 'neutral' },
  }
  const shown = computed(() =>
    props.status === 'rejected' && props.forecastWritten === false
      ? { label: 'Rejected, nothing served', tone: 'warn' as const, busy: false }
      : STATUS[props.status]
  )
</script>

<template>
  <AdminStatusChip
    :tone="shown.tone"
    :label="shown.label"
    :busy="shown.busy"
    data-testid="run-status"
  />
</template>
