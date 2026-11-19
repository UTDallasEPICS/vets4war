import type { ComputedRef } from 'vue'
import { authClient } from '../utils/auth-client'

export interface SessionUserView {
  id: string
  email: string
  name: string
  role: 'viewer' | 'admin'
}

// The signed-in person for page code: who it is, whether they may use the admin page,
// and a sign-out that lands on the sign-in page.
export async function useSessionUser(): Promise<{
  user: ComputedRef<SessionUserView | null>
  isAdmin: ComputedRef<boolean>
  signOut: () => Promise<void>
}> {
  const { data } = await authClient.useSession(useFetch)

  const user = computed<SessionUserView | null>(() => {
    const u = data.value?.user
    if (!u) return null
    return { id: u.id, email: u.email, name: u.name, role: u.role === 'admin' ? 'admin' : 'viewer' }
  })
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function signOut() {
    await authClient.signOut()
    await navigateTo('/auth', { external: true })
  }

  return { user, isAdmin, signOut }
}
