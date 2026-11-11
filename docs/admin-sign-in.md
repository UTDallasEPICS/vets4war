# Sign-in: shared password and Auth0, side by side

Two different doors, on purpose.

| What | Who gets in | Checked by |
|---|---|---|
| Staffing page (`/`, `index.html`, its scripts) and its API (`/api/forecast`, `/api/staffing`, `/api/planned`, `/api/model`) | Anyone with the shared password | `api/site_auth.py` (session cookie) |
| Admin page (`/admin.html`, `/admin.js`, `/vendor/auth0-spa-js.production.js`) | Anyone can load the page; it shows nothing until sign-in | nothing (no private content in these files) |
| Admin API (`/api/admin/*`, except `/api/admin/config`) | Auth0 users holding the right permission | `api/auth.py` (Auth0 access token), route by route in `api/admin.py` |
| `/api/admin/config` | Anyone | nothing: it returns the three public Auth0 settings the page needs to start sign-in |

The shared-password session never grants admin access, and an Auth0 token
never opens the staffing page. Switching the password gate off for local work
(`V4W_AUTH_DISABLED=1`) does not switch Auth0 off.

## Permissions

Set on the Auth0 API, delivered inside the access token (`permissions` claim).

| Permission | Allows |
|---|---|
| `read:admin` | who-am-I, validate a file, upload history |
| `read:admin` + `import:calls` | stage an upload, import it into `calls` |
| `trigger:retraining` | reserved; nothing uses it yet |

## Settings

| Name | What it is |
|---|---|
| `AUTH0_DOMAIN` | tenant hostname, no `https://`, no slash |
| `AUTH0_AUDIENCE` | identifier of the Auth0 API |
| `AUTH0_CLIENT_ID` | client id of the Auth0 single-page application |

None is a secret. If any is missing: `/api/admin/config` and every admin route
answer 503 and the admin page says sign-in is not configured. The staffing
page is unaffected.

## What the Auth0 tenant needs

1. Single-page application: Allowed Callback URLs, Allowed Logout URLs and
   Allowed Web Origins containing the address the admin page is served from,
   e.g. `https://v4w-staffing.vercel.app/admin.html` (origin only for Web
   Origins) and `http://localhost:8001/admin.html` for local work.
2. API with the audience above: RS256, **Enable RBAC**, **Add Permissions in
   the Access Token**, and the three permissions listed above.
3. A role holding `read:admin` and `import:calls`, assigned to each admin.
4. Public sign-ups switched off, so only invited people have accounts.

## Details worth knowing

- Only paths that mean exactly what they say skip the session check. A path
  such as `/api/admin/../../index.html` is treated as a staffing path and
  needs the password (`needs_session` in `api/site_auth.py`).
- Only `/admin.html` gets a security header that allows connections and a
  hidden frame to the Auth0 tenant. Every other page allows this site only.
- The Auth0 token lives in the page's memory, never in browser storage. In
  browsers that block third-party cookies (Safari), an admin may have to sign
  in again after a reload.

## The Auth0 library in `web/vendor/`

`web/vendor/auth0-spa-js.production.js` is Auth0's own browser library, served
from this site so that no outside script source has to be allowed.

| | |
|---|---|
| Library | Auth0 SPA SDK (`@auth0/auth0-spa-js`), MIT licence |
| Version | 2.29 |
| Copied from | `https://cdn.auth0.com/js/auth0-spa-js/2.29/auth0-spa-js.production.js` on 2026-11-11 |
| Size | 234,840 bytes |
| SHA-256 | `6973ffd2bab5e13bfea9ba18786c7ca34d0f484436976c7b6befb8724b2cbfe7` |

`tests/test_admin_gate.py` fails if the file's hash changes. To update it:
download the new version from Auth0's CDN, replace the file, and update the
version, date, size and hash here and the hash in that test.
