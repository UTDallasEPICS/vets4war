// Limits and fixed texts shared by the API and the pages.
import type { DataSource } from '../types/api'

export const MAX_RANGE_DAYS = 366
export const DEFAULT_HORIZON_DAYS = 30
export const MAX_PLANNED = 1000

// Bounds of the staffing controls. This is the one place they are written down: the
// read API validates with them (server/utils/forecast/params.ts) and the console refuses
// a setting outside them before it asks (app/composables/console/useConsoleState.ts).
//
// They are tighter than final-main's (0 < target_pct < 1, target_sec <= 3600,
// 0 < patience_sec <= 86400) because the Erlang A chain runs on the server's one
// thread. Outside these bounds one request cost up to 31 s of CPU per day of range
// (patience 20 s, answer within 3600 s): the uniformization behind the service level
// needs (target_sec / patience_sec) x queue length steps, and exp() underflows to 0
// once that passes ~745, after which every hour runs to the 100,000-step cap. Inside
// them the worst case measured was about 37 ms per day (on synthetic data).
// target_pct stops at 0.999 because the TypeScript Erlang A service level saturates
// at 1 - 2.2e-16, so a target closer to 1 could never be met.
export const MAX_TARGET_PCT = 0.999
export const MAX_TARGET_SEC = 300
// Also the lowest caller-patience ESTIMATE a forecast may carry: the retrain script
// refuses to write a smaller one and the read API refuses to compute with one.
// Python cannot import this file: MIN_PATIENCE_SEC in forecast/db/retrain.py must stay
// equal to it (tests/unit/shared/constants.test.ts compares the two).
export const MIN_PATIENCE_SEC = 10
export const MAX_PATIENCE_SEC = 3600

// api/main.py: TALK_TIME_CAVEAT, verbatim.
export const TALK_TIME_CAVEAT =
  'Expected talk time is inbound talk time on forecast calls only: predicted calls ' +
  'times the average handle time for that weekday and hour. It excludes outbound ' +
  'follow-up and after-call work. Handle times are recency-weighted means of ' +
  'answered inbound calls in the calls table, excluding calls recorded with zero ' +
  'agent time.'

// db/source.py: LABELS. What the data badge says; the kind comes from V4W_DATA_SOURCE.
export const SOURCE_LABELS: Readonly<Record<DataSource['kind'], string>> = {
  partner: 'Partner data',
  synthetic: 'Synthetic data',
  unlabeled: 'Data source not set (V4W_DATA_SOURCE)',
}

// Columns a call sheet of the partner's export must have.
export const REQUIRED_CALL_COLUMNS = [
  'Start_Date',
  'start_time',
  'InQueue',
  'Agent_Time',
  'Abandon_Time',
  'Routing_Time',
  'Abandon',
] as const
