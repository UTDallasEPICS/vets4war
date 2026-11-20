<script setup lang="ts">
  // Call data: choose a call-records workbook, see what each day would do, confirm the
  // import, and see the retrain it started. No props, no emits (the admin page's
  // contract); the runs tab is reached through /admin?tab=runs.
  import type { RunSummary, UploadDetail, UploadSummary } from '#shared/types/api'

  const POLL_MS = 1000
  const STEPS = ['Upload the export', 'Check what each day would do', 'Confirm the import']

  const uploads = ref<UploadSummary[]>([])
  const current = ref<UploadDetail | null>(null)
  const outcome = ref<{ upload: UploadDetail; run: RunSummary | null; queued: boolean } | null>(
    null
  )
  const MB = 1024 * 1024
  // The server's upload limit, from the uploads list; null until it has answered (the
  // server still refuses a file that is too large).
  const maxBytes = ref<number | null>(null)
  const sending = ref(false)
  const sendingName = ref('')
  const dragging = ref(false)
  const problem = ref<string | null>(null)
  const notice = ref<string | null>(null)
  let poll: ReturnType<typeof setTimeout> | null = null

  const busy = computed(() => sending.value || current.value?.status === 'parsing')
  // Which of the three steps the admin is on: choosing a file, reading the report, or
  // (with the import form showing) confirming.
  const step = computed(() => {
    if (!current.value || current.value.status === 'parsing') return 0
    return current.value.status === 'ready' && current.value.report?.ok ? 2 : 1
  })

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'The request failed.'
  }

  async function loadHistory() {
    try {
      const list = await apiFetch<{ uploads: UploadSummary[]; max_bytes?: number }>(
        '/api/admin/uploads'
      )
      uploads.value = list.uploads
      maxBytes.value = list.max_bytes ?? null
    } catch (error) {
      problem.value = messageOf(error)
    }
  }

  function stopPolling() {
    if (poll) clearTimeout(poll)
    poll = null
  }

  async function open(id: number) {
    stopPolling()
    try {
      const { upload } = await apiFetch<{ upload: UploadDetail }>(`/api/admin/uploads/${id}`)
      current.value = upload
      if (upload.status === 'parsing') {
        poll = setTimeout(() => open(id), POLL_MS)
      } else {
        await loadHistory()
      }
    } catch (error) {
      problem.value = messageOf(error)
    }
  }

  async function sendFile(file: File) {
    problem.value = null
    notice.value = null
    outcome.value = null
    if (maxBytes.value !== null && file.size > maxBytes.value) {
      problem.value = `${file.name} is ${(file.size / MB).toFixed(1)} MB, more than the upload limit of ${Math.floor(maxBytes.value / MB)} MB. Split it into smaller files (one year per file works).`
      return
    }
    sending.value = true
    sendingName.value = file.name
    try {
      const form = new FormData()
      form.append('file', file)
      const { upload } = await apiFetch<{ upload: UploadSummary }>('/api/admin/uploads', {
        method: 'POST',
        body: form,
      })
      await open(upload.id)
    } catch (error) {
      problem.value = messageOf(error)
    } finally {
      sending.value = false
    }
  }

  async function send(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      await sendFile(file)
    } finally {
      input.value = ''
    }
  }

  async function drop(event: DragEvent) {
    dragging.value = false
    if (busy.value) return
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      problem.value = `${file.name} is not an Excel workbook (.xlsx). Export the call records as .xlsx and try again.`
      return
    }
    await sendFile(file)
  }

  async function onImported(result: {
    upload: UploadDetail
    run: RunSummary | null
    queued: boolean
  }) {
    outcome.value = result
    current.value = null
    await loadHistory()
  }

  async function onRefused(message: string) {
    notice.value = message
    if (current.value) await open(current.value.id)
  }

  async function discard(id: number) {
    problem.value = null
    try {
      await apiFetch(`/api/admin/uploads/${id}`, { method: 'DELETE' })
      if (current.value?.id === id) current.value = null
      await loadHistory()
    } catch (error) {
      problem.value = messageOf(error)
    }
  }

  function close() {
    stopPolling()
    current.value = null
    notice.value = null
  }

  onMounted(async () => {
    await loadHistory()
    // Pick up a file that is still being read or waiting for a decision.
    const pending = uploads.value.find((u) => u.status === 'parsing' || u.status === 'ready')
    if (pending) await open(pending.id)
  })
  onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="space-y-4">
    <section class="tile space-y-5" aria-labelledby="load-title">
      <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <h2 id="load-title" class="tile-title">Load call data</h2>
        <ol class="flex flex-wrap gap-x-5 gap-y-1 text-[13px]" aria-label="Steps">
          <li
            v-for="(label, index) in STEPS"
            :key="label"
            class="flex items-center gap-2"
            :class="index === step ? 'text-default font-medium' : 'text-muted'"
            :aria-current="index === step ? 'step' : undefined"
          >
            <span
              class="grid size-5 place-items-center rounded-full text-[11px] font-semibold"
              :class="
                index < step
                  ? 'bg-inverted text-inverted'
                  : index === step
                    ? 'bg-primary text-white'
                    : 'bg-accented text-muted'
              "
              aria-hidden="true"
            >
              <UIcon v-if="index < step" name="i-heroicons-check-16-solid" class="size-3" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            {{ label }}
          </li>
        </ol>
      </div>

      <label
        class="bg-default relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[14px] border-2 border-dashed px-6 text-center transition-colors"
        :class="[
          dragging
            ? 'border-primary bg-[var(--v4w-accent-soft)]'
            : 'border-accented hover:border-inverted',
          busy ? 'pointer-events-none opacity-70' : '',
          // While a file is being checked the report is what matters: a slim drop zone.
          current && !busy ? 'py-5 sm:flex-row sm:gap-4 sm:text-left' : 'py-10',
        ]"
        @dragenter.prevent="dragging = true"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="drop"
      >
        <span
          class="bg-elevated text-default grid size-12 place-items-center rounded-full"
          aria-hidden="true"
        >
          <span
            v-if="busy"
            class="inline-block size-5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <UIcon v-else name="i-heroicons-arrow-up-tray-20-solid" class="size-5" />
        </span>
        <span v-if="sending" class="text-[15px] font-semibold">Sending {{ sendingName }}…</span>
        <span v-else-if="busy" class="text-[15px] font-semibold">Reading the file…</span>
        <span v-else class="text-[15px] font-semibold">Drop the call-records workbook here</span>
        <span class="text-muted max-w-md text-sm">
          <template v-if="busy"
            >Large files take up to a minute. You can stay on this page.</template
          >
          <template v-else>
            or <span class="text-link">choose a file</span>. The .xlsx export from the phone system.
            Nothing changes until you confirm the import.
          </template>
        </span>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          :disabled="busy"
          class="sr-only"
          data-testid="upload-input"
          @change="send"
        />
      </label>

      <UAlert
        v-if="problem"
        color="error"
        variant="subtle"
        icon="i-heroicons-exclamation-triangle-20-solid"
        title="That did not work"
        :description="problem"
      />
    </section>

    <section v-if="current" class="tile space-y-5" data-testid="current-upload">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <p class="stat-label">Checking</p>
          <h2 class="tile-title break-all">{{ current.filename }}</h2>
        </div>
        <UButton
          v-if="current.status !== 'parsing'"
          color="neutral"
          variant="soft"
          class="bg-default"
          icon="i-heroicons-x-mark-20-solid"
          label="Close"
          @click="close"
        />
      </div>
      <div v-if="current.status === 'parsing'" class="flex items-center gap-3 text-sm">
        <AdminStatusChip tone="info" label="Reading" busy />
        <span class="text-muted">Reading the file. Large files take up to a minute.</span>
      </div>
      <UAlert
        v-else-if="current.status === 'failed'"
        color="error"
        variant="subtle"
        icon="i-heroicons-x-circle-20-solid"
        title="The file could not be read"
        :description="current.error ?? ''"
      />
      <template v-else-if="current.report">
        <UAlert
          v-if="notice"
          color="warning"
          variant="subtle"
          icon="i-heroicons-exclamation-triangle-20-solid"
          title="Not imported"
          :description="notice"
        />
        <AdminUploadsUploadReport :upload="current" />
        <AdminUploadsImportForm
          v-if="
            current.status === 'ready' && current.report.ok && !current.report.nothing_to_import
          "
          :upload="current"
          @imported="onImported"
          @refused="onRefused"
        />
        <p
          v-else-if="current.report.nothing_to_import"
          class="bg-default rounded-xl px-4 py-3 text-sm"
          data-testid="nothing-to-import"
        >
          Every day in this file is already loaded with exactly these calls. There is nothing to
          import.
        </p>
        <p
          v-else-if="!current.report.ok"
          class="text-error rounded-xl bg-[var(--v4w-bad-soft)] px-4 py-3 text-sm font-medium"
          data-testid="cannot-import"
        >
          This file cannot be imported until the problems above are fixed. Export it again and
          upload the new file.
        </p>
      </template>
    </section>

    <AdminUploadsImportOutcome
      v-if="outcome"
      :upload="outcome.upload"
      :run="outcome.run"
      :queued="outcome.queued"
      @close="outcome = null"
    />

    <AdminUploadsUploadHistory :uploads="uploads" @open="open" @discard="discard" />
  </div>
</template>
