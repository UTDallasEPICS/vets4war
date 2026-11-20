// Nuxt finds the exports of app/composables, app/utils and shared/{utils,types} by turning
// each directory's absolute path into a glob. Glob characters in the folder the project
// lives in (a parent folder named "Vets4Warriors (EPICS client)" is enough) make that
// glob match nothing, and apiFetch, useSessionUser and the rest go missing without an
// error. Escaping the path does not help: Nuxt and the scanner both normalise it, which
// removes the escapes. So this module lists the same files itself (top-level files with
// the same extensions as Nuxt's scan) and reads their exports with the same parser,
// adding whatever Nuxt's own scan missed. Where the path has no glob characters it does
// nothing.
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineNuxtModule } from 'nuxt/kit'

interface ScannedImport {
  name: string
  as?: string
  from: string
}
interface Scanner {
  scanExports: (file: string, includeTypes: boolean) => Promise<ScannedImport[]>
  dedupeDtsExports: (imports: ScannedImport[]) => ScannedImport[]
}

const GLOB_CHARS = /[()[\]{}*?!+@]/
const EXTENSIONS = new Set(['.mts', '.cts', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx'])

// The parser Nuxt itself uses (unimport), from Nuxt's own dependencies, so the two can
// never be different versions.
async function loadScanner(): Promise<Scanner> {
  const fromProject = createRequire(import.meta.url)
  const fromNuxt = createRequire(fromProject.resolve('nuxt/package.json'))
  return (await import(pathToFileURL(fromNuxt.resolve('unimport')).href)) as Scanner
}

function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && EXTENSIONS.has(extname(entry.name)))
      .map((entry) => join(dir, entry.name))
      .sort()
  } catch {
    return [] // a directory that does not exist has nothing to import
  }
}

export default defineNuxtModule({
  meta: { name: 'path-safe-imports' },
  async setup(_options, nuxt) {
    const root = nuxt.options.rootDir
    if (!GLOB_CHARS.test(root)) return

    const { scanExports, dedupeDtsExports } = await loadScanner()
    const dirs = [
      resolve(nuxt.options.srcDir, 'composables'),
      resolve(nuxt.options.srcDir, 'utils'),
      resolve(root, 'shared', 'utils'),
      resolve(root, 'shared', 'types'),
    ]

    nuxt.hook('imports:extend', async (imports) => {
      const files = dirs.flatMap(filesIn)
      const found = dedupeDtsExports(
        (await Promise.all(files.map((file) => scanExports(file, true)))).flat()
      )
      const known = new Set(imports.map((i) => `${i.from}#${i.as ?? i.name}`))
      for (const entry of found) {
        if (!known.has(`${entry.from}#${entry.as ?? entry.name}`)) imports.push(entry)
      }
    })
  },
})
