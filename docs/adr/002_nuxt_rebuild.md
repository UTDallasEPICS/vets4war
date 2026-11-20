# ADR 002: One Nuxt app for the staffing forecast, with Python as a batch script

- **Status:** Proposed (already built on the rebuild branch; it becomes Accepted when the
  team merges that branch)
- **Deciders:** to be filled in by the team that takes the project over. Nobody outside the
  rebuild has reviewed or approved this record yet.
- **Date:** 2026-11-19

---

## 1. Context & Problem Statement

This repository started from the EPICS Nuxt template. The forecasting work then replaced the
template with a Python application (the branch `final-main`): a FastAPI service that read
the call log from a shared Postgres database, served one static page, sat behind a single
shared password, and was hosted outside the EPICS platform. It produced a model that was
validated on the real call data.

That left four problems:

- EPICS projects are expected to be built on the template and deployed through its pipeline:
  one container image, SQLite, Better Auth. The Python app fitted none of it.
- New call data was loaded by a developer from a laptop, and the model was retrained by
  hand and committed as files. The people who own the data could not do either.
- Everybody shared one password. There was no way to say who may load data.
- The app, its database and its hosting were three separate things to keep alive.

**How the rebuild was done.** It was carried out in November 2026 in a sandbox, on synthetic
data only, with the old app running next to the new one as the reference. The work was cut
into a foundation (the template, the schema, sign-in and roles, the shared arithmetic) and
four parts built in parallel against written contracts: the Python pipeline on SQLite, the
read API and the people page, uploads with the retrain runner, and the staffing console. Two
independent reviews, each followed by a round of fixes, came before an integration step that
added the image, CI, an end-to-end script and the documentation.

**How it was shown to be right.** By comparison, not by inspection. The same synthetic calls
had to give the same model fingerprint in the old and in the new pipeline; the new API had
to reproduce 44 recorded answers of the old one; the new page had to show the same numbers
as the old page and export identical files. All of that held, on synthetic data. None of it
has been repeated on the real data, which the sandbox never saw. The README section "Before
you rely on it" lists what follows from that.

---

## 2. Decision Drivers (Goals & Constraints)

- **Goal 1:** Follow the EPICS template: its tools, its pipeline, one deployable image.
- **Goal 2:** Do not change the model or its numbers. The model had been validated on real
  data, and a rebuild must not quietly become a different forecast.
- **Goal 3:** Let admins load call data and retrain without a developer, safely: nothing is
  changed until a person has seen what a file would do.
- **Goal 4:** Per-person sign-in with roles.
- **Constraint:** The model is Python (LightGBM, pandas). The template is Node.
- **Constraint:** No real data was available during the rebuild, so everything had to be
  provable on synthetic data, with checks the team can run on the real data later.
- **Constraint:** The database file may end up on network storage.

---

## 3. Options Considered

These are the alternatives this decision rules out.

### Option 1: Keep the Python service and add what is missing

Add uploads and per-person sign-in to the FastAPI app and keep Postgres.

- **Pros:**
  - No rewrite of the API or the page.
  - The model code stays exactly where it is.
- **Cons:**
  - Does not meet the template requirement, so it cannot use the EPICS pipeline.
  - Sign-in, roles and an admin area would be built by hand instead of taken from the
    template.
  - An earlier attempt at an admin upload on that stack depended on an outside sign-in
    service and on GitHub Actions to retrain. Its safety rules for uploads were good and
    were kept; its moving parts were not.

### Option 2: A Nuxt front end next to the Python API

Nuxt for pages and sign-in, the FastAPI service for forecasts, both running.

- **Pros:**
  - The API is reused as it is.
- **Cons:**
  - Two services to deploy and keep in step, where the pipeline deploys one image.
  - Two data stores, or a Python web service on SQLite next to Node.
  - Every request for a forecast crosses a process boundary and needs its own
    authentication.

### Option 3: One Nuxt app; Python only as a batch script

Node does everything at request time. Python runs only to retrain, started by Node, and
writes its result into the same SQLite file.

- **Pros:**
  - One image, one process to serve, one file of state.
  - The template's sign-in, schema tooling, tests and pipeline are used as they are.
  - The model code is kept; only how it reads and writes data changes.
- **Cons:**
  - The staffing arithmetic and the workbook reader exist in two languages.
  - Node and Python share a SQLite file and must follow locking rules.
  - The image carries a Python environment and is large.

### Option 4: Rewrite the model in TypeScript as well

- **Pros:**
  - One language.
- **Cons:**
  - There is no way to show that a reimplemented training pipeline gives the validated
    model. It would be a new model with no track record.

---

## 4. Decision & Justification

**Chosen Option:** Option 3: one Nuxt app, Python as a batch script, one SQLite file.

The decision in eleven points:

1. Template conventions everywhere: pnpm, Prettier, ESLint, Vitest, `server/db/schema.ts`
   with generated migrations, the EPICS workflows with their migration bundle, `docs/`,
   `wpr/`, `requirements.md`.
2. Sign-in is the template's Better Auth email code. A `role` on each user (`viewer` or
   `admin`) gates uploads, retrains and the people list. Sign-up is off.
3. The upload flow lives in the app: upload a workbook, see the plan for each day, confirm,
   import, retrain automatically, watch the outcome on the page.
4. Node does all request-time work: the API, the Erlang and staffing arithmetic, reading
   workbooks, importing. Python is batch only and never listens on a port.
5. Every table is defined in `server/db/schema.ts`. Python never creates or alters one.
6. Python writes a forecast straight into SQLite in one transaction, and Node reads what one
   answer needs in one read transaction. There is one atomic switch and no second step that
   could leave half a forecast.
7. The staffing console keeps the old page's look and behaviour, rebuilt as Vue components
   with the same structure, so that old and new could be compared element by element.
8. The four forecast routes keep the old API's answers. Errors use one shape of their own.
9. Only synthetic data was used, labelled as such, and no accuracy number measured on
   synthetic data appears in the documentation.
10. One Docker image holds the Node server and a Python 3.12 environment, for the arm64
    machines the pipeline deploys to. The only persistent state is the SQLite file; the
    trained model is a row in it, not a file in the image.
11. The Python code keeps its package and its layout, moved under `forecast/`. Its pure
    modules are unchanged; only data access (Postgres to SQLite) and the web layer went.

### Rationale

Option 3 is the only one that meets Goal 1 and Goal 2 together: it takes the template whole
and leaves the model's code alone. Goal 3 and Goal 4 come almost for free with the template
(Better Auth, a place for an admin page). The price is the Cons listed under Option 3, and
each has an answer that can be checked: the two implementations of the same arithmetic are
held together by tests that run both on the same inputs (`pnpm test:parity`); the locking
rules are few, written down in [architecture.md](../architecture.md#sharing-one-sqlite-file)
and tested; the size of the image costs build time, not correctness.

Point 6 deserves its reason. The alternative was for Python to write files and for Node to
load them. That adds a second step that can fail on its own and a moment at which the files
and the database disagree. With one transaction, a reader sees the old forecast or the new
one. The network-storage constraint is why the database stays in SQLite's rollback-journal
mode and never uses WAL.

---

## 5. Consequences & Next Steps

### Positive Consequences

- One thing to deploy, and a new container with the same database file serves the same
  forecast.
- An admin can load a file, see what it would change, import it and get a retrained
  forecast without a developer.
- Each person has their own sign-in and a role.
- The numbers of the old app were reproduced on synthetic data, and the comparison tools
  remain in the repository.

### Negative Consequences / Trade-offs

- Two languages stay, and so does the duty to run the parity tests when either side of the
  shared arithmetic or the workbook reader changes.
- One SQLite file means one server instance and one writer at a time. The server's waits for
  the lock are on its only thread.
- All arithmetic for a request runs on Node's one thread. That is why the API accepts its
  parameters only within bounds, and why a year-long request is real work for the server.
- A retrain runs inside the web container and needs memory and CPU there.
- The image is large (about 870 MB for amd64) because it carries Python. Its arm64 build
  has not been completed outside the pipeline yet
  ([deployment.md](../deployment.md#the-image)).
- Sign-in now depends on mail delivery, and its rate limit depends on how the platform's
  proxy reports the client address.
- A session lasts 7 days where the old shared password lasted 12 hours. That was accepted
  together with per-person sign-in.
- The time of the scheduled check is fixed when the app is built.
- The workbook reader uses internal steps of a pinned library and must be re-checked before
  that library is upgraded.
- What the old app had and this one does not: the Postgres database as the app's store, the
  shared password, the previous hosting. What the template had and this app does not: its
  demo of profile images and its user list.

### Action Items

- Work through "Before you rely on it" in the README: the real data, real mail, the
  platform's storage, proxy and request-size limit.
- Configure the client address for the sign-in rate limit and run its checks
  ([deployment.md](../deployment.md#the-sign-in-rate-limit-and-the-client-address)).
- Run `--verify-reference` once the real history is loaded.
- Decide the size of the task after watching a first retrain on the platform.
- Fill in the deciders above, and set the status once the team has accepted this record.
