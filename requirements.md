# Requirements

The first rows (REQ-F-01 to REQ-F-07, REQ-NF-01 to REQ-NF-07) are the baseline requirements
inherited from the EPICS Nuxt template. The rows after them are this project's: the
Vets4Warriors staffing forecast.

## 1. Requirement Matrix

Use the matrix below to track requirements throughout the project lifecycle.

- **Category:** Functional (REQ-F), Non-Functional (REQ-NF)
- **Status:** Backlog, In-progress, Verified, Deferred, Deprecated
- **Mapping:** the source that implements the requirement. No GitHub issues exist for the
  rows below; a requirement you add from now on should map to its issue.

What **Verified** means here: implemented, and covered by the automated tests of this
repository, which run on generated (synthetic) data. It does not mean checked on the real
call data or on the real hosting platform. What is still open there is listed in the README
under "Before you rely on it".

| ID        | Description                                                                                                           | Status     | Target Semester | Mapping (source / issue)                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ---------- | --------------- | --------------------------------------------------------------------------------------------------- |
| REQ-F-01  | Passwordless sign-in via email OTP (Better Auth + Nodemailer); OTP emailed to an existing user                        | Verified   | 2026F           | `server/utils/auth.ts`, `app/pages/auth.vue`                                                        |
| REQ-F-02  | Server API gateway rejects unauthenticated requests to non-public routes with HTTP 401                                | Verified   | 2026F           | `server/middleware/auth.ts`, `server/utils/access.ts`                                               |
| REQ-F-03  | Client route guard redirects signed-out users to `/auth` and signed-in users away from `/auth`                        | Verified   | 2026F           | `app/middleware/auth.global.ts`                                                                     |
| REQ-F-04  | Authenticated user can upload a profile image, stored per-user under the configured storage path                      | Deprecated | 2026F           | removed 2026-11-19 with the template's demo; `docs/adr/002_nuxt_rebuild.md`                         |
| REQ-F-05  | Profile image is served with its `Content-Type` detected from file contents (magic bytes)                             | Deprecated | 2026F           | removed 2026-11-19 with the template's demo; `docs/adr/002_nuxt_rebuild.md`                         |
| REQ-F-06  | User-list endpoint returns only non-sensitive fields and never leaks image storage paths                              | Deprecated | 2026F           | removed 2026-11-19; replaced by REQ-F-13; `docs/adr/002_nuxt_rebuild.md`                            |
| REQ-F-07  | Unauthenticated `/api/health` endpoint returns HTTP 200 for load-balancer probes                                      | Verified   | 2026F           | `server/api/health.ts`                                                                              |
| REQ-F-08  | Signed-in users get the forecast for a date range: calls and the staffing chain per hour, shifts per day, totals      | Verified   | 2026F           | `server/api/forecast.get.ts`, `server/api/staffing.get.ts`, `server/utils/forecast/`                |
| REQ-F-09  | Staffing console: people to schedule per hour and shift, settings recomputed in the browser, caps flagged             | Verified   | 2026F           | `app/pages/index.vue`, `app/components/console/`, `app/utils/console/logic.ts`                      |
| REQ-F-10  | A planned roster is judged against the recommendation: verdict, service level and hang-ups at the planned number      | Verified   | 2026F           | `server/api/planned.post.ts`, `server/utils/forecast/compute.ts`                                    |
| REQ-F-11  | The console exports a printable report, a CSV of every hour and an image of the grid                                  | Verified   | 2026F           | `app/composables/console/useConsoleExports.ts`, `app/utils/console/report.ts`                       |
| REQ-F-12  | Every user is a viewer or an admin; admin routes and the admin page are admin-only; sign-up is off                    | Verified   | 2026F           | `server/utils/access.ts`, `server/utils/auth.ts`, `server/db/admins.ts`                             |
| REQ-F-13  | Admins add, promote, demote and remove people; nobody can remove themselves and the last admin stays                  | Verified   | 2026F           | `server/utils/users.ts`, `server/api/admin/users/`, `app/components/admin/PeoplePanel.vue`          |
| REQ-F-14  | Admins upload a call-records workbook and get a plan per day (new, already loaded, different) before anything changes | Verified   | 2026F           | `server/utils/ingest/`, `server/api/admin/uploads/`, `app/components/admin/UploadsPanel.vue`        |
| REQ-F-15  | A day that differs is replaced only on explicit confirmation, and the replaced calls are kept in `replaced_calls`     | Verified   | 2026F           | `server/utils/ingest/service.ts`, `server/db/schema.ts`                                             |
| REQ-F-16  | The retrain script keeps a new model only if it beats the simple baseline in a backtest, and writes atomically        | Verified   | 2026F           | `forecast/db/retrain.py`, `forecast/db/train.py`, `forecast/db/store.py`                            |
| REQ-F-17  | A retrain starts automatically after every import; one run at a time; requests during a run queue one more            | Verified   | 2026F           | `server/utils/retrain/runner.ts`, `server/utils/ingest/index.ts`                                    |
| REQ-F-18  | A scheduled check retrains on unread call data and refreshes an old forecast; admins can start either by hand         | Verified   | 2026F           | `server/tasks/retrain/tick.ts`, `server/api/admin/runs/`, `app/components/admin/RunsPanel.vue`      |
| REQ-F-19  | A one-time script copies the call history and the holidays from the old Postgres database                             | Verified   | 2026F           | `scripts/copy-from-postgres.ts`                                                                     |
| REQ-F-20  | Pages and answers say what the data is (partner, synthetic, not set) and when the forecast is behind the call data    | Verified   | 2026F           | `server/utils/forecast/source.ts`, `server/api/status.get.ts`, `app/utils/console/status.ts`        |
| REQ-NF-01 | Persistence is type-safe: Drizzle ORM schema with generated Zod select/insert schemas                                 | Verified   | 2026F           | `server/db/schema.ts`                                                                               |
| REQ-NF-02 | CI runs lint, type-check, and the Vitest suite on every PR and on `dev`/`stage`/`prod` pushes                         | Verified   | 2026F           | `.github/workflows/test.yml`                                                                        |
| REQ-NF-03 | Deploy pipeline order is build → migrate → push → deploy, so a failed migration never ships                           | Verified   | 2026F           | `.github/workflows/deploy.yml`                                                                      |
| REQ-NF-04 | `stage`/`prod` auto-deploy to AWS ECS via GitHub OIDC, with no static AWS keys stored                                 | Verified   | 2026F           | `.github/workflows/stage.yml`, `.github/workflows/prod.yml`                                         |
| REQ-NF-05 | App ships as a container image with the toolchain to compile native modules in the builder                            | Verified   | 2026F           | `Dockerfile`                                                                                        |
| REQ-NF-06 | Test baseline runs with no `.env`, database, email, or browser (`pnpm test` works on clone)                           | Verified   | 2026F           | `vitest.config.ts`, `tests/`                                                                        |
| REQ-NF-07 | Dependency versions are pinned for reproducible, deploy-safe builds                                                   | Verified   | 2026F           | `package.json`, `forecast/requirements-runtime.txt`                                                 |
| REQ-NF-08 | One image holds the Node server and the Python environment; the SQLite file is the only state                         | Verified   | 2026F           | `Dockerfile`, `server/db/schema.ts`, `forecast/db/store.py`                                         |
| REQ-NF-09 | Three test layers run in CI: Vitest, the Python suite, and parity plus end-to-end on the production build             | Verified   | 2026F           | `.github/workflows/test.yml`, `forecast/tests/`, `tests/parity/`, `scripts/e2e.mjs`                 |
| REQ-NF-10 | The TypeScript staffing arithmetic and workbook reader give the results of the Python originals                       | Verified   | 2026F           | `tests/parity/staffing/`, `tests/parity/parser/`                                                    |
| REQ-NF-11 | No route, log line or stored run output contains a call record                                                        | Verified   | 2026F           | `server/utils/ingest/service.ts`, `forecast/db/retrain.py`, `scripts/e2e.mjs`                       |
| REQ-NF-12 | Server and retrain script share one SQLite file safely; the forecast is swapped in one transaction                    | Verified   | 2026F           | `server/utils/db.ts`, `forecast/db/store.py`, `tests/server/ingest/locking.test.ts`                 |
| REQ-NF-13 | A run that is stopped, killed or times out leaves no process behind and never changes the forecast in use             | Verified   | 2026F           | `server/utils/retrain/runner.ts`, `forecast/db/lifetime.py`, `tests/server/retrain/process.test.ts` |
| REQ-NF-14 | Request parameters are bounded so that one request cannot hold the server                                             | Verified   | 2026F           | `shared/utils/constants.ts`, `server/utils/forecast/params.ts`                                      |
| REQ-NF-15 | The environment is checked at start; a production build refuses to log sign-in codes                                  | Verified   | 2026F           | `server/utils/env.ts`, `tests/server/foundation/env.test.ts`                                        |
| REQ-NF-16 | The sign-in rate limit tells clients apart correctly behind the platform's proxy                                      | Backlog    | TBD             | `server/utils/auth.ts`, `docs/deployment.md`                                                        |

## 2. Change Log

Track major changes, additions, or deprecations to the project scope.

| Date       | Requirement ID         | Change Description                                                                                             | Author                     | Approved By |
| ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------- |
| 2026-08-23 | REQ-F/NF-\*            | Established the initial requirements register from the template baseline                                       | @TusharW4ni                | —           |
| 2026-08-23 | REQ-NF-07              | Pinned `better-auth@1.6.23` and `better-sqlite3@12.11.1` to keep the deploy build and migration Lambda working | @TusharW4ni                | —           |
| 2026-08-23 | REQ-NF-05              | Added `python3`/`make`/`g++` to the Docker builder so native modules compile                                   | @TusharW4ni                | —           |
| 2026-11-19 | REQ-F-04, 05, 06       | Deprecated: the template's demo (profile image upload and serving, user list) was removed in the Nuxt rebuild  | Nuxt rebuild (AI-assisted) | —           |
| 2026-11-19 | REQ-F-08 to REQ-F-20   | Added the project's functional requirements: forecast API, console, roles, uploads, retraining, the copy       | Nuxt rebuild (AI-assisted) | —           |
| 2026-11-19 | REQ-NF-08 to REQ-NF-15 | Added the project's non-functional requirements: one image, test layers, parity, privacy, locking, limits      | Nuxt rebuild (AI-assisted) | —           |
| 2026-11-19 | REQ-NF-02, 05, 07      | Extended by the rebuild: CI has three jobs; the image also carries Python; the Python packages are pinned too  | Nuxt rebuild (AI-assisted) | —           |
| 2026-11-19 | REQ-NF-16              | Added as Backlog: the rate limit is on, but the client address is not configured for any platform yet          | Nuxt rebuild (AI-assisted) | —           |
