import { defineEventHandler, getRequestHeader } from 'h3'
import { auth } from '../utils/auth'
import { checkAccess, isPublicPath } from '../utils/access'
import { env } from '../utils/env'
import { apiError } from '../utils/http'
import type { SessionUser } from '../utils/session'

// Make the resolved session available to every downstream handler so routes
// can read event.context.user / event.context.session instead of calling
// auth.api.getSession() themselves.
declare module 'h3' {
  interface H3EventContext {
    user?: SessionUser
    session?: typeof auth.$Infer.Session.session
  }
}

// API gateway (docs/better_auth.md): public prefixes, session, admin prefix, origin of
// writes. Page navigation and assets are handled by app/middleware/auth.global.ts.
export default defineEventHandler(async (event) => {
  if (isPublicPath(event.path)) {
    return
  }

  const session = await auth.api.getSession({
    headers: event.headers,
  })

  const user: SessionUser | null = session
    ? { ...session.user, role: session.user.role === 'admin' ? 'admin' : 'viewer' }
    : null

  const access = checkAccess({
    path: event.path,
    method: event.method,
    origin: getRequestHeader(event, 'origin') ?? null,
    authOrigin: env.BETTER_AUTH_URL,
    user,
  })

  if (!access.ok) {
    throw apiError(access.status, access.code, access.message)
  }

  event.context.user = user ?? undefined
  event.context.session = session?.session
})
