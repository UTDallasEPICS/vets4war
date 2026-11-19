// @vitest-environment nuxt
//
// The admin page: three tabs, the tab comes from ?tab=, and exactly one panel shows.
// The panels are replaced by markers: this file checks the page's side of the contract
// (which panel is on screen for which tab), not what a panel renders. Each panel has
// its own tests where it is built.
// Navigating to /admin runs the global route guard, so the auth client answers with
// an admin session here instead of asking the server.

import { describe, it, expect, vi } from 'vitest'
import { h, ref } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AdminPage from '../../app/pages/admin.vue'

vi.mock('../../app/utils/auth-client', () => ({
  authClient: {
    useSession: async () => ({
      data: ref({ user: { id: 'u1', email: 'admin@example.org', name: 'admin', role: 'admin' } }),
    }),
  },
}))

const marker = (panel: string) => ({ render: () => h('div', { 'data-panel': panel }) })
// An auto-imported component is matched by its file name, a registered one by its tag.
const stubs = {
  UploadsPanel: marker('uploads'),
  AdminUploadsPanel: marker('uploads'),
  RunsPanel: marker('runs'),
  AdminRunsPanel: marker('runs'),
  PeoplePanel: marker('people'),
  AdminPeoplePanel: marker('people'),
}

function panelsOnScreen(wrapper: VueWrapper) {
  return wrapper.findAll('[data-panel]').map((panel) => panel.attributes('data-panel'))
}

describe('admin page', () => {
  it('has three tabs and opens Call data by default', async () => {
    const wrapper = await mountSuspended(AdminPage, { route: '/admin', global: { stubs } })
    const tabs = wrapper.findAll('[role="tab"]').map((t) => t.text())
    expect(tabs).toEqual(['Call data', 'Forecast runs', 'People'])
    expect(panelsOnScreen(wrapper)).toEqual(['uploads'])
  })

  it('shows the runs panel for ?tab=runs', async () => {
    const wrapper = await mountSuspended(AdminPage, { route: '/admin?tab=runs', global: { stubs } })
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('Forecast runs')
    expect(panelsOnScreen(wrapper)).toEqual(['runs'])
  })

  it('shows the people panel for ?tab=people', async () => {
    const wrapper = await mountSuspended(AdminPage, {
      route: '/admin?tab=people',
      global: { stubs },
    })
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('People')
    expect(panelsOnScreen(wrapper)).toEqual(['people'])
  })

  it('falls back to Call data for an unknown tab', async () => {
    const wrapper = await mountSuspended(AdminPage, { route: '/admin?tab=nope', global: { stubs } })
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('Call data')
    expect(panelsOnScreen(wrapper)).toEqual(['uploads'])
  })
})
