import { authClient } from '../utils/auth-client'

// Signed-out visitors go to /auth, signed-in ones away from it, and only admins see
// /admin. The API checks the same rules again (server/middleware/auth.ts).
export default defineNuxtRouteMiddleware(async (to) => {
  const { data: session } = await authClient.useSession(useFetch)

  if (session.value) {
    if (to.path === '/auth') {
      return navigateTo('/')
    }
    const adminPage = to.path === '/admin' || to.path.startsWith('/admin/')
    if (adminPage && session.value.user.role !== 'admin') {
      return navigateTo('/')
    }
  } else {
    if (to.path !== '/auth') {
      return navigateTo('/auth')
    }
  }
})
