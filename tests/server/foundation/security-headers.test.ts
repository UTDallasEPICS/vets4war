// The security headers are on every route of the app (nuxt.config.ts route rules), and
// are exactly the basic set: no Content-Security-Policy yet. `pnpm e2e` checks them on a
// page, an API refusal and a static file of the production build.
import { describe, expect, it, vi } from 'vitest'
import { SECURITY_HEADERS } from '../../../server/utils/security-headers'

vi.hoisted(() => {
  // nuxt.config.ts uses Nuxt's global helper; outside Nuxt it only has to hand back the
  // configuration.
  ;(globalThis as Record<string, unknown>).defineNuxtConfig = (config: unknown) => config
})

// A path in a variable, so the type check of the tests does not take in nuxt.config.ts
// (it needs Nuxt's generated types).
const NUXT_CONFIG = '../../../nuxt.config'
const { default: config } = (await import(/* @vite-ignore */ NUXT_CONFIG)) as { default: unknown }

describe('security headers', () => {
  it('are the basic set, without a Content-Security-Policy', () => {
    expect(SECURITY_HEADERS).toEqual({
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    })
  })

  it('apply to every route', () => {
    const rules = (config as { nitro: { routeRules: Record<string, { headers?: unknown }> } }).nitro
      .routeRules
    expect(rules['/**']).toEqual({ headers: SECURITY_HEADERS })
  })
})
