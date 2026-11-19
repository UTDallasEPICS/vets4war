import type { H3Event } from 'h3'
import type { auth } from './auth'
import { apiError } from './http'

// The session user with its role narrowed (set by server/middleware/auth.ts): the
// column is NOT NULL with a 'viewer' default, and anything that is not exactly
// 'admin' is treated as a viewer.
export type SessionUser = Omit<typeof auth.$Infer.Session.user, 'role'> & {
  role: 'viewer' | 'admin'
}

// Returns the session user attached by the auth gateway (server/middleware/auth.ts).
// Throws 401 if it is absent, so protected routes get a typed, non-null user
// instead of asserting event.context.user! and trusting the middleware ran.
export function requireUser(event: H3Event) {
  const user = event.context.user

  if (!user) {
    throw apiError(401, 'unauthorized', 'Sign in to use this.')
  }

  return user
}

// Admin routes call this even though the gateway already checked the /api/admin/
// prefix: it gives a typed user and survives a route being moved.
export function requireAdmin(event: H3Event) {
  const user = requireUser(event)

  if (user.role !== 'admin') {
    throw apiError(403, 'forbidden', 'Only an admin can do this.')
  }

  return user as typeof user & { role: 'admin' }
}
