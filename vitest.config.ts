import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

const root = fileURLToPath(new URL('.', import.meta.url))
const alias = { '~~': root, '@@': root, '#shared': root + 'shared' }

// unit:   pure logic and server services, node environment, in-memory SQLite. No .env,
//         no database file, no Python, no network (template REQ-NF-06).
// nuxt:   components in the Nuxt environment (the template's project).
// parity: cross-language checks; needs forecast/.venv (pnpm forecast:setup).
export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/server/**/*.test.ts'],
        },
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          environment: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          // Node 25+ defines its own global localStorage (undefined without
          // --localstorage-file), which hides the DOM environment's one. Turn it off so
          // the components see the browser-like storage on every Node version.
          execArgv: ['--no-experimental-webstorage'],
        },
      }),
      {
        resolve: { alias },
        test: {
          name: 'parity',
          environment: 'node',
          include: ['tests/parity/**/*.test.ts'],
          testTimeout: 180_000,
        },
      },
    ],
  },
})
