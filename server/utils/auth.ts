import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP } from 'better-auth/plugins/email-otp'
import nodemailer from 'nodemailer'
import { db } from './db'
import { env } from './env'
import { createSignInMailer } from './sign-in-mail'

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

const sendVerificationOTP = createSignInMailer(transporter, env.EMAIL_FROM)

// Better Auth limits how often one client may ask for or try a sign-in code (3 a minute
// on those routes). That limit is what keeps someone who knows an address from guessing
// its codes, so it must not hang on how the server was started: left to its default,
// Better Auth switches it on only when the PROCESS runs with NODE_ENV=production, which
// a production build started with plain `node .output/server/index.mjs` does not have.
// So it is switched on here, for every build; only `nuxt dev` runs without it.
const RATE_LIMIT_ENABLED = import.meta.dev !== true

// People here only ask for a code, sign in with it, read their session and sign out
// (/email-otp/send-verification-otp, /sign-in/email-otp, /get-session, /sign-out).
// Every other endpoint Better Auth and its email-OTP plugin serve answers 404, so
// nobody can set a password, change an address, verify an email or manage sessions
// through them. The two with a path parameter (/reset-password/:token, /callback/:id)
// cannot be listed here; without passwords or social providers they do nothing.
export const DISABLED_AUTH_PATHS = [
  '/account-info',
  '/change-email',
  '/change-password',
  '/delete-user',
  '/delete-user/callback',
  '/email-otp/change-email',
  '/email-otp/check-verification-otp',
  '/email-otp/request-email-change',
  '/email-otp/request-password-reset',
  '/email-otp/reset-password',
  '/email-otp/verify-email',
  '/forget-password/email-otp',
  '/get-access-token',
  '/link-social',
  '/list-accounts',
  '/list-sessions',
  '/refresh-token',
  '/request-password-reset',
  '/reset-password',
  '/revoke-other-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/send-verification-email',
  '/sign-in/email',
  '/sign-in/social',
  '/sign-up/email',
  '/unlink-account',
  '/update-session',
  '/update-user',
  '/verify-email',
  '/verify-password',
]

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  rateLimit: { enabled: RATE_LIMIT_ENABLED },
  disabledPaths: DISABLED_AUTH_PATHS,
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
