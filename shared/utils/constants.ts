// Limits and fixed texts shared by the API and the pages.
import type { DataSource } from '../types/api'

export const MAX_RANGE_DAYS = 366
export const DEFAULT_HORIZON_DAYS = 30
export const MAX_TARGET_SEC = 3600
export const MAX_PATIENCE_SEC = 86400
export const MAX_PLANNED = 1000

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
