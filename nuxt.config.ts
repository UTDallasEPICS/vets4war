// https://nuxt.com/docs/api/configuration/nuxt-config
import { SECURITY_HEADERS } from './server/utils/security-headers'

// The four routes that keep final-main's response shapes. In development they can be
// proxied to the legacy API (V4W_DEV_API_PROXY) so the console is compared on equal data.
const LEGACY_SHAPED_ROUTES = ['/api/forecast', '/api/staffing', '/api/planned', '/api/model']
const devApiProxy = process.env.V4W_DEV_API_PROXY

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/image', '@nuxt/eslint'],
  css: ['~/assets/css/main.css'],
  app: { head: { title: 'Vets4Warriors staffing', htmlAttrs: { lang: 'en' } } },
  // Light unless the person chose dark, as on the old console; same storage key, so the
  // old choice carries over.
  colorMode: { preference: 'light', fallback: 'light', storageKey: 'v4w-theme' },
  // Icons come only from the installed collections (@iconify-json/heroicons for ours,
  // @iconify-json/lucide for Nuxt UI's), served by our own server: never from the
  // Iconify API, so the app works without outbound access. The endpoint lives outside
  // /api/ so the auth gate does not refuse it on the sign-in page; icons named in the
  // app's source are also bundled into the client and need no request at all.
  icon: {
    serverBundle: { collections: ['heroicons', 'lucide'] },
    clientBundle: { scan: true },
    fallbackToApi: false,
    localApiEndpoint: '/_nuxt_icon',
  },
  // Prettier owns formatting; ESLint handles logic only (no stylistic rules).
  eslint: { config: { stylistic: false } },
  // Type errors in the terminal during `nuxt dev` only; CI runs `pnpm typecheck`.
  typescript: { typeCheck: process.env.NODE_ENV !== 'production' },
  nitro: {
    experimental: { tasks: true },
    // On every response: pages, API, static files and errors (server/utils/security-headers.ts).
    routeRules: { '/**': { headers: SECURITY_HEADERS } },
    // Build-time setting, server local time (UTC in the image). The task itself checks
    // V4W_RETRAIN_SCHEDULE at run time.
    scheduledTasks: { [process.env.V4W_RETRAIN_CRON || '30 8 * * *']: ['retrain:tick'] },
  },
  $development: {
    nitro: {
      routeRules: devApiProxy
        ? Object.fromEntries(
            LEGACY_SHAPED_ROUTES.map((path) => [path, { proxy: devApiProxy + path }])
          )
        : {},
    },
  },
  vite: {
    optimizeDeps: { include: ['better-auth/client/plugins', 'better-auth/vue', 'zod'] },
  },
})
