// Sign in WITHOUT mail on a development server: asks for a code, reads it from the
// verification table of the SQLite file the server uses, signs in, returns the cookie.
//
//   import { devSignIn } from './scripts/lib/dev-signin.mjs'
//   const { cookie } = await devSignIn({ baseUrl, dbPath, email })   // "better-auth.session_token=...; ..."
//
// CLI: node scripts/lib/dev-signin.mjs <baseUrl> <dbPath> <email>   prints the Cookie header value
//
// It works because Better Auth stores sign-in codes in plain text ('<otp>:<attempts>').
// For development and tests only: it needs read access to the server's database file.
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

async function postJson(baseUrl, path, body) {
  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    // Better Auth checks Origin on its own endpoints; the browser would send it.
    headers: { 'content-type': 'application/json', origin: new URL(baseUrl).origin },
    body: JSON.stringify(body),
  })
}

function readCode(dbPath, email) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 15000 })
  try {
    return db
      .prepare(
        'SELECT value FROM verification WHERE identifier = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1'
      )
      .get(`sign-in-otp-${email}`)
  } finally {
    db.close()
  }
}

export async function devSignIn({ baseUrl, dbPath, email }) {
  const address = email.trim().toLowerCase()

  const sent = await postJson(baseUrl, '/api/auth/email-otp/send-verification-otp', {
    email: address,
    type: 'sign-in',
  })
  if (!sent.ok) {
    throw new Error(`asking for a code failed: HTTP ${sent.status} ${await sent.text()}`)
  }

  const row = readCode(dbPath, address)
  if (!row) {
    throw new Error(
      `no sign-in code was stored for ${address}: the address has no account (sign-up is ` +
        `off; an admin must add it), or ${dbPath} is not the database of ${baseUrl}`
    )
  }
  const otp = String(row.value).split(':')[0]

  const signedIn = await postJson(baseUrl, '/api/auth/sign-in/email-otp', { email: address, otp })
  if (!signedIn.ok) {
    throw new Error(`signing in failed: HTTP ${signedIn.status} ${await signedIn.text()}`)
  }
  const cookie = signedIn.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ')
  if (!cookie.includes('better-auth.session_token=')) {
    throw new Error('signing in answered without a session cookie')
  }
  return { cookie }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baseUrl, dbPath, email] = process.argv.slice(2)
  if (!baseUrl || !dbPath || !email) {
    console.error('usage: node scripts/lib/dev-signin.mjs <baseUrl> <dbPath> <email>')
    process.exit(2)
  }
  try {
    const { cookie } = await devSignIn({ baseUrl, dbPath, email })
    console.log(cookie)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
