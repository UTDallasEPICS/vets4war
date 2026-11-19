# Sign-in, roles and who may call what

The app uses [Better Auth](https://www.better-auth.com/) with its email one-time-code plugin,
as the EPICS Nuxt template does, with three additions: sign-up is switched off, every person
has a role, and the API checks that role. This guide says how it behaves, where the code is,
and what to change with care.

## What a person sees

1. They open the app and land on `/auth`.
2. They type their email address and press **Send code**. The page says "If that address has
   access, a code is on its way." whether or not the address has access.
3. A mail with the subject "Vets4Warriors staffing: your sign-in code" brings a six-digit
   code. They type it and press **Sign in**.
4. They stay signed in for 7 days; the session is renewed while it is used. **Sign out** is
   on every page.

There are no passwords and no social sign-in.

## The rules

- **Only people on the list can sign in.** Sign-up is off (`disableSignUp: true`). An address
  that nobody added gets the answer `{ "success": true }`, no mail and no account. Without
  this setting Better Auth would create an account for any address that asks for a code.
- **A person is a `viewer` or an `admin`.** The role is the column `user.role`, default
  `viewer`. It is declared with `input: false`, so a client cannot set its own role: a
  request to do so is refused with "role is not allowed to be set".
- **The first admins come from configuration.** Every address in `V4W_ADMIN_EMAILS` is
  created as an admin, or promoted to one, each time the server starts
  (`server/plugins/01.bootstrap-admins.ts`) and by `pnpm db:seed`. Nobody is ever demoted or
  removed by it, so taking an address out of the variable does not lock that person out.
- **Admins manage everyone else** on the admin page, tab **People**, or through
  `/api/admin/users` (`server/utils/users.ts`):
  - an address is stored trimmed and in lower case; adding one that exists answers 409;
  - nobody can demote or remove themselves;
  - the last admin cannot be demoted or removed ("There must be at least one admin.");
  - removing a person ends their sessions at once.
- **A code** has 6 digits, is valid for 5 minutes, and dies after 3 wrong tries.

## Who may call which API path

Every request to `/api/` passes one gate, `server/middleware/auth.ts`. The rules are a pure
function in `server/utils/access.ts`, so each of them has a unit test
(`tests/server/foundation/access.test.ts`). In order:

1. **Public prefixes.** `/api/auth/**` (Better Auth's own routes) and `/api/health` answer
   without a session. Paths outside `/api/` are pages and assets; the gate does not apply to
   them.
2. **A session.** Every other API path needs a valid session cookie. Without one: 401,
   `data.code` `unauthorized`, "Sign in to use this."
3. **The admin prefix.** A path under `/api/admin/` needs the role `admin`. Otherwise: 403,
   `forbidden`, "Only an admin can do this."
4. **The origin of writes.** A `POST`, `PUT`, `PATCH` or `DELETE` that carries an `Origin`
   header must come from the origin of `BETTER_AUTH_URL`. Otherwise: 403, `forbidden`, "This
   request came from another site and was refused." A browser always sends `Origin` on such
   requests from another site, so a page elsewhere cannot use a signed-in person's cookie to
   change anything. Requests without the header (curl, scripts) carry no such risk and pass.

The path is normalised before it is checked: percent-escapes are decoded, doubled slashes are
collapsed, and the admin prefix is matched without regard to case, so `/api/%61dmin/...` or
`/api//admin/...` cannot slip past rule 3.

Admin route files call `requireAdmin(event)` themselves as well (`server/utils/session.ts`).
That gives the handler a typed user and keeps a route protected if it is ever moved out of
`/api/admin/`. Other routes call `requireUser(event)`.

**Pages** are guarded separately, by `app/middleware/auth.global.ts`: signed-out visitors go
to `/auth`, signed-in ones away from it, and only admins reach `/admin`. That guard is for
navigation. The API never relies on it.

When you add a route:

- put it under `server/api/admin/` if only admins may call it, and call `requireAdmin` in it;
- otherwise call `requireUser`;
- do not add to the public prefixes unless the route truly must answer strangers.

## Where the code is

| File                                | What it does                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `server/utils/auth.ts`              | The Better Auth configuration: database, role field, the code plugin, mail. |
| `server/api/auth/[...all].ts`       | Hands `/api/auth/**` to Better Auth.                                        |
| `server/middleware/auth.ts`         | The gate described above; puts the user on `event.context.user`.            |
| `server/utils/access.ts`            | The gate's rules, as a pure function.                                       |
| `server/utils/session.ts`           | `requireUser`, `requireAdmin`.                                              |
| `server/db/admins.ts`               | `V4W_ADMIN_EMAILS`: parse it, create or promote the admins.                 |
| `server/utils/users.ts`             | The people routes' logic.                                                   |
| `app/utils/auth-client.ts`          | The browser's client; knows that a user has a `role`.                       |
| `app/composables/useSessionUser.ts` | `{ user, isAdmin, signOut }` for page code.                                 |
| `app/middleware/auth.global.ts`     | The page guard.                                                             |
| `app/pages/auth.vue`                | The sign-in page.                                                           |
| `server/db/schema.ts`               | The tables `user`, `session`, `account`, `verification`.                    |

In server code:

```ts
import { defineEventHandler } from 'h3'
import { requireUser } from '../utils/session'

export default defineEventHandler((event) => {
  const user = requireUser(event) // 401 when nobody is signed in
  // user.id, user.email, user.name, user.role ('viewer' | 'admin')
  return { hello: user.name }
})
```

`requireAdmin(event)` works the same way and answers 403 to a viewer.

In page code:

```ts
const { user, isAdmin, signOut } = await useSessionUser()
```

## Mail, and signing in without it

How a code reaches a person is set by `EMAIL_TRANSPORT`.

- `smtp` (the default) sends it through the mail server named by `EMAIL_HOST`,
  `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASS`, from the address `EMAIL_FROM`.
  Any SMTP service works. Only a local test mail server has been used so far; real delivery
  is on the list in the README under "Before you rely on it". A mail that cannot be sent
  does not change the answer: the page says that a code is on its way even when the mail
  server cannot be reached. If no mail arrives, read the server log: a failed delivery is
  there as `[Better Auth]: Failed to run background task: ...`, followed by the reason.
- `console` prints the code in the server log instead:

  ```
  [auth] sign-in code for admin@example.org: 301190
  ```

  It is for local work and is accepted by `pnpm dev` only. A production build refuses to
  start with it, so a deployed server can never leak codes into its log.

Scripts and tests on a development server can sign in without reading a mail or a log:

```bash
node scripts/lib/dev-signin.mjs http://localhost:3000 dev.db admin@example.org
```

prints the value for a `Cookie` header. It asks for a code and reads it from the
`verification` table of the database file you name, which works because Better Auth stores
codes there as plain text. Two things follow from that:

- the helper needs read access to the server's database file, so it is a development tool;
- **anyone who can read the database file can sign in as anyone.** The file holds the codes
  of the last five minutes and the tokens of all open sessions. Protect it, and its
  backups, like a password file.

## The rate limit

Better Auth limits how often one client may ask for a code and how often it may try one: 3
requests per 60 seconds for each of the two, per client address. Put exactly: a request is
refused (HTTP 429, "Too many requests. Please try again later.") when the three before it
each came less than 60 seconds after the one before; 60 seconds without an accepted request
start the count again.

- It is on in every production build and off under `pnpm dev`
  (`rateLimit` in `server/utils/auth.ts`).
- It tells clients apart by the `X-Forwarded-For` header, and trusts that header only when
  it holds exactly one address. Everyone whose address cannot be read that way shares one
  allowance.
- There is no separate limit per email address.

Whether this protects the app depends on the proxy in front of it. Behind the wrong
arrangement all visitors share one allowance, or a client can dodge the limit altogether.
**Read [deployment.md](deployment.md#the-sign-in-rate-limit-and-the-client-address) before
going live**: it has the four cases, what to configure in `server/utils/auth.ts`
(`advanced.ipAddress`), and how to check the result.

## Changing things

- **The session length** is Better Auth's default (7 days, renewed after a day of use). To
  change it, add `session: { expiresIn: <seconds> }` to the configuration.
- **The code's length, lifetime and number of tries** are options of the `emailOTP` plugin
  (`otpLength`, `expiresIn`, `allowedAttempts`).
- **`BETTER_AUTH_URL`** must be the address in the browser's address bar. From any other
  address a person can still sign in and read, but the gate's rule 4 refuses every change,
  and Better Auth refuses to sign them out ("Invalid origin"). Locally that means
  `http://localhost:<port>`, not `http://127.0.0.1:<port>`.
- **`BETTER_AUTH_SECRET`** signs the session cookies. Changing it signs everyone out.
- **Do not switch sign-up back on** without thinking about who may then see the forecast:
  with it, anyone who can receive mail could make themselves a viewer.

Better Auth's own documentation: <https://www.better-auth.com/docs>.
