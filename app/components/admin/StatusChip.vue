<script lang="ts">
  // A status as the console draws its data badge: a dot and a word on a soft tint. The
  // tone carries the meaning (good, needs a look, failed, in progress); `busy` pulses the
  // dot while something is still happening.
  export type StatusTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral'
</script>

<script setup lang="ts">
  const props = defineProps<{ tone: StatusTone; label: string; busy?: boolean }>()

  const TONE_CLASS: Record<StatusTone, string> = {
    good: 'is-good',
    warn: 'is-warn',
    bad: 'is-bad',
    info: 'is-info',
    neutral: '',
  }
</script>

<template>
  <span class="status" :class="[TONE_CLASS[props.tone], { 'is-busy': props.busy }]">
    {{ props.label }}
  </span>
</template>
