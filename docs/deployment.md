# Deployment

How the app is shipped and what it needs once it runs somewhere real: the image, the
pipeline, the settings, the database file and its backup, the sign-in rate limit, and how
large a task to give it.

Read these six points first. Each has its own section below.

1. **The SQLite file is the only state.** People, call history, the trained model and the
   forecast are all in it. Put it on storage that survives a redeploy, and back it up.
2. **The sign-in rate limit depends on the proxy in front of the app.** As delivered it is
   not configured for any particular platform. Depending on the proxy, all visitors may
   share one allowance (so one person can lock everyone out for a minute at a time), or a
   client may be able to dodge the limit. Configure it and test it before going live.
3. **Slow storage makes the whole server pause.** When the server waits for the database
   lock, it waits on its only thread. On network storage every such pause is longer.
4. **The staffing page loads its font from Google Fonts** in the browser. Nothing else on the
   pages leaves your host.
5. **The proxy's request-size limit must let workbooks through.** The multi-year workbook is
   about 15 MB; the app itself accepts up to 40 MB.
6. **The image runs as root unless you build it otherwise.** The build argument `RUN_AS=app`
   makes it run as an unprivileged user.

Nothing in this guide has been tried on the real hosting platform. What that leaves open is
listed in the README under "Before you rely on it".

## The image

One image holds both halves (`Dockerfile`):

- **Build stage** (`node:22-bookworm-slim`): installs the dependencies with pnpm and runs
  `pnpm run build`. It carries a compiler toolchain for native modules; none of that reaches
  the final image.
- **Final stage** (`python:3.12-slim-bookworm`): Python 3.12 with the Node binary copied in.
  The retrain script needs Python 3.12 and the GNU OpenMP library; Node needs nothing from
  the system. It contains:
  - `/app/server/index.mjs` and the rest of the built app (the content of `.output/`);
  - `/app/forecast/db/` (the Python package) and `/app/forecast/models/` (the reference
    model);
  - `/app/forecast/.venv/`, a Python environment with exactly the pinned packages of
    `forecast/requirements-runtime.txt`.

It listens on port 3000 and starts with `node ./server/index.mjs` from `/app`. These
variables are already set in the image: `NODE_ENV=production`,
`V4W_FORECAST_DIR=/app/forecast`, `V4W_PYTHON=/app/forecast/.venv/bin/python`. Built for
amd64 the image is about 870 MB.

What has and has not been built. The image was built and run for amd64 in a test sandbox:
the health check, sign-in by mail, an upload whose retrain the server started inside the
container, and a retrain by hand, both as `root` and as the user `app`. For **arm64**, which
is what the pipeline deploys, the `Dockerfile` has **not** been built from start to finish.
The sandbox is an amd64 machine that emulates ARM; under that emulation every step of the
`Dockerfile` ran except `pnpm run build`, which hung. What runs in the final image was
checked on emulated arm64 separately: Node, the Python environment with its packages, and
(in an image whose JavaScript was built on amd64) an upload with its retrain. So the first
complete arm64 build is the one the pipeline does on its ARM runner. Watch that run.

Four consequences of how the image is made:

- **Build the image on the kind of CPU it will run on.** The build includes native binaries
  for the machine that builds it. The pipeline builds on an ARM runner for `linux/arm64`.
- **The image cannot migrate its own database.** The migration tools are not in it; the
  pipeline migrates before the new image starts (below).
- **The schedule time is fixed when the image is built.** `V4W_RETRAIN_CRON` is read by
  `pnpm build`, not by the running server. The `Dockerfile` takes it as a build argument:
  `docker build --build-arg V4W_RETRAIN_CRON="15 7 * * *" ...`. Without the argument the
  scheduled check runs at 08:30 UTC. The pipeline passes no build argument, so a deployed
  image uses that default until `deploy.yml` is changed to pass one.
- **Two Pythons are in the image.** The plain `python` on the path is the base image's own
  and has none of the packages. The retrain script runs with
  `/app/forecast/.venv/bin/python`, which is what `V4W_PYTHON` points at.

### Running as root, or not

The image runs as `root` by default. That is what the EPICS template's image does, and the
platform's database volume is expected to be written by that user (confirm it with the
platform owner).

The image also contains an unprivileged user, `app` (user id 10001). To run as that user,
build with

```bash
docker build --build-arg RUN_AS=app -t v4w-staffing .
```

Use it where the folder that holds the database file is writable by user id 10001. If it is
not, the app cannot open its database and every request that needs it fails. Running as an
unprivileged user is the better default wherever the platform allows it: ask the platform
owner who owns the volume.

### Trying the image on your own machine

```bash
mkdir -p local-data
DATABASE_URL=file:./local-data/app.db pnpm db:migrate
docker build -t v4w-staffing .
docker run --rm -p 3000:3000 -v "$PWD/local-data:/data" --env-file deploy.env v4w-staffing
```

`deploy.env` holds the settings of the next section, one `NAME=value` per line, without
quotes and without comments after a value. It must not be committed. `EMAIL_TRANSPORT`
cannot be `console` here: a production build needs a real mail server, or a local test mail
server.

To run the retrain script by hand inside a running container, use the environment's Python
and the script's folder:

```bash
docker exec -w /app/forecast <container> /app/forecast/.venv/bin/python -m db.retrain --db /data/app.db --mode forecast-only
```

## Settings

A production build does not read a `.env` file. Give the container real environment
variables.

| Variable                   | Value in a deployment                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`             | `file:` plus the **absolute** path on the volume: `file:/data/app.db` |
| `BETTER_AUTH_SECRET`       | your own long random text (`openssl rand -hex 32`), kept secret       |
| `BETTER_AUTH_URL`          | the public address, exactly as people type it, with `https://`        |
| `EMAIL_TRANSPORT`          | `smtp`                                                                |
| `EMAIL_HOST`, `EMAIL_PORT` | the mail server that sends the sign-in codes, and its port            |
| `EMAIL_USER`, `EMAIL_PASS` | its login                                                             |
| `EMAIL_SECURE`             | `true` when the server expects TLS from the first byte (port 465)     |
| `EMAIL_FROM`               | the sender address people see                                         |
| `V4W_ADMIN_EMAILS`         | the first admin or admins                                             |
| `V4W_DATA_SOURCE`          | `partner` once real call data is in; `synthetic` until then           |
| `V4W_GATE_WORKERS`         | see [How big a task](#how-big-a-task)                                 |

Everything else has a usable default; the full list is in the README and in `.env.example`.

- A relative `DATABASE_URL` would put the database in `/app` inside the container, where it
  is lost at the next deploy. Always use an absolute path on the volume.
- Without `V4W_ADMIN_EMAILS` nobody can sign in to a new database, because sign-up is off.
- Changing `BETTER_AUTH_SECRET` later signs everyone out.
- If `BETTER_AUTH_URL` is not the address in the browser, people can still sign in and
  read, but every change (an upload, a retrain, adding a person) and signing out are refused
  with 403.
- A wrong or missing value stops the start with a message that names the variable. With
  `EMAIL_TRANSPORT=console` a production build refuses to start:
  "EMAIL_TRANSPORT=console is for `nuxt dev` only".
- `PORT` changes the port the server listens on (default 3000).

To run a production build outside a container:

```bash
pnpm build
pnpm start      # node --env-file=.env .output/server/index.mjs
```

`pnpm start` hands the `.env` file to Node, because the built server does not look for it.

## The pipeline

A push to the `stage` or `prod` branch starts `.github/workflows/stage.yml` or `prod.yml`,
which both call `.github/workflows/deploy.yml`. The order is deliberate: a migration that
fails stops the pipeline before any image is published.

1. **Build** the image for `linux/arm64`. It is not pushed yet.
2. **Package the migration bundle**: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`,
   `drizzle.config.ts`, `pnpm-workspace.yaml`, `drizzle/` and `server/db/`, zipped and
   uploaded to the platform's bucket.
3. **Migrate.** A function on the platform unpacks the bundle and applies the migrations to
   the environment's database. When the repository variable `SEED_MIGRATION` is `true` it
   also runs the seed.
4. **Push** the image and **restart** the service with it, as one instance.

The repository needs the secrets `ACTIONS_ROLE_ARN` and `CLUSTER_NAME` and the variable
`REPOSITORY`. They, the bucket, the migration function and the service itself belong to the
EPICS platform; ask its owner how the service gets its environment variables and where its
database volume is mounted.

Two rules follow from the bundle:

- **Everything under `server/db/` must work on its own.** The bundle ships `server/db/` and
  `drizzle/` only, so `schema.ts`, `seed.ts` and `admins.ts` may import from each other and
  from installed packages, and nothing else at run time (type-only imports are fine).
- **A schema change needs its migration in the same commit.** Change `server/db/schema.ts`,
  run `pnpm db:generate`, commit the new file under `drizzle/`.

The seed only makes the `V4W_ADMIN_EMAILS` addresses admins, and only if that variable is
set where the seed runs. It does not matter if it is not: the server does the same thing
every time it starts.

CI (`.github/workflows/test.yml`) is separate from deployment and runs on every pull request
and on pushes to `dev`, `stage` and `prod`: see [testing.md](testing.md).

## The database file

Everything the app knows is in the one SQLite file named by `DATABASE_URL`. The image holds
no state: a new container with the same file serves the same forecast, and a new container
with an empty file starts from nothing.

**Where it must live.** On a volume that survives a redeploy and a restart of the task. Ask
the platform owner for the path and put it in `DATABASE_URL`. SQLite keeps a second file
next to it while it writes (`<name>-journal`), and a retrain started from a shell keeps a
small lock file there too, so the app needs to be able to create files in that folder, not
only to write the database file.

**One server at a time.** The app is built for one running instance per database file. The
pipeline restarts the service with a desired count of one. Two servers on one file, even
briefly, have not been tested: each would run its own schedule and its own retrains.

**Storage speed.** The server and the retrain script take turns writing. Whoever comes
second waits for the lock (up to 15 seconds in the server, 30 in the script) instead of
failing. In the server that wait is on its only thread: while a write waits, no other request
is answered, the health check included. Measured on synthetic data in a test sandbox with a
local disk, a retrain held the write lock for about a quarter of a second, twice per run.
On slow or network storage those pauses grow, and SQLite's file locking on network
filesystems is a known weak spot in general. Prefer local or block storage. The app never
switches SQLite to WAL mode, because WAL does not work on network filesystems at all.

**Backing it up.** Copying the file while the app writes can give a broken copy. Use
SQLite's own backup, which is safe while the app runs. Inside the container:

```bash
/app/forecast/.venv/bin/python -c "import sqlite3, sys; src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()" /data/app.db /data/backup.db
```

(with your own paths; any Python 3 does it, and so does the `.backup` command of the
`sqlite3` shell). Copy the result off the machine. Make a backup before the first real
import, before every bulk change, and on a schedule that matches how much re-uploading you
are willing to do.

**Restoring.** Stop the service, put the backup in place of the database file, delete a
leftover `-journal` file of the old database if there is one, and start the service. If the
backup is older than the newest uploads, upload those files again.

**What losing the file costs.** The people list comes back from `V4W_ADMIN_EMAILS` only for
the admins named there. The call history has to be loaded again (the copy from Postgres, or
the workbooks). The model is retrained from it.

## The sign-in rate limit and the client address

Signing in works with a six-digit code sent by mail. The protection against guessing and
against mail flooding is Better Auth's rate limit, and it is worth understanding exactly,
because it is the only one there is.

What the app does (Better Auth 1.6.23, as configured in `server/utils/auth.ts`):

- A code has 6 digits and is valid for 5 minutes. After 3 wrong tries a code is dead, so one
  code gives a guesser 3 chances in a million.
- Asking for a code and trying to sign in are each limited to **3 requests per 60 seconds
  per client address**. The limit is on in every production build and off under `pnpm dev`.
- The client address is read from the `X-Forwarded-For` header, and only when that header
  holds **exactly one** address.
- A request whose address cannot be read that way lands in **one bucket shared by everyone
  in the same situation**. The server logs a warning once when that happens: "Rate limiting
  could not determine a client IP and is falling back to a single shared per-path bucket."

What that means depends on what stands between the internet and the app:

| In front of the app                                       | An honest visitor             | Someone who invents the header         |
| --------------------------------------------------------- | ----------------------------- | -------------------------------------- |
| 1. A proxy that **overwrites** the header                 | an allowance of their own     | cannot: the proxy replaces it          |
| 2. A proxy that **appends** the real address              | an allowance of their own     | lands in the shared bucket             |
| 3. **Two** appending hops (a CDN and a load balancer)     | the shared bucket, every time | the shared bucket                      |
| 4. **Nothing**, or a proxy that passes the header through | the shared bucket             | a fresh allowance per invented address |

Why, row by row:

1. The proxy writes the real client address into the header, whatever the client sent. One
   address, believed: each visitor has 3 requests per minute. This is the safe arrangement.
2. The proxy adds the real address to whatever the client sent (the default of an AWS
   Application Load Balancer). An honest client sends no such header, so the app sees one
   address and the visitor has their own allowance. A client that invents one arrives with
   two addresses, is not believed, and lands in the shared bucket.
3. With two hops that each append, the header always holds two addresses. Every visitor is
   in the shared bucket: the whole site can ask for 3 codes and try 3 sign-ins per minute.
4. If the app's port can be reached without a proxy, or the proxy hands the client's header
   on unchanged, an honest client (no header) is in the shared bucket, and a client that
   sends one invented address is believed. Every new invented address gets a fresh
   allowance: **the limit is gone**.

- **Guessing a code** is possible only in row 4. Someone who knows an address that
  has access can then ask for code after code and try 3 guesses on each: on the order of a
  million requests for an even chance, with one mail to the victim per code. Slow and loud,
  but possible. So the app's port must never be reachable except through a proxy that
  overwrites or appends the header.
- **Lockout** is possible in rows 2 to 4. Whoever is in the shared bucket shares 3 requests
  per minute with everyone else in it. In row 3 that is every visitor: the whole site can
  ask for 3 codes and try 3 sign-ins per minute, and one impatient person or one script can
  stop sign-in for all, a minute at a time.

**What to configure.** Tell Better Auth about the platform's proxies in
`server/utils/auth.ts`. There is no environment variable for this yet; it is a change of a
few lines, and it has not been made because the platform's proxy layout is not known.

```ts
export const auth = betterAuth({
  // ...what is there now...
  advanced: {
    ipAddress: {
      // The address ranges of the platform's own proxies. Better Auth then reads the header
      // from the right and takes the first address that is not one of them.
      trustedProxies: ['10.0.0.0/8'],
      // Or, instead: a header that the platform itself always sets.
      // ipAddressHeaders: ['x-real-ip'],
    },
  },
})
```

The range and the header name above are placeholders: ask the platform owner for the real
ones.

**How to check, after every change to the proxy or to this setting.** Use an address that
has no access, so that no mail is sent:

```bash
for i in 1 2 3 4; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://staffing.example.org/api/auth/email-otp/send-verification-otp \
    -H 'content-type: application/json' -d '{"email":"nobody@example.org","type":"sign-in"}'
done
```

1. From one machine, the four lines must read `200 200 200 429`.
2. Run it again with a different made-up address each time
   (`-H "X-Forwarded-For: 203.0.113.$i"` added to the `curl` line). The fourth must still be
   `429`. Four times `200` means a client can choose its own address and the limit does not
   hold.
3. While your own allowance is used up, ask for a code from another network (a phone on
   mobile data). It must be accepted. If it is refused, all visitors share one allowance.
4. The server log must not contain "Rate limiting could not determine a client IP".

There is no limit per email address in the app, only the one per client address described
here. Adding one, and making the trusted proxies a setting, would be a sensible next step.

## Fonts and other outside requests

The staffing console loads the font Instrument Sans from Google Fonts
(`fonts.googleapis.com`, `fonts.gstatic.com`) in the visitor's browser. If the browser
cannot reach them, the page falls back to a system font and works the same. If your
organisation does not allow such requests, serve the font yourself and change the links in
`app/layouts/console.vue`.

Nothing else is loaded from outside: the icons are bundled with the app, and the sign-in and
admin pages make no outside request. The server itself makes one kind of outgoing
connection, to the mail server.

## Request size

An upload is one HTTP request with the workbook in its body. The app accepts files up to
`V4W_UPLOAD_MAX_MB` (40 MB by default) and refuses larger ones with a clear message. A proxy
or load balancer in front of the app has a limit of its own, and when that one is lower the
upload fails before the app sees it, usually with an error page instead of the app's
message.

The multi-year workbook is about 15 MB. Ask the platform owner what the limit is and
whether it can be raised. If it cannot, load the history with
[the copy from Postgres](call-data.md#the-one-time-copy-from-postgres) and upload one year
per file afterwards. The app also accepts bodies that a proxy forwards in chunks, without a
declared length.

## How big a task

Two things need memory and CPU: the server itself and, during a run, the retrain script. The
figures below were **measured on synthetic data in a test sandbox** (about 388,000 calls over
six years, 4 CPU cores shared with other work). They say nothing about forecast accuracy and
are a starting point, not a promise. Measure again on the real platform with the real data.

A full retrain, by number of worker processes of the check (`V4W_GATE_WORKERS`):

| Workers | Time | Memory of the script and its workers together |
| ------- | ---- | --------------------------------------------- |
| 1       | 53 s | about 230 MB                                  |
| 2       | 30 s | about 400 MB                                  |
| 4       | 21 s | about 670 MB                                  |

The memory column was sampled twice a second, so short peaks can be higher. The server
process itself used about 220 MB when idle and up to about 550 MB while it built many
year-long forecast answers at once. Reading a 14.5 MB workbook took about 200 MB.

What follows from that, as a first guess:

- With about 2 GB of memory the default of 4 workers fits.
- With 1 GB, set `V4W_GATE_WORKERS=1`. The retrain is slower and the server stays
  responsive.
- The default number of workers is 4, or the number of CPUs when the task has fewer. On a
  task with a fraction of a CPU a run takes much longer than the times above; a run that
  passes `V4W_RETRAIN_TIMEOUT_MIN` (60 minutes) is stopped.
- If the system kills the script for lack of memory, the run ends as Failed ("stopped by
  SIGKILL") and the forecast in use stays. Nothing is lost; give it more memory or fewer
  workers and run it again.

The one-time copy from Postgres needs more than the app ever does (about 730 MB for that
amount of data, same conditions). Run it from a machine with room, not from the smallest
task.

A request for a full year of forecast is real work for the server: about 1 second with the
default settings and up to about 7 seconds at the edges of the accepted parameters, same
conditions. The server stays responsive during one such request, but twenty at once kept it
busy for over two minutes.

## Comparing models across machines

`--verify-reference` (see [retraining.md](retraining.md#checking-against-the-reference-model))
trains a model on the stored calls up to the last day of the committed reference model and
compares fingerprints. The fingerprint is a hash of the whole model text, so it changes when
a single number differs in its last digit.

`MATCH` proves two things at once: the database holds the same calls the reference model was
trained on, and this machine computes exactly as the machine that trained it.

`DIFFERENT` can mean either of two things. Find out which:

1. **Is the data the same?** The command prints `train_rows` and `train_start` for both
   models. If they differ, the stored calls are not the calls the reference was trained on
   (days are missing, or were replaced). `forecast/models/metadata.json` also records, under
   `data_sources`, how many calls and days the reference was trained on, and its last day
   under `train_end`: compare them with the Forecast runs tab. A difference here is about
   the data and has to be understood before anything else.
2. **Is it the machine?** The same data and the same pinned library versions
   (`forecast/requirements-runtime.txt`) give the same model on the same kind of CPU. That
   was shown on synthetic data during the rebuild. Across CPU kinds (an Intel or AMD machine
   against an ARM server) identical results are not guaranteed, because floating-point
   arithmetic in the numeric libraries can differ in the last digits. One data point exists:
   the same synthetic history gave the identical fingerprint and identical check figures on
   amd64 and on arm64, where arm64 was emulated on the same machine. That is encouraging; it
   is not real ARM hardware and not the real data. A different fingerprint on a different
   CPU is therefore not a fault by itself. Look at what matters instead:
   - make a copy of the database that ends on the reference model's last day, and retrain
     on the copy (never on the live file):

     ```bash
     cd forecast
     .venv/bin/python -c "import sqlite3, sys; src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2]); src.backup(dst); dst.execute(\"DELETE FROM calls WHERE start_ts >= '2026-11-04'\"); dst.commit(); dst.close(); src.close()" /absolute/path/app.db /absolute/path/compare.db
     .venv/bin/python -m db.retrain --db /absolute/path/compare.db
     ```

     (`2026-11-04` is the day after the reference model's `train_end`.)

   - compare what it prints with `forecast/models/metadata.json`: the check table ("## Gate",
     eight measures for the model and for the baseline) with `gate`, the "level factor" with
     `level_factor`, and the "hour-of-day factors" with `calibration.hour`.

   Figures that agree to the digits printed mean the two models are the same for every
   practical purpose. Figures that differ visibly mean the data or the library versions
   are not the same, whatever the CPU.

Delete the copy afterwards: it holds call data.

## Starting, stopping, health

- **Health check.** `GET /api/health` answers 200 without a session. It answers even when
  the database has not been migrated yet, so a new deployment can be checked before its
  first migration; the log then says "database is not migrated: run pnpm db:migrate".
- **Start.** The server makes the `V4W_ADMIN_EMAILS` addresses admins, marks uploads and
  runs that an earlier server left unfinished, and starts a retrain if call data is waiting
  for one.
- **Stop.** On `SIGTERM` (what `docker stop` and the platform send) the server stops a
  running retrain, records it as Interrupted, and exits within a few seconds; with no run
  in progress it exits at once. The next start picks the work up again.
- **Logs.** Lines start with `[admins]`, `[uploads]` or `[retrain]` and say what happened in
  plain words. They never contain a call record or a sign-in code.

## First-deploy checklist

1. Ask the platform owner: where is the persistent volume mounted, who owns it, how is it
   backed up, what is the request-size limit, and what does the proxy do with
   `X-Forwarded-For`?
2. Set the repository's secrets and variable for the pipeline (`ACTIONS_ROLE_ARN`,
   `CLUSTER_NAME`, `REPOSITORY`).
3. Set the service's environment: the table under [Settings](#settings).
4. Configure the client address for the rate limit and push to `stage`.
5. Check `GET /api/health`, then sign in as an address from `V4W_ADMIN_EMAILS` with a code
   that arrives by real mail.
6. Run the four rate-limit checks.
7. Upload a synthetic workbook (see
   [call-data.md](call-data.md#trying-it-with-generated-data)), import it, and watch the
   retrain end as Done. Note how long it took and how much memory the task used.
8. Redeploy once and confirm the data is still there.
9. Make a backup and restore it once.
10. Only then replace the synthetic data with the real history: start from an empty
    database file, load the real calls, set `V4W_DATA_SOURCE=partner`, and work through
    "Before you rely on it" in the README.
