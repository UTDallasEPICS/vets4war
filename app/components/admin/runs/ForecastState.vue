<script setup lang="ts">
  // What is being served and how it relates to the stored calls: the model in use and
  // the calls it was trained on, the calls the forecast was made from, and, when the
  // stored calls are newer than either, which retrain left them out and why. Built from
  // /api/status and the runs list; nothing here decides anything.
  import type { RunSummary, StatusResponse } from '#shared/types/api'

  const props = defineProps<{
    status: StatusResponse | null
    runs: RunSummary[]
    activeRunId: number | null
    lastDay: string | null // newest stored call day
  }>()

  const day = (timestamp: string) => timestamp.slice(0, 10)
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

  // The newest retrain that has ended (runs come newest first).
  const lastRetrain = computed(
    () =>
      props.runs.find(
        (run) => run.mode === 'full' && run.status !== 'queued' && run.status !== 'running'
      ) ?? null
  )

  const OUTCOME: Record<string, string> = {
    succeeded: 'succeeded',
    rejected: 'did not beat the simple baseline, so it kept the previous model',
    failed: 'failed',
    interrupted: 'was interrupted',
  }
  const outcome = (run: RunSummary) => {
    const what =
      run.status === 'rejected' && run.forecast_written === false
        ? 'did not beat the simple baseline, and there was no previous model to keep'
        : (OUTCOME[run.status] ?? run.status)
    return `The last retrain (run ${run.id}) ${what}${run.message ? `: ${run.message}` : '.'}`
  }

  interface Note {
    tone: 'info' | 'warning'
    text: string
  }

  const serving = computed(() => {
    const forecast = props.status?.forecast
    const model = props.status?.model
    if (!forecast || !model) return null
    return {
      text:
        `Serving the forecast of run ${forecast.run_id}, made ${when(forecast.generated_at)}. ` +
        `Model ${model.id} was trained on calls through ${day(model.train_end)}; ` +
        `the forecast's handle time and caller patience use calls through ${forecast.data_end}.`,
      modelEnd: day(model.train_end),
      dataEnd: forecast.data_end,
      stale: forecast.stale,
    }
  })

  const note = computed<Note | null>(() => {
    if (!props.status || !props.lastDay) return null
    const running = props.activeRunId !== null
    const last = lastRetrain.value
    if (!serving.value) {
      if (running) return { tone: 'info', text: 'No forecast yet: the first retrain is running.' }
      return {
        tone: 'warning',
        text: last
          ? `No forecast is served yet. ${outcome(last)}`
          : 'No forecast is served yet. Start a retrain.',
      }
    }
    const { modelEnd, dataEnd, stale } = serving.value
    if (stale) {
      const behind = `The stored calls (through ${props.lastDay}) are newer than this forecast.`
      if (running) return { tone: 'info', text: `${behind} A run is working on them now.` }
      // Only a retrain that read the newest calls can be what left them out.
      if (last && last.status !== 'succeeded' && last.data_end === props.lastDay) {
        return {
          tone: 'warning',
          text: `${behind} ${outcome(last)} Fix the cause and retrain; Refresh forecast would use them with the model in use.`,
        }
      }
      return { tone: 'warning', text: `${behind} Retrain to bring them in.` }
    }
    if (modelEnd < dataEnd) {
      const older = `The model in use is older than the data: trained through ${modelEnd}, data through ${dataEnd}.`
      return {
        tone: last && last.status !== 'succeeded' ? 'warning' : 'info',
        text: last ? `${older} ${outcome(last)}` : older,
      }
    }
    return null
  })
</script>

<template>
  <div v-if="status" class="space-y-3 text-sm" data-testid="forecast-state">
    <p v-if="serving" class="text-toned leading-relaxed">{{ serving.text }}</p>
    <UAlert
      v-if="note"
      :color="note.tone"
      variant="subtle"
      :icon="
        note.tone === 'warning'
          ? 'i-heroicons-exclamation-triangle-20-solid'
          : 'i-heroicons-information-circle-20-solid'
      "
      :title="note.text"
      data-testid="forecast-note"
    />
  </div>
</template>
