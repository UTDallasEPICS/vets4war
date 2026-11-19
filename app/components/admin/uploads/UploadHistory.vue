<script setup lang="ts">
  // The last uploads: file, who, when, status, days, and the run an import started.
  import type { UploadStatus, UploadSummary } from '#shared/types/api'

  defineProps<{ uploads: UploadSummary[] }>()
  defineEmits<{ open: [id: number]; discard: [id: number] }>()

  type Color = 'success' | 'neutral' | 'warning' | 'error' | 'info'
  const STATUS: Record<UploadStatus, { label: string; color: Color }> = {
    parsing: { label: 'Reading', color: 'info' },
    ready: { label: 'Checked, not imported', color: 'warning' },
    invalid: { label: 'Cannot be imported', color: 'error' },
    importing: { label: 'Importing', color: 'info' },
    imported: { label: 'Imported', color: 'success' },
    discarded: { label: 'Discarded', color: 'neutral' },
    failed: { label: 'Could not be read', color: 'error' },
  }
  const DISCARDABLE: UploadStatus[] = ['ready', 'invalid', 'failed']
  const OPENABLE: UploadStatus[] = ['parsing', 'ready', 'invalid', 'failed']
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-lg font-semibold">Recent uploads</h2>
    </template>
    <p v-if="!uploads.length" class="text-sm text-gray-600 dark:text-gray-300">
      No call data has been uploaded yet.
    </p>
    <div v-else class="relative overflow-x-auto">
      <table class="w-full text-left text-sm" data-testid="upload-history">
        <thead class="text-gray-500 dark:text-gray-400">
          <tr>
            <th class="py-1 pr-4 font-medium">File</th>
            <th class="py-1 pr-4 font-medium">By</th>
            <th class="py-1 pr-4 font-medium">When</th>
            <th class="py-1 pr-4 font-medium">Status</th>
            <th class="py-1 pr-4 font-medium">Days</th>
            <th class="py-1 pr-4 font-medium">Retrain</th>
            <th class="py-1"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="upload in uploads"
            :key="upload.id"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="max-w-80 min-w-48 py-1 pr-4 break-words">
              <button
                v-if="OPENABLE.includes(upload.status)"
                type="button"
                class="text-left underline"
                @click="$emit('open', upload.id)"
              >
                {{ upload.filename }}
              </button>
              <span v-else>{{ upload.filename }}</span>
            </td>
            <td class="py-1 pr-4 whitespace-nowrap">{{ upload.uploaded_by }}</td>
            <td class="py-1 pr-4 whitespace-nowrap">{{ when(upload.created_at) }}</td>
            <td class="py-1 pr-4 whitespace-nowrap">
              <UBadge :color="STATUS[upload.status].color" variant="subtle">
                {{ STATUS[upload.status].label }}
              </UBadge>
            </td>
            <td class="py-1 pr-4 whitespace-nowrap tabular-nums">
              <template v-if="upload.first_day">
                {{ upload.first_day }} to {{ upload.last_day }}
              </template>
            </td>
            <td class="py-1 pr-4 whitespace-nowrap">
              <NuxtLink v-if="upload.run_id" to="/admin?tab=runs" class="underline">
                Run {{ upload.run_id }}
              </NuxtLink>
              <span
                v-else-if="upload.status === 'imported'"
                class="text-gray-500 dark:text-gray-400"
              >
                Waiting for a retrain
              </span>
            </td>
            <td class="py-1 text-right">
              <UButton
                v-if="DISCARDABLE.includes(upload.status)"
                size="xs"
                color="neutral"
                variant="outline"
                label="Discard"
                @click="$emit('discard', upload.id)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </UCard>
</template>
