<script setup lang="ts">
  // A quiet note, in the old page's banner style, when the forecast below is behind the
  // call data: while new data is processed, and after a run that could not update it.
  // Nothing otherwise.
  import { computed, shallowRef } from 'vue'
  import type { ComputedRef } from 'vue'
  import { useConsole } from '~/composables/console/useConsoleState'
  import { useConsoleStatus } from '~/composables/console/useConsoleStatus'

  const { reloadForecast } = useConsole()
  const { note } = useConsoleStatus(reloadForecast)

  const session = shallowRef<{ isAdmin: ComputedRef<boolean> } | null>(null)
  void useSessionUser().then((s) => {
    session.value = s
  })
  const isAdmin = computed(() => session.value?.isAdmin.value === true)
</script>

<template>
  <div v-if="note" class="banner note" id="statusNote" role="status">
    {{ note.text }}
    <NuxtLink v-if="note.kind === 'failed' && isAdmin" to="/admin?tab=runs"
      >See the forecast runs</NuxtLink
    >
  </div>
</template>
