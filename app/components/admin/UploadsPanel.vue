<script setup lang="ts">
  // Call data: choose a call-records workbook, see what each day would do, confirm the
  // import, and see the retrain it started. No props, no emits (the admin page's
  // contract); the runs tab is reached through /admin?tab=runs.
  import type { RunSummary, UploadDetail, UploadSummary } from '#shared/types/api'

  const POLL_MS = 1000

  const uploads = ref<UploadSummary[]>([])
  const current = ref<UploadDetail | null>(null)
  const outcome = ref<{ upload: UploadDetail; run: RunSummary | null } | null>(null)
  const sending = ref(false)
  const problem = ref<string | null>(null)
  const notice = ref<string | null>(null)
  let poll: ReturnType<typeof setTimeout> | null = null

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'The request failed.'
  }

  async function loadHistory() {
    try {
      uploads.value = (await apiFetch<{ uploads: UploadSummary[] }>('/api/admin/uploads')).uploads
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

  async function send(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    problem.value = null
    notice.value = null
    outcome.value = null
    sending.value = true
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
      input.value = ''
    }
  }

  async function onImported(result: { upload: UploadDetail; run: RunSummary | null }) {
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
  <div class="space-y-6">
    <UCard>
      <template #header>
        <h2 class="text-lg font-semibold">Load call data</h2>
      </template>
      <p class="mb-4 text-sm text-gray-600 dark:text-gray-300">
        Choose the call-records export (.xlsx). Nothing is changed until you have checked what each
        day would do and confirmed the import.
      </p>
      <label class="inline-flex items-center gap-3">
        <span class="sr-only">Call-records file</span>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          :disabled="sending || current?.status === 'parsing'"
          class="file:bg-primary-50 file:text-primary-700 dark:file:bg-primary-900 dark:file:text-primary-200 block text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm file:font-medium"
          data-testid="upload-input"
          @change="send"
        />
      </label>
      <p v-if="sending" class="mt-3 text-sm">Sending the file…</p>
      <UAlert
        v-if="problem"
        class="mt-4"
        color="error"
        variant="subtle"
        title="That did not work"
        :description="problem"
      />
    </UCard>

    <UCard v-if="current" data-testid="current-upload">
      <template #header>
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-lg font-semibold break-all">{{ current.filename }}</h2>
          <UButton
            v-if="current.status !== 'parsing'"
            color="neutral"
            variant="ghost"
            label="Close"
            @click="close"
          />
        </div>
      </template>
      <div v-if="current.status === 'parsing'" class="flex items-center gap-3">
        <UIcon name="i-heroicons-arrow-path" class="size-5 animate-spin" />
        <span>Reading the file. Large files take up to a minute.</span>
      </div>
      <UAlert
        v-else-if="current.status === 'failed'"
        color="error"
        variant="subtle"
        title="The file could not be read"
        :description="current.error ?? ''"
      />
      <template v-else-if="current.report">
        <UAlert
          v-if="notice"
          class="mb-4"
          color="warning"
          variant="subtle"
          title="Not imported"
          :description="notice"
        />
        <AdminUploadsUploadReport :upload="current" />
        <AdminUploadsImportForm
          v-if="
            current.status === 'ready' && current.report.ok && !current.report.nothing_to_import
          "
          class="mt-6"
          :upload="current"
          @imported="onImported"
          @refused="onRefused"
        />
        <p
          v-else-if="current.report.nothing_to_import"
          class="mt-6 text-sm"
          data-testid="nothing-to-import"
        >
          Every day in this file is already loaded with exactly these calls. There is nothing to
          import.
        </p>
        <p v-else-if="!current.report.ok" class="mt-6 text-sm" data-testid="cannot-import">
          This file cannot be imported until the problems above are fixed. Export it again and
          upload the new file.
        </p>
      </template>
    </UCard>

    <AdminUploadsImportOutcome
      v-if="outcome"
      :upload="outcome.upload"
      :run="outcome.run"
      @close="outcome = null"
    />

    <AdminUploadsUploadHistory :uploads="uploads" @open="open" @discard="discard" />
  </div>
</template>
