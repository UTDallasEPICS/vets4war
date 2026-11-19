// @vitest-environment nuxt
//
// The admin page: three tabs, the tab comes from ?tab=, and exactly one panel shows.
// Navigating to /admin runs the global route guard, so the auth client answers with
// an admin session here instead of asking the server.

import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AdminPage from '../../app/pages/admin.vue'

vi.mock('../../app/utils/auth-client', () => ({
  authClient: {
    useSession: async () => ({
      data: ref({ user: { id: 'u1', email: 'admin@example.org', name: 'admin', role: 'admin' } }),
    }),
  },
}))

describe('admin page', () => {
  it('has three tabs and opens Call data by default', async () => {
    const wrapper = await mountSuspended(AdminPage, { route: '/admin' })
    const tabs = wrapper.findAll('[role="tab"]').map((t) => t.text())
    expect(tabs).toEqual(['Call data', 'Forecast runs', 'People'])
    expect(wrapper.text()).toContain('This panel arrives with the ingest package.')
  })

  it('shows the runs panel for ?tab=runs', async () => {
    const wrapper = await mountSuspended(AdminPage, { route: '/admin?tab=runs' })
    const selected = wrapper.find('[role="tab"][aria-selected="true"]')
    expect(selected.text()).toBe('Forecast runs')
    expect(wrapper.text()).toContain('Forecast runs')
    expect(wrapper.text()).toContain('This panel arrives with the ingest package.')
    expect(wrapper.text()).not.toContain('This panel arrives with the API package.')
  })

  it('shows the people panel for ?tab=people', async () => {
    const wrapper = await mountSuspended(AdminPage, { route: '/admin?tab=people' })
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('People')
    expect(wrapper.text()).toContain('This panel arrives with the API package.')
    expect(wrapper.text()).not.toContain('ingest package')
  })
})
