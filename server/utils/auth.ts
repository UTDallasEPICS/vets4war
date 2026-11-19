import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP } from 'better-auth/plugins/email-otp'
import nodemailer from 'nodemailer'
import { db } from './db'
import { env } from './env'

const SUBJECT = 'Vets4Warriors staffing: your sign-in code'

// Built only when mail is really sent: under EMAIL_TRANSPORT=console (nuxt dev only,
// enforced in env.ts) the code goes to the server log instead.
const transporter =
  env.EMAIL_TRANSPORT === 'smtp'
    ? nodemailer.createTransport({
        host: env.EMAIL_HOST,
        port: env.EMAIL_PORT,
        secure: env.EMAIL_SECURE,
        auth: {
          user: env.EMAIL_USER,
          pass: env.EMAIL_PASS,
        },
      })
    : null

async function sendVerificationOTP({ email, otp }: { email: string; otp: string }) {
  if (!transporter) {
    console.log(`[auth] sign-in code for ${email}: ${otp}`)
    return
  }
  const text = `Your sign-in code is ${otp}. It works for 5 minutes.`
  await transporter.sendMail({
    from: env.EMAIL_FROM,
    to: email,
    subject: SUBJECT,
    text,
    html: text,
  })
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'sqlite',
  }),
  user: {
    additionalFields: {
      // Set by admins (people API) and V4W_ADMIN_EMAILS only: input: false keeps a
      // client from choosing its own role.
      role: { type: 'string', required: false, defaultValue: 'viewer', input: false },
    },
  },
  plugins: [
    emailOTP({
      // Only people an admin added can sign in: an unknown address gets no code, no
      // error and no account.
      disableSignUp: true,
      sendVerificationOTP,
    }),
  ],
})
