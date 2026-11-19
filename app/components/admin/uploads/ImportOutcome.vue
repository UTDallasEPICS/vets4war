<script setup lang="ts">
  // What an import did, and the retrain that reads it: started by this import, or queued
  // behind the one in progress. The run is followed here until it ends, so the admin
  // learns that it failed (and why) without switching to the runs tab.
  import type { RunDetail, RunStatus, RunSummary, UploadDetail } from '#shared/types/api'

  const props = defineProps<{ upload: UploadDetail; run: RunSummary | null; queued: boolean }>()
  defineEmits<{ close: [] }>()

  const POLL_MS = 3000
  const ACTIVE: RunStatus[] = ['queued', 'running']
  const WORDS: Record<RunStatus, string> = {
    queued: 'Running',
    running: 'Running',
    succeeded: 'Done',
    rejected: 'Kept the previous model',
    failed: 'Failed',
    interrupted: 'Interrupted',
  }

  const result = computed(() => props.upload.result)
  // The run that reads this file: once known (the upload answers with it), else the one
  // this import started. A queued import has none until the re-run begins.
  const followed = ref<RunDetail | RunSummary | null>(props.queued ? null : props.run)
  // The import itself succeeded; a retrain that then failed must not read as success.
  // A rejected FIRST model kept nothing: nothing was served before, nothing is now
  // (the runs tab says the same).
  const nothingServed = computed(
    () => followed.value?.status === 'rejected' && followed.value.forecast_written === false
  )
  const word = computed(() =>
    !followed.value
      ? ''
      : nothingServed.value
        ? 'Rejected, nothing served'
        : WORDS[followed.value.status]
  )
  // The import itself succeeded; a retrain that then failed, or left nothing served,
  // must not read as success.
  const color = computed(() =>
    nothingServed.value ||
    (followed.value && ['failed', 'interrupted'].includes(followed.value.status))
      ? 'warning'
      : 'success'
  )

  const elapsed = ref(0)
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const days = (list: string[]) => (list.length > 6 ? `${list.length} days` : list.join(', '))
  const seconds = (run: RunSummary) =>
    run.started_at ? Math.max(0, Math.round((Date.now() - Date.parse(run.started_at)) / 1000)) : 0
  const duration = (s: number) => (s < 120 ? `${s} s` : `${Math.round(s / 60)} min`)

  async function follow() {
    if (stopped) return
    try {
      const { upload } = await apiFetch<{ upload: UploadDetail }>(
        `/api/admin/uploads/${props.upload.id}`
      )
      const id = upload.run_id ?? followed.value?.id ?? null
      if (id !== null && (upload.run_id !== null || !props.queued)) {
        followed.value = (await apiFetch<{ run: RunDetail }>(`/api/admin/runs/${id}`)).run
        elapsed.value = seconds(followed.value)
      }
      if (followed.value && !ACTIVE.includes(followed.value.status)) return
    } catch {
      // A failed poll is tried again; the runs tab has the same information.
    }
    if (!stopped) timer = setTimeout(follow, POLL_MS)
  }

  onMounted(() => {
    if (props.run) void follow()
  })
  onBeforeUnmount(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })
</script>

<template>
  <UAlert
    :color="color"
    variant="subtle"
    title="Imported"
    icon="i-heroicons-check-circle-20-solid"
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
        <li v-if="!run">No retrain was started automatically (V4W_RETRAIN_ON_IMPORT is off).</li>
        <li v-else-if="!followed" data-testid="retrain-queued">
          A retrain was already running (run {{ run.id }}); another one starts when it ends and
          reads this file.
          <NuxtLink to="/admin?tab=runs" class="text-link underline">Forecast runs</NuxtLink>
        </li>
        <li
          v-else
          :data-testid="ACTIVE.includes(followed.status) ? 'retrain-started' : 'retrain-ended'"
        >
          <template v-if="ACTIVE.includes(followed.status)">
            Retraining (run {{ followed.id }}): {{ duration(elapsed) }} so far.
          </template>
          <template v-else>
            Retrain (run {{ followed.id }}): <strong>{{ word }}</strong
            >. <span v-if="followed.message"> {{ followed.message }}</span
            >{{ ' ' }}
          </template>
          <NuxtLink to="/admin?tab=runs" class="text-link underline"
            >Follow it under Forecast runs</NuxtLink
          >.
        </li>
      </ul>
    </template>
  </UAlert>
</template>
