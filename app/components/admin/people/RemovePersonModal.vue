<script setup lang="ts">
  // Asks before a person loses access; removing them also ends their sessions.
  import type { PersonRow } from '#shared/types/api'

  const props = defineProps<{ person: PersonRow | null; busy: boolean }>()
  const emit = defineEmits<{ confirm: []; cancel: [] }>()
  const open = computed({
    get: () => props.person !== null,
    set: (value: boolean) => {
      if (!value) emit('cancel')
    },
  })
</script>

<template>
  <UModal
    v-model:open="open"
    title="Remove this person?"
    :description="
      person ? `${person.email} will no longer be able to sign in and is signed out now.` : ''
    "
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="emit('cancel')" />
        <UButton color="error" label="Remove" :loading="busy" @click="emit('confirm')" />
      </div>
    </template>
  </UModal>
</template>
