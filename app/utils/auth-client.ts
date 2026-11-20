import { createAuthClient } from 'better-auth/vue'
import { emailOTPClient, inferAdditionalFields } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [
    emailOTPClient(),
    // Types session.user.role without importing server code; the server sets it.
    inferAdditionalFields({ user: { role: { type: 'string', input: false } } }),
  ],
})
