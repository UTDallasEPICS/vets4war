// The process-wide retrain runner, configured from the environment (server/utils/env.ts).
import { db, resolveDatabasePath } from '../db'
import { env } from '../env'
import { createRetrainRunner, type RetrainConfig, type RetrainRunner } from './runner'

export function retrainConfig(): RetrainConfig {
  return {
    pythonPath: env.V4W_PYTHON,
    module: env.V4W_RETRAIN_MODULE,
    forecastDir: env.V4W_FORECAST_DIR,
    dbPath: resolveDatabasePath(env.DATABASE_URL, process.cwd()),
    timeoutMs: env.V4W_RETRAIN_TIMEOUT_MIN * 60_000,
    scheduleEnabled: env.V4W_RETRAIN_SCHEDULE === 'on',
  }
}

let runner: RetrainRunner | null = null

export function useRetrainRunner(): RetrainRunner {
  runner ??= createRetrainRunner(db, retrainConfig())
  return runner
}
