// @vitest-environment nuxt
//
// The default layout (header of /auth and /admin): brand link home, theme toggle,
// and the Admin link only for admins. useSessionUser is mocked, so the test never
// opens the database, sends mail or makes a network request (see docs/testing.md).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import DefaultLayout from '../../app/layouts/default.vue'

const session = vi.hoisted(() => ({
  current: null as null | { id: string; email: string; name: string; role: 'viewer' | 'admin' },
  signOut: () => Promise.resolve(),
}))

mockNuxtImport('useSessionUser', () => {
  return async () => ({
    user: computed(() => session.current),
    isAdmin: computed(() => session.current?.role === 'admin'),
    signOut: session.signOut,
  })
})

const admin = { id: 'u1', email: 'admin@example.org', name: 'admin', role: 'admin' as const }
const viewer = { id: 'u2', email: 'viewer@example.org', name: 'viewer', role: 'viewer' as const }

describe('default layout', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    session.current = null
  })

  it('links the brand to the home route', async () => {
    const wrapper = await mountSuspended(DefaultLayout)
    const brand = wrapper.get('a')
    expect(brand.text()).toBe('Vets4Warriors staffing')
    expect(brand.attributes('href')).toBe('/')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('exposes an accessible "Toggle Theme" control', async () => {
    const wrapper = await mountSuspended(DefaultLayout)
    expect(wrapper.find('[aria-label="Toggle Theme"]').exists()).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows Staffing, Admin, the email and Sign out to an admin', async () => {
    session.current = admin
    const wrapper = await mountSuspended(DefaultLayout)
    const links = wrapper.findAll('nav a').map((a) => [a.text(), a.attributes('href')])
    expect(links).toEqual([
      ['Staffing', '/'],
      ['Admin', '/admin'],
    ])
    expect(wrapper.text()).toContain('admin@example.org')
    expect(wrapper.text()).toContain('Sign out')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hides the Admin link from a viewer', async () => {
    session.current = viewer
    const wrapper = await mountSuspended(DefaultLayout)
    const labels = wrapper.findAll('nav a').map((a) => a.text())
    expect(labels).toEqual(['Staffing'])
    expect(wrapper.find('a[href="/admin"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('viewer@example.org')
  })

  it('shows no navigation or Sign out when nobody is signed in', async () => {
    const wrapper = await mountSuspended(DefaultLayout)
    expect(wrapper.find('nav').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Sign out')
  })
})
