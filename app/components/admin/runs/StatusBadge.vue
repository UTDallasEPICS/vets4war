<script setup lang="ts">
  import type { RunStatus } from '#shared/types/api'

  defineProps<{ status: RunStatus }>()

  type Color = 'success' | 'neutral' | 'warning' | 'error' | 'info'
  const STATUS: Record<RunStatus, { label: string; color: Color }> = {
    queued: { label: 'Running', color: 'info' },
    running: { label: 'Running', color: 'info' },
    succeeded: { label: 'Done', color: 'success' },
    rejected: { label: 'Kept the previous model', color: 'warning' },
    failed: { label: 'Failed', color: 'error' },
    interrupted: { label: 'Interrupted', color: 'neutral' },
  }
</script>

<template>
  <UBadge :color="STATUS[status].color" variant="subtle" data-testid="run-status">
    {{ STATUS[status].label }}
  </UBadge>
</template>
