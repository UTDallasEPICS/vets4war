// The bounds of the staffing controls are written down once, in shared/utils/constants.ts.
// Two things can still drift apart without a type error: the Python retrain script keeps
// its own copy of the patience floor (it cannot import TypeScript), and the bounds must
// stay the ones the read API and the console were measured with.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  MAX_PATIENCE_SEC,
  MAX_TARGET_PCT,
  MAX_TARGET_SEC,
  MIN_PATIENCE_SEC,
} from '#shared/utils/constants'
import { parseForecastQuery } from '../../../server/utils/forecast/params'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('bounds of the staffing controls', () => {
  it('the retrain script refuses a caller patience below the same floor as the read API', () => {
    const source = read('../../../forecast/db/retrain.py')
    const match = /^MIN_PATIENCE_SEC = ([0-9.]+)$/m.exec(source)
    expect(match, 'MIN_PATIENCE_SEC is defined in forecast/db/retrain.py').not.toBeNull()
    expect(Number(match![1])).toBe(MIN_PATIENCE_SEC)
  })

  it('the read API accepts exactly the shared bounds', () => {
    const today = '2026-11-19'
    const ok = (query: Record<string, string>) => () => parseForecastQuery(query, today)
    expect(ok({ target_pct: String(MAX_TARGET_PCT) })).not.toThrow()
    expect(ok({ target_sec: String(MAX_TARGET_SEC) })).not.toThrow()
    expect(ok({ patience_sec: String(MIN_PATIENCE_SEC) })).not.toThrow()
    expect(ok({ patience_sec: String(MAX_PATIENCE_SEC) })).not.toThrow()
    expect(ok({ target_pct: String(MAX_TARGET_PCT + 0.0001) })).toThrow()
    expect(ok({ target_sec: String(MAX_TARGET_SEC + 1) })).toThrow()
    expect(ok({ patience_sec: String(MIN_PATIENCE_SEC - 0.01) })).toThrow()
    expect(ok({ patience_sec: String(MAX_PATIENCE_SEC + 1) })).toThrow()
  })

  it('the console state takes its two bounds from the shared file, not from a copy', () => {
    const source = read('../../../app/composables/console/useConsoleState.ts')
    const imported = /import \{([^}]*)\} from '#shared\/utils\/constants'/.exec(source)?.[1] ?? ''
    expect(imported).toMatch(/\bMAX_TARGET_PCT\b/)
    expect(imported).toMatch(/\bMAX_TARGET_SEC\b/)
    expect(source).not.toMatch(/const MAX_TARGET_(PCT|SEC)\s*=/)
  })
})
