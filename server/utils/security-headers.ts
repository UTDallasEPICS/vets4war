// Headers every response carries (nuxt.config.ts applies them to /** through Nitro's
// route rules, which run before any page, API route or static file):
// - HSTS: the app is only ever reached over https in a deployment (BETTER_AUTH_URL); a
//   browser ignores the header on plain http, so local work is not affected. No
//   includeSubDomains: other hosts of the domain are not ours to decide.
// - nosniff: a file is only ever taken as the type the server says it is.
// - DENY: no other site may show the app in a frame (clickjacking).
// - same-origin: no address of the app is sent to another site in Referer.
// A Content-Security-Policy is not set here yet: Nuxt's inline payload and the fonts
// need nonces or hashes, which is a decision of its own.
export const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
}
