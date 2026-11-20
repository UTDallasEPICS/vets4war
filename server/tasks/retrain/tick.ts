// Scheduled tick of the retrain runner (cron in nuxt.config.ts, V4W_RETRAIN_CRON at build
// time). Whether anything starts is decided at run time by the runner: V4W_RETRAIN_SCHEDULE,
// a run in progress, call data newer than the forecast, or a forecast older than 20 hours.
import { useRetrainRunner } from '../../utils/retrain'

export default defineTask({
  meta: {
    name: 'retrain:tick',
    description: 'Start a retrain or a forecast refresh when one is due',
  },
  run() {
    const result = useRetrainRunner().tick()
    console.log(`[retrain] scheduled tick: ${result.action} (${result.reason})`)
    return { result }
  },
})
