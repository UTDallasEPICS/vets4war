<script setup lang="ts">
  // What an import did, and the retrain it started (or queued behind the one running).
  import type { RunSummary, UploadDetail } from '#shared/types/api'

  const props = defineProps<{ upload: UploadDetail; run: RunSummary | null }>()
  defineEmits<{ close: [] }>()

  const result = computed(() => props.upload.result)
  // The runner answers with the run already in progress when it only queued one more.
  const queued = computed(() => props.run !== null && props.run.upload_id !== props.upload.id)
  const days = (list: string[]) => (list.length > 6 ? `${list.length} days` : list.join(', '))
</script>

<template>
  <UAlert
    color="success"
    variant="subtle"
    title="Imported"
    close
    data-testid="import-outcome"
    @update:open="$emit('close')"
  >
    <template #description>
      <ul v-if="result" class="space-y-1">
        <li>{{ result.inserted_rows.toLocaleString('en-US') }} calls added.</li>
        <li v-if="result.added_days.length">New days: {{ days(result.added_days) }}.</li>
        <li v-if="result.replaced_days.length">
          Replaced days: {{ days(result.replaced_days) }} ({{
            result.deleted_rows.toLocaleString('en-US')
          }}
          stored calls removed and kept aside).
        </li>
        <li v-if="result.skipped_days.length">
          Already loaded, skipped: {{ days(result.skipped_days) }}.
        </li>
        <li v-if="run && !queued" data-testid="retrain-started">
          Retraining started.
          <NuxtLink to="/admin?tab=runs" class="underline">Follow it under Forecast runs</NuxtLink>.
        </li>
        <li v-else-if="run" data-testid="retrain-queued">
          A retrain is already running; another one is queued behind it and starts when it ends.
          <NuxtLink to="/admin?tab=runs" class="underline">Forecast runs</NuxtLink>
        </li>
        <li v-else>No retrain was started automatically (V4W_RETRAIN_ON_IMPORT is off).</li>
      </ul>
    </template>
  </UAlert>
</template>
