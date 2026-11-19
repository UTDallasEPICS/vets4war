// Every icon the app shows is served from an installed collection, by our own server,
// at a path the auth gate lets through: no request to the Iconify API, at build or run
// time, and no 401 on the sign-in page (review finding W0-2).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll } from 'vitest'
import { isPublicPath } from '../../../server/utils/access'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(ROOT, 'package.json'))
const COLLECTIONS = ['heroicons', 'lucide']

interface IconSet {
  icons: Record<string, unknown>
  aliases?: Record<string, unknown>
}

function loadCollection(name: string): IconSet {
  return JSON.parse(readFileSync(require.resolve(`@iconify-json/${name}/icons.json`), 'utf8'))
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

// 'i-heroicons-moon-20-solid' -> ['heroicons', 'moon-20-solid']
function split(icon: string): [string, string] {
  const rest = icon.slice(2)
  const collection = COLLECTIONS.find((c) => rest.startsWith(c + '-'))
  return collection ? [collection, rest.slice(collection.length + 1)] : ['?', rest]
}

describe('icons', () => {
  const sets: Record<string, IconSet> = {}
  const has = (icon: string) => {
    const [collection, name] = split(icon)
    const set = sets[collection]
    return !!set && (name in set.icons || name in (set.aliases ?? {}))
  }

  beforeAll(() => {
    for (const name of COLLECTIONS) sets[name] = loadCollection(name)
  })

  it('has every icon named in the app installed (layout, pages, admin panels, console)', () => {
    const used = new Set<string>()
    for (const file of filesUnder(join(ROOT, 'app')).filter((f) => /\.(vue|ts)$/.test(f))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/['"`\s](i-[a-z0-9]+-[a-z0-9-]+)/g)) {
        used.add(match[1]!)
      }
    }
    expect(used.size).toBeGreaterThan(0)
    expect([...used].filter((icon) => !has(icon))).toEqual([])
  })

  it("has Nuxt UI's own icons installed (loading, close, chevrons, ...)", () => {
    const ui = join(ROOT, 'node_modules', '@nuxt', 'ui', 'dist', 'shared')
    const defaults = new Set<string>()
    for (const file of readdirSync(ui).filter((f) => f.endsWith('.mjs'))) {
      for (const match of readFileSync(join(ui, file), 'utf8').matchAll(
        /"(i-lucide-[a-z0-9-]+)"/g
      )) {
        defaults.add(match[1]!)
      }
    }
    expect(defaults.has('i-lucide-loader-circle')).toBe(true)
    expect([...defaults].filter((icon) => !has(icon))).toEqual([])
  })

  it('serves them locally, outside the auth gate, never from the Iconify API', async () => {
    const stub = globalThis as unknown as { defineNuxtConfig?: (c: unknown) => unknown }
    stub.defineNuxtConfig = (config) => config
    const config = (await import('../../../nuxt.config')).default as unknown as {
      icon?: {
        serverBundle?: { collections?: string[] }
        fallbackToApi?: unknown
        localApiEndpoint?: string
      }
    }
    expect(config.icon?.fallbackToApi).toBe(false)
    expect(config.icon?.serverBundle?.collections).toEqual(COLLECTIONS)
    const endpoint = config.icon?.localApiEndpoint ?? '/api/_nuxt_icon'
    expect(isPublicPath(`${endpoint}/heroicons.json`)).toBe(true)
  })
})
