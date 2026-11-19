// Scheduled tick of the retrain runner. Replaced by the ingest package (WP3).
export default defineTask({
  meta: {
    name: 'retrain:tick',
    description: 'Start a retrain or a forecast refresh when one is due',
  },
  run() {
    return { result: 'not implemented' }
  },
})
