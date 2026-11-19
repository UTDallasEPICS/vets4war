// @vitest-environment nuxt
//
// The sign-in page: email first, then the code field after a code was requested.
// The auth client is mocked; nothing leaves the test.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AuthPage from '../../app/pages/auth.vue'

const client = vi.hoisted(() => ({
  sendVerificationOtp: vi.fn(),
  signInEmailOtp: vi.fn(),
}))

vi.mock('../../app/utils/auth-client', () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: client.sendVerificationOtp },
    signIn: { emailOtp: client.signInEmailOtp },
  },
}))

describe('sign-in page', () => {
  beforeEach(() => {
    client.sendVerificationOtp
      .mockReset()
      .mockResolvedValue({ data: { success: true }, error: null })
    client.signInEmailOtp.mockReset()
  })

  it('asks for the email first', async () => {
    const wrapper = await mountSuspended(AuthPage)
    expect(wrapper.find('h1').text()).toBe('Sign in')
    expect(wrapper.find('input[type="email"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Send code')
    expect(wrapper.text()).not.toContain('If that address has access')
  })

  it('shows the code field and the hint after a code was requested', async () => {
    const wrapper = await mountSuspended(AuthPage)
    await wrapper.find('input[type="email"]').setValue('someone@example.org')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    await vi.waitFor(() => expect(client.sendVerificationOtp).toHaveBeenCalled())
    await flushPromises()

    expect(client.sendVerificationOtp).toHaveBeenCalledWith({
      email: 'someone@example.org',
      type: 'sign-in',
    })
    expect(wrapper.find('input[type="email"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('If that address has access, a code is on its way.')
    expect(wrapper.findAll('input[aria-label^="pin input"]').length).toBe(6)
    expect(wrapper.text()).toContain('Sign in')
  })
})
