<script setup lang="ts">
  import type { RunStatus } from '#shared/types/api'

  // forecastWritten: a rejected FIRST model leaves nothing served, so nothing was kept.
  const props = defineProps<{ status: RunStatus; forecastWritten?: boolean | null }>()

  type Color = 'success' | 'neutral' | 'warning' | 'error' | 'info'
  const STATUS: Record<RunStatus, { label: string; color: Color }> = {
    queued: { label: 'Running', color: 'info' },
    running: { label: 'Running', color: 'info' },
    succeeded: { label: 'Done', color: 'success' },
    rejected: { label: 'Kept the previous model', color: 'warning' },
    failed: { label: 'Failed', color: 'error' },
    interrupted: { label: 'Interrupted', color: 'neutral' },
  }
  const shown = computed(() =>
    props.status === 'rejected' && props.forecastWritten === false
      ? { label: 'Rejected, nothing served', color: 'warning' as const }
      : STATUS[props.status]
  )
</script>

<template>
  <UBadge :color="shown.color" variant="subtle" data-testid="run-status">
    {{ shown.label }}
  </UBadge>
</template>
