// The sign-in code mail: the request for a code never waits for the mail server (so an
// address with access answers as fast as one without), and a failed send is logged by
// type, never silently dropped and never with the address or the code.
import type { SendMailOptions } from 'nodemailer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGN_IN_SUBJECT, createSignInMailer } from '../../../server/utils/sign-in-mail'

const FROM = 'Vets4Warriors staffing <no-reply@example.org>'
const CODE = { email: 'admin@example.org', otp: '123456' }

// A transport whose send stays pending until the test settles it.
function slowTransport() {
  const sent: SendMailOptions[] = []
  let settle!: { resolve: () => void; reject: (error: Error) => void }
  const transport = {
    sendMail(mail: SendMailOptions) {
      sent.push(mail)
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
  }
  return { transport, sent, settle: () => settle }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sign-in code mail', () => {
  it('returns before the mail server has answered', async () => {
    const { transport, sent, settle } = slowTransport()
    const send = createSignInMailer(transport, FROM)
    let returned = false
    void send(CODE).then(() => (returned = true))
    await flush()
    expect(returned).toBe(true)
    expect(sent).toEqual([
      {
        from: FROM,
        to: CODE.email,
        subject: SIGN_IN_SUBJECT,
        text: 'Your sign-in code is 123456. It works for 5 minutes.',
        html: 'Your sign-in code is 123456. It works for 5 minutes.',
      },
    ])
    settle().resolve()
  })

  it('logs a failed send by its type, without the address or the code', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { transport, settle } = slowTransport()
    await createSignInMailer(transport, FROM)(CODE)
    const error = Object.assign(new Error(`Invalid login for ${CODE.email}`), {
      code: 'EAUTH',
      responseCode: 535,
    })
    settle().reject(error)
    await flush()
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]![0])
    expect(line).toBe('[auth] a sign-in code mail could not be sent: Error (EAUTH 535)')
    expect(line).not.toContain(CODE.email)
    expect(line).not.toContain(CODE.otp)
  })

  it('logs a transport that throws at once', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const transport = {
      sendMail(): Promise<unknown> {
        throw new TypeError('bad transport')
      },
    }
    await expect(createSignInMailer(transport, FROM)(CODE)).resolves.toBeUndefined()
    await flush()
    expect(logged).toHaveBeenCalledWith('[auth] a sign-in code mail could not be sent: TypeError')
  })

  it('writes the code to the server log without a transport (nuxt dev)', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    await createSignInMailer(null, FROM)(CODE)
    expect(logged).toHaveBeenCalledWith('[auth] sign-in code for admin@example.org: 123456')
  })
})
