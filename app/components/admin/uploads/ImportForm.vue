<script setup lang="ts">
  // The confirmation: the admin types the row count of their export and, when days
  // differ from what is stored, ticks that exactly those days are replaced.
  import type { ImportRequest, RunSummary, UploadDetail } from '#shared/types/api'

  const props = defineProps<{ upload: UploadDetail }>()
  const emit = defineEmits<{
    imported: [result: { upload: UploadDetail; run: RunSummary | null; queued: boolean }]
    refused: [message: string]
  }>()

  const typed = ref('')
  const replaceConfirmed = ref(false)
  const sending = ref(false)

  const days = computed(() => props.upload.report?.days ?? [])
  const conflicts = computed(() =>
    days.value.filter((d) => d.status === 'conflict').map((d) => d.day)
  )
  const newDays = computed(() => days.value.filter((d) => d.status === 'new').length)
  const count = computed(() => Number(typed.value.replaceAll(',', '').trim()))
  const ready = computed(
    () =>
      typed.value.trim() !== '' &&
      Number.isInteger(count.value) &&
      count.value >= 0 &&
      (conflicts.value.length === 0 || replaceConfirmed.value)
  )
  const buttonLabel = computed(() =>
    conflicts.value.length
      ? `Replace ${conflicts.value.length} and import`
      : `Import ${newDays.value} day(s)`
  )

  watch(
    () => props.upload.report,
    () => {
      replaceConfirmed.value = false
    }
  )

  async function submit() {
    if (!ready.value) return
    sending.value = true
    try {
      const body: ImportRequest = {
        total_rows: count.value,
        replace_days: replaceConfirmed.value ? conflicts.value : [],
      }
      const result = await apiFetch<{
        upload: UploadDetail
        run: RunSummary | null
        queued: boolean
      }>(`/api/admin/uploads/${props.upload.id}/import`, { method: 'POST', body })
      emit('imported', result)
    } catch (error) {
      emit('refused', error instanceof Error ? error.message : 'The import failed.')
    } finally {
      sending.value = false
    }
  }
</script>

<template>
  <form
    class="border-primary/30 bg-default space-y-5 rounded-xl border p-5"
    data-testid="import-form"
    @submit.prevent="submit"
  >
    <div class="space-y-1">
      <h3 class="text-[15px] font-semibold">Confirm the import</h3>
      <p class="text-muted text-[13px]">
        A last check that the file is the export you meant: the counts must agree before anything is
        stored.
      </p>
    </div>
    <UFormField
      label="How many rows does your export have?"
      description="Type the row count from the export itself (without the header row). It must match the calls read from the file."
    >
      <UInput
        v-model="typed"
        inputmode="numeric"
        placeholder="e.g. 1313"
        size="lg"
        class="w-56"
        data-testid="row-count"
      />
    </UFormField>
    <UCheckbox
      v-if="conflicts.length"
      v-model="replaceConfirmed"
      class="rounded-lg bg-[var(--v4w-warn-soft)] p-3"
      :label="`Replace ${conflicts.length} day(s): ${conflicts.join(', ')}`"
      description="The calls stored for these days are removed (and kept aside) and the file's calls take their place."
      data-testid="replace-confirm"
    />
    <UButton
      type="submit"
      size="lg"
      icon="i-heroicons-arrow-down-tray-20-solid"
      :label="buttonLabel"
      :loading="sending"
      :disabled="!ready || sending"
      data-testid="import-button"
    />
  </form>
</template>
