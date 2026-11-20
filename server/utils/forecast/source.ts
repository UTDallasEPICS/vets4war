// The data badge every forecast answer carries (final-main's db/source.py): which data
// (the operator's V4W_DATA_SOURCE label, never guessed) and the date range of the calls
// the served forecast was computed from.
import { SOURCE_LABELS } from '#shared/utils/constants'
import type { DataSource } from '#shared/types/api'
import type { ForecastStateRow } from './store'

export function describeSource(
  kind: DataSource['kind'],
  state: Pick<ForecastStateRow, 'dataStart' | 'dataEnd'>
): DataSource {
  return { kind, label: SOURCE_LABELS[kind], start: state.dataStart, end: state.dataEnd }
}
