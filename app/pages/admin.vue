<script setup lang="ts">
  // Three panels, one per tab. The panels take no props and emit nothing: a panel that
  // wants another tab opened navigates to /admin?tab=<name>.
  const TABS = [
    { label: 'Call data', value: 'uploads' },
    { label: 'Forecast runs', value: 'runs' },
    { label: 'People', value: 'people' },
  ]
  type Tab = 'uploads' | 'runs' | 'people'

  const route = useRoute()
  const router = useRouter()

  const tab = computed<Tab>({
    get() {
      const value = route.query.tab
      return value === 'runs' || value === 'people' ? value : 'uploads'
    },
    set(value) {
      router.replace({ query: { tab: value } })
    },
  })

  useHead({ title: 'Admin · Vets4Warriors staffing' })
</script>

<template>
  <UContainer class="py-8">
    <h1 class="mb-6 text-2xl font-bold">Admin</h1>
    <UTabs v-model="tab" :items="TABS" :content="false" class="mb-6" />
    <AdminUploadsPanel v-if="tab === 'uploads'" />
    <AdminRunsPanel v-else-if="tab === 'runs'" />
    <AdminPeoplePanel v-else />
  </UContainer>
</template>
