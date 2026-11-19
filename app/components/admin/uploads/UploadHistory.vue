<script setup lang="ts">
  // The last uploads: file, who, when, status, days, and the run an import started.
  import type { UploadStatus, UploadSummary } from '#shared/types/api'
  import type { StatusTone } from '../StatusChip.vue'

  defineProps<{ uploads: UploadSummary[] }>()
  defineEmits<{ open: [id: number]; discard: [id: number] }>()

  const STATUS: Record<UploadStatus, { label: string; tone: StatusTone; busy?: boolean }> = {
    parsing: { label: 'Reading', tone: 'info', busy: true },
    ready: { label: 'Checked, not imported', tone: 'warn' },
    invalid: { label: 'Cannot be imported', tone: 'bad' },
    importing: { label: 'Importing', tone: 'info', busy: true },
    imported: { label: 'Imported', tone: 'good' },
    discarded: { label: 'Discarded', tone: 'neutral' },
    failed: { label: 'Could not be read', tone: 'bad' },
  }
  const DISCARDABLE: UploadStatus[] = ['ready', 'invalid', 'failed']
  const OPENABLE: UploadStatus[] = ['parsing', 'ready', 'invalid', 'failed']
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <section class="tile space-y-4" aria-labelledby="uploads-title">
    <h2 id="uploads-title" class="tile-title">Recent uploads</h2>
    <p v-if="!uploads.length" class="text-muted text-sm">
      No call data has been uploaded yet. Load the call-records export above to start.
    </p>
    <div v-else class="relative overflow-x-auto">
      <table class="data-table" data-testid="upload-history">
        <thead>
          <tr>
            <th>File</th>
            <th>By</th>
            <th>When</th>
            <th>Status</th>
            <th>Days</th>
            <th>Retrain</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="upload in uploads" :key="upload.id">
            <td class="max-w-80 min-w-48 break-words">
              <button
                v-if="OPENABLE.includes(upload.status)"
                type="button"
                class="text-link text-left"
                @click="$emit('open', upload.id)"
              >
                {{ upload.filename }}
              </button>
              <span v-else class="font-medium">{{ upload.filename }}</span>
            </td>
            <td class="text-muted whitespace-nowrap">{{ upload.uploaded_by }}</td>
            <td class="text-muted whitespace-nowrap">{{ when(upload.created_at) }}</td>
            <td>
              <AdminStatusChip
                :tone="STATUS[upload.status].tone"
                :label="STATUS[upload.status].label"
                :busy="STATUS[upload.status].busy"
              />
            </td>
            <td class="whitespace-nowrap">
              <template v-if="upload.first_day">
                {{ upload.first_day }} to {{ upload.last_day }}
              </template>
            </td>
            <td class="whitespace-nowrap">
              <NuxtLink v-if="upload.run_id" to="/admin?tab=runs" class="text-link">
                Run {{ upload.run_id }}
              </NuxtLink>
              <span v-else-if="upload.status === 'imported'" class="text-muted">
                Waiting for a retrain
              </span>
            </td>
            <td class="text-right">
              <UButton
                v-if="DISCARDABLE.includes(upload.status)"
                size="xs"
                color="neutral"
                variant="soft"
                class="bg-default"
                label="Discard"
                @click="$emit('discard', upload.id)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
