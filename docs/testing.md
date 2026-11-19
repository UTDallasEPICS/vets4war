# Testing guide

How to run, read, write and review the automated tests of this repository. The first half
assumes no testing experience; if a word is unfamiliar, see
[Words you will see](#words-you-will-see). The second half describes each layer of tests
and what none of them can prove.

Every test runs on **generated (synthetic) data**. There is no real call data in this
repository, in the tests or in CI, and a number a test prints says nothing about the real
line.

## The layers at a glance

| What is tested                                          | Tool                     | Where                          | Command                |
| ------------------------------------------------------- | ------------------------ | ------------------------------ | ---------------------- |
| Shared arithmetic, console logic, the server's services | Vitest, project `unit`   | `tests/unit/`, `tests/server/` | `pnpm test`            |
| Pages and components                                    | Vitest, project `nuxt`   | `tests/nuxt/`                  | `pnpm test`            |
| The Python pipeline                                     | pytest                   | `forecast/tests/`              | `pnpm forecast:test`   |
| TypeScript against Python                               | Vitest, project `parity` | `tests/parity/`                | `pnpm test:parity`     |
| The whole app, from an empty database to a forecast     | `scripts/e2e.mjs`        | (a script, not a test folder)  | `pnpm e2e`             |
| Types of the tests and scripts                          | `vue-tsc`                | `tests/tsconfig.*.json`        | `pnpm typecheck:tests` |

`pnpm test` needs nothing but `pnpm install`: no `.env` file, no database file, no mail, no
browser, no Python. The other three need the Python environment (`pnpm forecast:setup`).

## Words you will see

- **Repository root:** the top folder of the project, the one with `package.json`. Every
  command in this guide is run from there.
- **Automated test:** code that checks other code, so that nobody has to re-check by hand.
- **Test file:** a file of tests. Here they end in `.test.ts` (TypeScript) or start with
  `test_` (Python).
- **Test case:** one check, written with `it(...)`.
- **Suite:** a group of related cases, written with `describe(...)`.
- **Assertion:** the line that states what must be true, like `expect(x).toBe(3)`. If it is
  not true, the test fails.
- **Expected and received:** what you required, and what the code really produced. A
  failure prints both.
- **Mock, stub, test double:** a stand-in for a real thing (the mail server, the browser's
  session, the retrain script), so that a test stays small and fast.
- **Exit code:** the number a command returns when it ends. 0 means success. CI reads it.
- **CI:** the checks GitHub runs on every pull request.

## First green run

You need Node.js 22 and pnpm 10.

```bash
pnpm install
pnpm test
```

`pnpm test` runs every test of the `unit` and `nuxt` projects once and exits. A good run
ends like this:

```
 Test Files  43 passed (43)
      Tests  619 passed (619)
```

The counts grow as tests are added, and a few tests skip themselves when the Python
environment is missing. What matters: it says _passed_, nothing says _failed_, and
`echo $?` right after prints `0`.

## Everyday commands

| Command                                                            | What it does                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| `pnpm test`                                                        | All unit and component tests, once.                  |
| `pnpm test:watch`                                                  | The same, re-run on every save. Ctrl+C stops it.     |
| `pnpm exec vitest run tests/unit/shared/format.test.ts`            | One file.                                            |
| `pnpm exec vitest run --project unit -t "rounds a half minute up"` | One test, by the text of its `it(...)`.              |
| `pnpm exec vitest run --project unit tests/server/retrain`         | One folder.                                          |
| `pnpm forecast:test`                                               | The whole Python suite.                              |
| `cd forecast && .venv/bin/python -m pytest tests/test_store.py -q` | One Python file.                                     |
| `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:tests`              | The checks that are not tests but that CI also runs. |

## Reading a test

[`tests/unit/shared/format.test.ts`](../tests/unit/shared/format.test.ts) is a good first
one. It checks the function that turns seconds into text like `42h 18m`:

```ts
import { describe, it, expect } from 'vitest' // the toolkit
import { formatDuration } from '#shared/utils/format' // the code under test

describe('formatDuration', () => {
  // a SUITE: related cases
  it('writes hours and minutes, or minutes alone under an hour', () => {
    // a TEST CASE; its text is what -t matches
    expect(formatDuration(152280)).toBe('42h 18m') // an ASSERTION
    expect(formatDuration(18 * 60)).toBe('18m')
  })

  it('rounds a half minute up', () => {
    expect(formatDuration(90)).toBe('2m')
    expect(formatDuration(89.9)).toBe('1m')
  })
})
```

Every test follows the same three steps. **Arrange:** set up what the test needs. **Act:**
do the thing. **Assert:** state what must be true. Here arranging and acting are one call.

Two more kinds are worth reading once:

- **A server test with a database.**
  [`tests/server/users/users.test.ts`](../tests/server/users/users.test.ts) tests the people
  rules. It gets a real, migrated, in-memory database from `createTestDb()`
  ([`tests/helpers/db.ts`](../tests/helpers/db.ts)), so it sees exactly the tables a real
  database has, and it calls the service function directly. No server is started.
- **A component test.** [`tests/nuxt/auth-page.test.ts`](../tests/nuxt/auth-page.test.ts)
  renders the sign-in page with `mountSuspended` and replaces the auth client by a mock, so
  nothing leaves the test: no database is opened, no mail is sent, no network request is
  made. Tests in `tests/nuxt/` start with the line `// @vitest-environment nuxt`.

## Learn by doing: red, then green

This shows what a failure looks like. You undo the change at the end.

1. Run `pnpm exec vitest run tests/unit/shared/format.test.ts`. It passes.
2. In that file, change the expected text `'42h 18m'` to `'42h 19m'` and run it again. It
   fails with something like

   ```
   AssertionError: expected '42h 18m' to be '42h 19m'
   - Expected: "42h 19m"
   + Received: "42h 18m"
   ```

   Read it as: you required `42h 19m`, the code produced `42h 18m`.

3. Change it back and run it again. It passes.

That is the whole loop: a passing test, a failing test that explains itself, a fix.

## When a test fails

- **An assertion failed:** the code produced something else than expected. The message
  shows expected and received. This is the useful kind.
- **The test crashed before its assertions:** a wrong import path or a missing dependency.
  You get a stack trace instead. Run `pnpm install` again; check the path.
- **"No test files found":** the file is not under one of the test folders, or its name
  does not end in `.test.ts`.
- **A test hangs or fails only sometimes:** it reaches outside itself (a real timer, the
  network, a file another test also uses). The tests here are built not to.
- **A parity or Python test fails at once with a missing interpreter:** run
  `pnpm forecast:setup`.
- **Everything failed after `git pull`:** run `pnpm install`, then try again.

When you ask for help, paste the exact command, the full output including the summary line,
`node --version`, `pnpm --version`, your operating system, and what you already tried.

## The layers in detail

### Unit and server tests (`tests/unit/`, `tests/server/`)

They run in plain Node (`environment: 'node'` in `vitest.config.ts`).

- `tests/unit/shared/`: the Erlang and staffing arithmetic, dates, formatting.
- `tests/unit/console/`: every number the staffing page derives, its export, its status
  note, and that its stylesheet stays scoped to the page.
- `tests/unit/shell/`: every icon the pages name is in the installed icon sets.
- `tests/server/foundation/`: the access rules, the environment check, the error shape,
  the schema, the first admins.
- `tests/server/forecast/`: parameters, the arithmetic of the forecast answers, the routes'
  services, and a frozen set of answers of the old API (below).
- `tests/server/ingest/`: the workbook reader, hostile and damaged files, the per-day plan,
  the import, locking, the upload route over real HTTP.
- `tests/server/retrain/`: the runner. Most cases use a stand-in for the script
  (`fixtures/fake-python.mjs`); seven start the real retrain script on a small generated
  database and skip themselves when `forecast/.venv` does not exist.
- `tests/server/users/`: the people rules.

### Component tests (`tests/nuxt/`)

They run in the Nuxt environment and render real pages and components: the sign-in page,
the admin page and its panels, the default layout, the staffing console. Whatever would
reach outside (the auth client, `apiFetch`) is mocked in the test.

### The Python suite (`forecast/tests/`)

```bash
pnpm forecast:setup   # once: forecast/.venv with the pinned packages
pnpm forecast:test
```

It covers the model code, the features, the backtest, the staffing arithmetic, the store
(the only module that touches SQLite), and the retrain script itself: real runs on small
generated databases, including what happens when the script is stopped or killed in the
middle. The fixture `migrated_db` builds a database from the same `drizzle/` migrations the
app uses, so Python is always tested against the real schema.

A handful of tests are skipped on a normal machine: they compare with the old app and need
material that is not in the repository (see [Parity](#parity-the-new-app-against-the-old)).

### TypeScript against Python (`tests/parity/`)

Two things are computed twice in this project, once in each language, and must agree:

- the staffing arithmetic (the server and the page compute it in TypeScript; the model code
  has the original in Python);
- the workbook reader (the app reads uploads in TypeScript; the proven reader is Python).

`pnpm test:parity` runs both sides on the same generated inputs and compares the results.
It needs `forecast/.venv` and fails without it rather than skipping.

### End to end (`scripts/e2e.mjs`)

```bash
pnpm e2e                           # builds the app, then runs
node scripts/e2e.mjs --no-build    # uses the .output/ that is already there
node scripts/e2e.mjs --keep        # keeps its temp folder (database, workbooks, server log)
```

One script that drives the **production build** over HTTP only, the way a browser and an
admin would, on synthetic data it generates on the spot:

1. generates about two years of calls and writes a history workbook and a one-week workbook;
2. migrates a fresh database in a temp folder;
3. starts a local mail server that only keeps the mails;
4. builds the app and starts the server with real environment variables;
5. signs in with a mailed code (an unknown address gets no mail; a wrong code is refused);
6. checks the empty state (no forecast, no model, no retrain without calls);
7. uploads the history, checks the plan, imports, waits for the first retrain, reads the
   forecast;
8. uploads the week, retrains, and checks that the same file again has nothing to import;
9. runs a forecast refresh;
10. adds a viewer and checks what a viewer may and may not call;
11. checks the pages and that a write from another site is refused;
12. checks that no call's start time appears in the server's output;
13. checks that the sign-in rate limit answers 429;
14. stops the server and checks that it exits promptly and leaves no process behind.

It prints one `PASS` or `FAIL` line per step (`SKIP` after a failure) and exits 0 only when
every step passed; 1 when a step failed; 2 when it could not start. It needs
`forecast/.venv` and the ports 3121 and 2525 free. It never reads or writes `.env` or
`dev.db`. On synthetic data in a test sandbox it took about 45 seconds with `--no-build`
and about 75 seconds with the build.

### Type checks

`pnpm typecheck` checks the app and the server. `pnpm typecheck:tests` checks what that
does not reach: the tests outside `tests/nuxt/`, the test helpers and the scripts. A type
error in a test is a failed check in CI.

## What CI runs

`.github/workflows/test.yml` runs on every pull request and on pushes to `dev`, `stage` and
`prod`. It has three jobs, so a failure says which side broke.

- **`test`** (Node only): install, `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:tests`,
  `pnpm test`, `pnpm build`.
- **`python`** (Python only): `bash scripts/forecast-setup.sh`, then pytest in `forecast/`.
- **`parity`** (both): install, `pnpm forecast:setup`, `pnpm test:parity`, the runner tests
  that start the real retrain script (`pnpm exec vitest run --project unit
tests/server/retrain`), `pnpm build`, and the end-to-end script with `--no-build`.

Deployment is a different workflow: see [deployment.md](deployment.md#the-pipeline).

## Parity: the new app against the old

This app is a rebuild. The earlier version was a Python web service that read the calls
from Postgres and served a static page; it is the branch `final-main`. During the rebuild
the old app and the new one ran side by side on the same synthetic data, and six
comparisons, called parity rungs, showed that the new app gives the same numbers. Tests,
scripts and comments refer to them by number.

- **P1. The TypeScript staffing arithmetic equals the Python one.** `tests/parity/staffing/`:
  Python computes a grid of cases and Vitest compares every field. Runs in CI.
- **P2. The new Python on SQLite equals the old Python on Postgres.**
  `forecast/tests/test_legacy_parity.py`: the same calls give the same model fingerprint and
  the same forecast tables. Not in CI.
- **P3. The new API answers like the old API.** `scripts/parity/`: 44 recorded requests are
  replayed against the new server and each answer is compared with the recorded one. A
  frozen subset runs in `pnpm test`; the full set is not in CI.
- **P4. The TypeScript workbook reader reads what the Python reader reads.**
  `tests/parity/parser/`: generated workbooks in many shapes, read by both. Runs in CI.
- **P5. The new staffing page shows what the old page showed.** Both pages in a real
  browser on the same data, compared region by region, their exports byte by byte. Not in
  CI.
- **P6. The whole chain gives the old app's numbers.** An empty database, the workbooks
  through the real upload route, the real retrain, then the comparison of P3. Not in CI;
  `pnpm e2e` exercises the same chain without the old app to compare with.

P1 and P4 need only this repository. The others need the old app running next to the new
one with its database and its recorded answers. That material lived in the sandbox where
the rebuild was done and is not part of the repository:

- The tests for P2, and three extra cases of P4, read the folder named by the environment
  variable `V4W_LEGACY_DIR` and skip themselves when it is not set. That is why
  `pnpm forecast:test` reports a few skipped tests.
- P3 has a permanent trace: nine of the 44 recorded answers are committed as
  `tests/server/forecast/fixtures/SYNTHETIC-legacy-golden.json` and
  `tests/server/forecast/golden.test.ts` replays them in every `pnpm test`. The file holds
  answers computed from synthetic data and no call record. The tools that made and compared
  the full set are in `scripts/parity/`.
- P5 was done with a browser automation tool that is not a dependency of this project. Its
  scripts are not in the repository.

How the comparisons ended, at the close of the rebuild and on synthetic data only: the model
fingerprints were identical for two states of the data (a history, and the history plus one
more week); all 44 recorded answers matched for both states, with numbers equal to within a
billionth; the two pages agreed in every compared region and their exports were
byte-identical.

To repeat P2, P3, P5 or P6 you would have to run the old app again: check out `final-main`,
give it a Postgres database filled with calls from `forecast/tools/gen_synthetic.py`, and
record its answers. That is a description of what was done, not a tested recipe. What
protects the numbers from day to day is P1, P4, the frozen answers of P3, and the Python
suite.

## What the tests do not prove

- Nothing here has run on real call data. The reader has never seen a file written by Excel
  itself or by the partner's phone system; the copy from Postgres has never seen the real
  database.
- No test sends real mail, and none runs behind the real platform's proxy.
- The pages were checked in Chromium during the rebuild, with scripts that are not part of
  the repository. No test here drives a browser, and other browsers, phones and screen
  readers were not tried.
- Time was not waited for. The scheduled check was driven by hand and with a one-minute
  schedule, the run timeout was tested with limits of seconds, and nobody waited 7 days to
  see a session end.

The README's "Before you rely on it" turns this list into things to do.

## The expectation for a merge request

Every merge request should include at least one meaningful test for the behaviour it
changes, unless a mentor records a waiver on it.

- **What you provide:** a test that would fail before your change and passes after it, and a
  green `pnpm test` (plus `pnpm forecast:test` when you touched `forecast/`).
- **What a mentor checks:** that the test exercises the changed behaviour, that nothing was
  weakened to get it green, and that it stays inside itself (no real network, mail or data).

"Meaningful" means the test would catch a real regression.

**Before you open a merge request:**

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm typecheck:tests` pass.
- [ ] `pnpm test` passes.
- [ ] If you changed anything under `forecast/`, or the workbook reader, or the staffing
      arithmetic: `pnpm forecast:test` and `pnpm test:parity` pass.
- [ ] If you changed uploads, retraining or sign-in: `pnpm e2e` passes.
- [ ] You added or updated a test for your change.
- [ ] No data file, database, `.env` or screenshot is in the commit.

**During review:**

- [ ] The checks are green on the branch.
- [ ] There is a meaningful test for the changed behaviour, or a recorded waiver.
- [ ] Assertions are real: they would fail if the behaviour broke.
- [ ] Test data is generated in the test and labelled synthetic.

## Where a new test goes

| You changed                                             | Put the test in                               |
| ------------------------------------------------------- | --------------------------------------------- |
| A function in `shared/utils/` or `app/utils/console/`   | `tests/unit/`                                 |
| A service in `server/utils/`                            | `tests/server/<area>/`, with `createTestDb()` |
| A page or a component                                   | `tests/nuxt/`                                 |
| Anything in `forecast/db/`                              | `forecast/tests/`                             |
| Arithmetic that exists in both languages, or the reader | also `tests/parity/`                          |
