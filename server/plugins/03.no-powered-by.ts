import { removeResponseHeader } from 'h3'

// Nuxt's page renderer names itself in X-Powered-By. An answer should not tell a visitor
// which software, and so which known flaws, the server has: the header is taken off
// every answer just before it is sent. The headers that are added to every answer are
// in server/utils/security-headers.ts.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event) => {
    removeResponseHeader(event, 'x-powered-by')
  })
})
