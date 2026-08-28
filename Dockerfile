# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/opt/corepack
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN mkdir -p /opt/corepack \
    && corepack enable \
    && corepack prepare pnpm@11.23.0 --activate \
    && chmod -R a+rX /opt/corepack

WORKDIR /workspace
RUN chown node:node /workspace
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY --chown=node:node apps/app/package.json apps/app/package.json
COPY --chown=node:node apps/worker/package.json apps/worker/package.json
COPY --chown=node:node packages/agents/package.json packages/agents/package.json
COPY --chown=node:node packages/db/package.json packages/db/package.json
COPY --chown=node:node packages/dev-harness/package.json packages/dev-harness/package.json
COPY --chown=node:node packages/shared/package.json packages/shared/package.json
COPY --chown=node:node packages/tools/package.json packages/tools/package.json

RUN pnpm install --frozen-lockfile

USER root
RUN pnpm --filter @personal-agent/tools exec playwright install --with-deps chromium \
    && mkdir -p /var/lib/personal-agent/browser-profile \
    && chown -R node:node /ms-playwright /var/lib/personal-agent/browser-profile \
    && chmod 700 /var/lib/personal-agent/browser-profile
USER node

COPY --chown=node:node . .
RUN pnpm build

FROM workspace AS app

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@personal-agent/app", "start"]

FROM workspace AS worker

ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "@personal-agent/worker", "start"]

FROM node:22.19.0-bookworm-slim AS development-sandbox

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/opt/corepack
ENV PATH=$PNPM_HOME:$PATH

RUN mkdir -p /opt/corepack \
    && corepack enable \
    && corepack prepare pnpm@11.23.0 --activate \
    && chmod -R a+rX /opt/corepack

WORKDIR /dependency-source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/app/package.json apps/app/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/dev-harness/package.json packages/dev-harness/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/tools/package.json packages/tools/package.json
RUN pnpm fetch --frozen-lockfile
RUN chmod -R a+rwX /pnpm/store

RUN useradd --create-home --uid 10001 sandbox
USER sandbox
WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
