# syntax=docker/dockerfile:1

# Build container: the Nuxt app.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# Toolchain for native modules (better-sqlite3) when no prebuilt binary fits.
RUN apt-get update && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm i -g pnpm@10 && pnpm i --frozen-lockfile
COPY . ./
# The time of the scheduled retrain check is fixed when the app is built (nuxt.config.ts
# reads V4W_RETRAIN_CRON then). Leave it out for the default, 30 8 * * * (server time,
# UTC in this image), or build with --build-arg V4W_RETRAIN_CRON="<minute hour * * *>".
ARG V4W_RETRAIN_CRON
RUN pnpm run build

# Deployment container: Python 3.12 (numpy 2.5 needs it; Debian's own is 3.11) with the
# Node binary copied in. Node serves everything; Python is only started by Node for a retrain.
FROM python:3.12-slim-bookworm AS deployment
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
# LightGBM needs the GNU OpenMP runtime.
RUN apt-get update && apt-get install --yes --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app app
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY forecast/requirements-runtime.txt ./forecast/requirements-runtime.txt
RUN python -m venv /app/forecast/.venv \
    && /app/forecast/.venv/bin/pip install --requirement ./forecast/requirements-runtime.txt
COPY forecast/db ./forecast/db
COPY forecast/models ./forecast/models
COPY --from=builder /app/.output ./
ENV V4W_FORECAST_DIR=/app/forecast V4W_PYTHON=/app/forecast/.venv/bin/python
# The template's image runs as root and the platform's database volume is written by that
# user, so root stays the default. `--build-arg RUN_AS=app` runs as the unprivileged user
# created above; use it where the folder of DATABASE_URL is writable by uid 10001.
ARG RUN_AS=root
USER ${RUN_AS}
EXPOSE 3000
CMD ["node", "./server/index.mjs"]
