# Start here

**`integrate-admin` is the branch with everything in it.** It holds the
delivered staffing tool (what the live site runs), plus the whole team's
admin work merged in, Auth0 sign-in for admins, and call-data loading for
any range of days.

To understand the project from A to Z, read
**[`docs/PROJECT_GUIDE.md`](docs/PROJECT_GUIDE.md)**: what the tool does,
how it got here, how each part works, who did what, what is finished, what
is left and how to do it.

## The branches, in one table

| Branch | Use it for |
|---|---|
| `integrate-admin` | **All new work.** Branch from here. |
| `final-main` | What is live at https://v4w-staffing.vercel.app. Merge into it by pull request only. |
| `last-version-clients-saw` | The Nov 3 version, for reference. |
| `feature/admin-integration` and the other `feature/*` branches | History. Already merged into `integrate-admin`. |
| `dev` | The EPICS template. Do not merge the Python tool into it without a team decision. |

## Run it

```
git clone https://github.com/UTDallasEPICS/vets4war.git && cd vets4war
git switch integrate-admin
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # ask the project lead for V4W_DATABASE_URL
make serve PYTHON=.venv/bin/python PORT=8001     # then open http://127.0.0.1:8001
make test PYTHON=.venv/bin/python
```

macOS also needs `brew install libomp`. Database tests need a throwaway
Postgres; the command is in section 8 of the guide.

## How to change things

1. `git switch integrate-admin && git pull`
2. `git switch -c your-name/what-you-are-doing`
3. Make the change **with tests**. Run `make test` before you push.
4. Push your branch and open a pull request **into `integrate-admin`**.
5. Someone else reviews it. Merge only when the tests pass.
6. Going live is a separate step: a pull request from `integrate-admin` into
   `final-main`, then a deploy (guide, section 12).

## Rules that have kept this project out of trouble

- **Never commit** `.env`, passwords, the database address or client data
  (`data/` is ignored on purpose).
- **The database is shared and holds the client's real call records.** Do
  not change its tables, and do not delete or load rows, without the team
  agreeing first. Tests must never touch it; use a local test database.
- **No made-up numbers.** If a number goes to the client, it comes from a
  command you ran. If a command fails, say so.
- **Do not force-push, and do not delete or rename branches other people
  use** without telling them first.
- Importing call data does **not** retrain the model. Retrain, commit
  `models/`, deploy (guide, section 7).

## What is waiting to be done

In order, with the details in section 12 of the guide:

1. Review `integrate-admin` and merge it into `final-main`.
2. Auth0 dashboard settings for the live address (the teammate who owns the
   Auth0 tenant).
3. Vercel settings for Auth0, then deploy.
4. Apply migration 002 to the shared database (team decision first).
5. Switch imports on and load one real weekly file from the admin page.
6. Move the Vercel project and the site password to an owner who is staying.

## Who to ask

Questions about the model, the staffing page, sign-in, hosting or data
loading: Moaiz Attiq (project lead through Nov 11, 2026). Questions about
the Auth0 tenant, the original ingestion ledger or the admin page design:
the teammates named in section 4 of the guide.
