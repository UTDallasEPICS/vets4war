<script setup lang="ts">
  // Give someone access: their address, an optional display name, and a role. The
  // server lower-cases the address and answers 409 when it already has access.
  import type { PersonRow } from '#shared/types/api'

  const ROLE_ITEMS = [
    { label: 'Viewer', value: 'viewer' },
    { label: 'Admin', value: 'admin' },
  ]

  const emit = defineEmits<{ added: [person: PersonRow] }>()
  const toast = useToast()

  const state = reactive({ email: '', name: '', role: 'viewer' as PersonRow['role'] })
  const saving = ref(false)

  async function submit() {
    saving.value = true
    try {
      const { user } = await apiFetch<{ user: PersonRow }>('/api/admin/users', {
        method: 'POST',
        body: {
          email: state.email,
          role: state.role,
          ...(state.name.trim() ? { name: state.name } : {}),
        },
      })
      toast.add({ title: `${user.email} can now sign in`, color: 'success' })
      state.email = ''
      state.name = ''
      state.role = 'viewer'
      emit('added', user)
    } catch (error) {
      toast.add({
        title: 'Could not add this person',
        description: error instanceof Error ? error.message : String(error),
        color: 'error',
      })
    } finally {
      saving.value = false
    }
  }
</script>

<template>
  <UForm :state="state" class="flex flex-wrap items-end gap-3" @submit="submit">
    <UFormField label="Email" name="email" required>
      <UInput
        v-model="state.email"
        type="email"
        placeholder="name@example.org"
        autocomplete="off"
        required
        class="w-72"
      />
    </UFormField>
    <UFormField label="Name" name="name" hint="Optional">
      <UInput v-model="state.name" placeholder="From the address" maxlength="100" class="w-56" />
    </UFormField>
    <UFormField label="Role" name="role">
      <USelect v-model="state.role" :items="ROLE_ITEMS" class="w-32" />
    </UFormField>
    <UButton type="submit" icon="i-heroicons-user-plus-20-solid" :loading="saving">
      Add person
    </UButton>
  </UForm>
</template>
