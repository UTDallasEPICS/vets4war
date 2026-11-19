// Who may call which API path (PLAN.md section 5). Pure, so every rule is unit-tested;
// server/middleware/auth.ts applies it to each request.

// Better Auth's own endpoints (sign-in, email OTP, get-session) and the health check
// must answer without a session.
const PUBLIC_PREFIXES = ['/api/auth', '/api/health']
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export type AccessResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; code: 'unauthorized' | 'forbidden'; message: string }

// The path as the router sees it: no query, percent-escapes decoded, repeated slashes
// collapsed, so '/api//admin/x' or '/api/%61dmin/x' cannot slip past a prefix check.
function normalise(path: string): string | null {
  const pathname = path.split('?')[0] ?? path
  try {
    return decodeURIComponent(pathname).replace(/\/{2,}/g, '/')
  } catch {
    return null
  }
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/')

// Paths that pass without a session: everything outside /api/ (pages and assets are
// guarded by app/middleware/auth.global.ts) and the public API prefixes.
export function isPublicPath(path: string): boolean {
  const normalised = normalise(path)
  if (normalised === null) return false
  if (!normalised.toLowerCase().startsWith('/api/')) return true
  return PUBLIC_PREFIXES.some((prefix) => under(normalised, prefix))
}

export function checkAccess(input: {
  path: string
  method: string
  origin: string | null
  authOrigin: string
  user: { role: string } | null
}): AccessResult {
  if (isPublicPath(input.path)) return { ok: true }

  if (!input.user) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in to use this.' }
  }

  // Lower-cased so a differently cased path can only be treated more strictly.
  const path = (normalise(input.path) ?? input.path).toLowerCase()
  if (under(path, '/api/admin') && input.user.role !== 'admin') {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'Only an admin can do this.',
    }
  }

  // A browser sends Origin on cross-site writes; a write from another site is refused
  // even with a valid session cookie. Requests without Origin (curl, server-side
  // calls) carry no ambient browser credentials from another site.
  if (STATE_CHANGING.has(input.method.toUpperCase()) && input.origin !== null) {
    const from = originOf(input.origin)
    if (from === null || from !== originOf(input.authOrigin)) {
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        message: 'This request came from another site and was refused.',
      }
    }
  }

  return { ok: true }
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}
