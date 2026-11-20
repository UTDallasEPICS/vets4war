// The mail that carries a sign-in code (Better Auth's emailOTP sendVerificationOTP).
import type { SendMailOptions } from 'nodemailer'

export const SIGN_IN_SUBJECT = 'Vets4Warriors staffing: your sign-in code'

export interface SignInMailer {
  sendMail(mail: SendMailOptions): Promise<unknown>
}

export interface SignInCode {
  email: string
  otp: string
  // What the code is for. People here only ever sign in; the other kinds (verify an
  // email, reset a password) are never mailed.
  type: string
}

// Error name and SMTP code only: a mail error can quote the address.
function mailErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown }
  const details = [code, responseCode].filter((v) => typeof v === 'string' || typeof v === 'number')
  return details.length ? `${error.name} (${details.join(' ')})` : error.name
}

// The request for a code does not wait for the mail. Better Auth answers an address
// without an account at once, so waiting for the SMTP server here would let anyone tell,
// by the time the answer takes, which addresses have access. A failed send is logged.
// Without a transporter (EMAIL_TRANSPORT=console, `nuxt dev` only) the code goes to the
// server log instead. A code of another kind is never sent: the mail says "your sign-in
// code", and Better Auth also makes codes for email verification and password resets.
export function createSignInMailer(transporter: SignInMailer | null, from: string) {
  return async function sendSignInCode({ email, otp, type }: SignInCode): Promise<void> {
    if (type !== 'sign-in') return
    if (!transporter) {
      console.log(`[auth] sign-in code for ${email}: ${otp}`)
      return
    }
    const text = `Your sign-in code is ${otp}. It works for 5 minutes.`
    void Promise.resolve()
      .then(() =>
        transporter.sendMail({ from, to: email, subject: SIGN_IN_SUBJECT, text, html: text })
      )
      .catch((error: unknown) => {
        console.error(`[auth] a sign-in code mail could not be sent: ${mailErrorType(error)}`)
      })
  }
}
