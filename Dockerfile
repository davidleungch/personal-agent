# syntax=docker/dockerfile:1.7

FROM node:22.18.0-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@11.23.0 --activate

WORKDIR /workspace
RUN chown node:node /workspace
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY --chown=node:node apps/app/package.json apps/app/package.json
COPY --chown=node:node apps/worker/package.json apps/worker/package.json
COPY --chown=node:node packages/agents/package.json packages/agents/package.json
COPY --chown=node:node packages/db/package.json packages/db/package.json
COPY --chown=node:node packages/shared/package.json packages/shared/package.json
COPY --chown=node:node packages/tools/package.json packages/tools/package.json

RUN pnpm install --frozen-lockfile

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
