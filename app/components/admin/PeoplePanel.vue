<script setup lang="ts">
  // Who may sign in and with which role. Sign-up is off, so this list is the way in.
  // The signed-in admin's own row cannot be demoted or removed (the server refuses
  // too, as it refuses to leave the app without an admin).
  import type { PersonRow } from '#shared/types/api'

  const ROLE_ITEMS = [
    { label: 'Viewer', value: 'viewer' },
    { label: 'Admin', value: 'admin' },
  ]

  const toast = useToast()
  const { user: me } = await useSessionUser()

  const people = ref<PersonRow[]>([])
  const loading = ref(true)
  const loadError = ref<string | null>(null)
  const pendingId = ref<string | null>(null)
  const removing = ref<PersonRow | null>(null)

  const columns = [
    { accessorKey: 'email', header: 'Email' },
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'role', header: 'Role' },
    { accessorKey: 'email_verified', header: 'Signed in before' },
    { accessorKey: 'created_at', header: 'Added on' },
    { id: 'actions', header: '' },
  ]

  const isMe = (person: PersonRow) => person.id === me.value?.id

  function fail(title: string, error: unknown) {
    toast.add({
      title,
      description: error instanceof Error ? error.message : String(error),
      color: 'error',
    })
  }

  async function load() {
    try {
      const { users } = await apiFetch<{ users: PersonRow[] }>('/api/admin/users')
      people.value = users
      loadError.value = null
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error)
    } finally {
      loading.value = false
    }
  }

  async function changeRole(person: PersonRow, role: PersonRow['role']) {
    if (role === person.role) return
    pendingId.value = person.id
    try {
      const { user } = await apiFetch<{ user: PersonRow }>(`/api/admin/users/${person.id}`, {
        method: 'PATCH',
        body: { role },
      })
      toast.add({
        title: `${user.email} is now ${user.role === 'admin' ? 'an admin' : 'a viewer'}`,
      })
    } catch (error) {
      fail('Could not change the role', error)
    } finally {
      pendingId.value = null
      await load()
    }
  }

  async function confirmRemove() {
    const person = removing.value
    if (!person) return
    pendingId.value = person.id
    try {
      await apiFetch(`/api/admin/users/${person.id}`, { method: 'DELETE' })
      toast.add({ title: `${person.email} was removed` })
      removing.value = null
    } catch (error) {
      fail('Could not remove this person', error)
      removing.value = null
    } finally {
      pendingId.value = null
      await load()
    }
  }

  onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <section class="tile space-y-5" aria-labelledby="add-person-title">
      <div class="space-y-1">
        <h2 id="add-person-title" class="tile-title">Add person</h2>
        <p class="text-muted text-sm">
          Only people on this list can sign in. They get a sign-in code by email.
        </p>
      </div>
      <AdminPeopleAddPersonForm @added="load" />
    </section>

    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      title="The list of people could not be loaded"
      :description="loadError"
    />

    <p v-if="loading" class="tile text-muted text-sm">Loading people…</p>
    <!-- Rendered only in the browser, after the list arrived: the list is fetched on mount,
         and an empty server-rendered table does not hydrate cleanly. -->
    <section v-else class="tile space-y-2" aria-labelledby="people-title">
      <h2 id="people-title" class="tile-title">
        People
        <span class="text-muted ml-1 text-sm font-normal">{{ people.length }}</span>
      </h2>
      <UTable
        :data="people"
        :columns="columns"
        class="w-full"
        :ui="{
          thead: '[&>tr]:after:bg-transparent',
          th: 'px-0 pr-4 py-2.5 text-xs font-medium text-muted',
          td: 'px-0 pr-4 py-3 text-[13px] text-default border-t border-accented',
          tbody: 'divide-y-0',
        }"
      >
        <template #email-cell="{ row }">
          <!-- The table's cells do not wrap, so on a phone the note under the admin's own
             address ran past the edge of the table's scrolling box and could not be
             read. Below `sm` this cell has a width of its own and wraps (a long address
             breaks too); the other columns are reached by scrolling the box sideways,
             as in the uploads and runs tables. -->
          <div
            class="max-w-64 min-w-48 break-words whitespace-normal sm:max-w-none sm:whitespace-nowrap"
            data-testid="person-email"
          >
            <div class="font-medium">{{ row.original.email }}</div>
            <div v-if="isMe(row.original)" class="text-muted text-xs">
              This is you: you cannot remove yourself or your own admin access.
            </div>
          </div>
        </template>
        <template #role-cell="{ row }">
          <div class="flex items-center gap-2">
            <AdminStatusChip
              :tone="row.original.role === 'admin' ? 'info' : 'neutral'"
              :label="row.original.role === 'admin' ? 'Admin' : 'Viewer'"
            />
            <USelect
              :model-value="row.original.role"
              :items="ROLE_ITEMS"
              :disabled="isMe(row.original) || pendingId === row.original.id"
              :aria-label="`Role of ${row.original.email}`"
              size="sm"
              class="w-28"
              @update:model-value="(role) => changeRole(row.original, role as PersonRow['role'])"
            />
          </div>
        </template>
        <template #email_verified-cell="{ row }">
          <span :class="row.original.email_verified ? '' : 'text-muted'">
            {{ row.original.email_verified ? 'Yes' : 'Not yet' }}
          </span>
        </template>
        <template #created_at-cell="{ row }">
          {{ row.original.created_at.slice(0, 10) }}
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center justify-end gap-2">
            <UButton
              color="error"
              variant="soft"
              icon="i-heroicons-trash-20-solid"
              :aria-label="`Remove ${row.original.email}`"
              :disabled="isMe(row.original) || pendingId === row.original.id"
              @click="removing = row.original"
            >
              Remove
            </UButton>
          </div>
        </template>
      </UTable>
    </section>

    <AdminPeopleRemovePersonModal
      :person="removing"
      :busy="removing !== null && pendingId === removing.id"
      @confirm="confirmRemove"
      @cancel="removing = null"
    />
  </div>
</template>
