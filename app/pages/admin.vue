<script setup lang="ts">
  // Three panels, one per tab. The panels take no props and emit nothing: a panel that
  // wants another tab opened navigates to /admin?tab=<name>.
  const TABS = [
    { label: 'Call data', value: 'uploads' },
    { label: 'Forecast runs', value: 'runs' },
    { label: 'People', value: 'people' },
  ]
  type Tab = 'uploads' | 'runs' | 'people'

  const INTRO: Record<Tab, string> = {
    uploads:
      'Load the call-records export. You see what each day would do before anything changes.',
    runs: 'The model behind the forecast: retrain it on the stored calls, or move the forecast forward.',
    people: 'Who can sign in, and who can manage call data, runs and people.',
  }

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
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0 space-y-1.5">
        <h1 class="page-title">Admin</h1>
        <p class="text-muted text-sm">{{ INTRO[tab] }}</p>
      </div>
      <UTabs
        v-model="tab"
        :items="TABS"
        :content="false"
        color="neutral"
        :ui="{
          root: 'w-auto',
          list: 'w-auto rounded-full bg-elevated p-[3px]',
          indicator: 'rounded-full bg-inverted shadow-none inset-y-[3px]',
          trigger:
            'grow-0 h-[30px] rounded-full px-4 text-[13px] font-medium text-muted hover:text-default data-[state=active]:text-inverted',
        }"
      />
    </div>
    <AdminUploadsPanel v-if="tab === 'uploads'" />
    <AdminRunsPanel v-else-if="tab === 'runs'" />
    <AdminPeoplePanel v-else />
  </div>
</template>
