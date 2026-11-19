// @vitest-environment nuxt
//
// The People tab: the list as the server gave it, the signed-in admin's own row marked
// and locked, and the address cell laid out so that the note under it can be read on a
// phone. apiFetch and useSessionUser are mocked: no server, no database.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { computed } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import type { PersonRow } from '#shared/types/api'
import PeoplePanel from '../../app/components/admin/PeoplePanel.vue'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))

enableAutoUnmount(afterEach)

mockNuxtImport('apiFetch', () => {
  return (url: string, options?: unknown) => mocks.apiFetch(url, options)
})
mockNuxtImport('useSessionUser', () => {
  return async () => ({
    user: computed(() => ({ id: 'me', email: 'admin@example.org', name: 'admin', role: 'admin' })),
    isAdmin: computed(() => true),
    signOut: () => Promise.resolve(),
  })
})

const person = (values: Partial<PersonRow>): PersonRow => ({
  id: 'x',
  email: 'x@example.org',
  name: 'x',
  role: 'viewer',
  email_verified: false,
  created_at: '2026-11-19T10:00:00.000Z',
  ...values,
})

const PEOPLE: PersonRow[] = [
  person({ id: 'me', email: 'admin@example.org', role: 'admin', email_verified: true }),
  person({ id: 'v1', email: 'viewer.with.a.long.address@example.org', name: 'Viewer' }),
]

const NOTE = 'This is you: you cannot remove yourself or your own admin access.'

async function mountPanel() {
  mocks.apiFetch.mockReset()
  mocks.apiFetch.mockResolvedValue({ users: PEOPLE })
  const wrapper = await mountSuspended(PeoplePanel)
  await flushPromises()
  return wrapper
}

describe('people panel', () => {
  it('lists everyone and marks the signed-in admin, whose row cannot be changed', async () => {
    const wrapper = await mountPanel()
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/admin/users', undefined)
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(2)

    const [mine, theirs] = rows as [(typeof rows)[number], (typeof rows)[number]]
    expect(mine.text()).toContain('admin@example.org')
    expect(mine.text()).toContain(NOTE)
    expect(mine.get('button[aria-label="Remove admin@example.org"]').attributes('disabled')).toBe(
      ''
    )
    expect(mine.get('[aria-label="Role of admin@example.org"]').attributes('disabled')).toBe('')

    expect(theirs.text()).not.toContain(NOTE)
    const remove = theirs.get('button[aria-label="Remove viewer.with.a.long.address@example.org"]')
    expect(remove.attributes('disabled')).toBeUndefined()
    expect(theirs.text()).toContain('Not yet')
    expect(theirs.text()).toContain('2026-11-19')
  })

  // The table's own cells never wrap. On a 360 px screen the note (about 380 px on one
  // line) therefore ran out of the table's scrolling box and was cut off. The address
  // cell wraps below the `sm` breakpoint and keeps its one-line layout above it; the
  // widths themselves were measured in a browser at 360, 390 and 1280 px.
  it('lets the address and the note under it wrap on a phone, not on a wide screen', async () => {
    const wrapper = await mountPanel()
    const cells = wrapper.findAll('[data-testid="person-email"]')
    expect(cells).toHaveLength(2)
    for (const cell of cells) {
      const classes = cell.classes()
      expect(classes).toEqual(
        expect.arrayContaining(['whitespace-normal', 'break-words', 'min-w-48', 'max-w-64'])
      )
      expect(classes).toEqual(expect.arrayContaining(['sm:whitespace-nowrap', 'sm:max-w-none']))
    }
    expect(cells[0]!.text()).toContain(NOTE)
  })
})
