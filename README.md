# Personal Agent — Phase 2C

Phase 1 is one Next.js app, one Node worker, and PostgreSQL. External model and
Google credentials are optional: the base runtime starts healthy without them
and reports those integrations as unavailable.

## Prerequisites

- Node.js 22.19.0
- pnpm 11.23.0 through Corepack
- Docker with Docker Compose

## Clean local setup

From a clean checkout:

```sh
corepack enable
corepack prepare pnpm@11.23.0 --activate
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
docker compose config --quiet
docker compose up --build -d
```

`pnpm test` and `pnpm test:coverage` create an isolated loopback-only PostgreSQL
container when `TEST_DATABASE_URL` is unset, then remove it. They require no
manual database setup and never call OpenAI, Google, personal accounts, public
websites, or other external services.

Check the stack:

```sh
curl --fail --silent http://127.0.0.1:3000/health
docker compose ps --all
```

The app is published only at `127.0.0.1:3000`. PostgreSQL and the worker health
port are internal to the Compose network. The `migrate` service must exit 0;
`app`, `worker`, and `postgres` must become healthy.

Restart the complete runtime with:

```sh
docker compose restart postgres worker app
```

Stop it without deleting durable volumes with:

```sh
docker compose stop
```

## Browser E2E

CI and the worker image install Chromium and its system libraries. To run the
real Playwright fixtures directly on a Debian/Ubuntu development host:

```sh
pnpm --filter @personal-agent/tools exec playwright install --with-deps chromium
PLAYWRIGHT_FIXTURES=1 pnpm test
```

The same fixtures can run inside the worker image if the host cannot install
system browser libraries.

## Optional credentials

Copy `.env.example` only as a reference; never put secret values in it. The
worker accepts paths to read-only files:

- `OPENAI_API_KEY_FILE`
- `GOOGLE_CLIENT_ID_FILE`
- `GOOGLE_CLIENT_SECRET_FILE`
- `GOOGLE_REFRESH_TOKEN_FILE`

Mount those files into the worker with a local, uncommitted Compose override or
Compose secrets and set the variables to the in-container read-only paths.
Restrict source files to the owner (`chmod 600`). Do not pass secret values as
environment variables. The app process must not receive OpenAI or Google
credentials. Gmail uses the read-only OAuth scope; Calendar uses the event scope.

For OpenAI, create an API key in the OpenAI account that will run the worker,
write only the key to a local file such as `.secrets/openai-api-key`, and make it
owner-readable only. For Google:

1. Create or select a Google Cloud project and enable the Gmail API and Google
   Calendar API.
2. Configure the OAuth consent screen for the intended personal account.
3. Create an OAuth client of type Desktop app.
4. Run a one-time local OAuth authorization using exactly
   `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/calendar.events`.
5. Store the client ID, client secret, and resulting refresh token in three
   separate owner-readable files under `.secrets/`. Never paste them into the
   command UI.

An uncommitted `docker-compose.override.yml` can mount the files without putting
secret values in environment variables:

```yaml
services:
  worker:
    environment:
      OPENAI_API_KEY_FILE: /run/secrets/openai_api_key
      GOOGLE_CLIENT_ID_FILE: /run/secrets/google_client_id
      GOOGLE_CLIENT_SECRET_FILE: /run/secrets/google_client_secret
      GOOGLE_REFRESH_TOKEN_FILE: /run/secrets/google_refresh_token
    secrets:
      - openai_api_key
      - google_client_id
      - google_client_secret
      - google_refresh_token

secrets:
  openai_api_key:
    file: ./.secrets/openai-api-key
  google_client_id:
    file: ./.secrets/google-client-id
  google_client_secret:
    file: ./.secrets/google-client-secret
  google_refresh_token:
    file: ./.secrets/google-refresh-token
```

## Opt-in live smoke

Live smoke is outside normal tests and CI. With no opt-in flag it exits without
accessing any account:

```sh
pnpm smoke:live
```

To opt in, provide the Google credential file paths and a dedicated test
calendar ID, then set `PHASE1_LIVE_SMOKE=1`. The default live smoke is Gmail
read-only and Calendar read-only. `PHASE1_LIVE_BROWSER_URL` enables only a
non-consequential browser open. Calendar creation additionally requires
`PHASE1_LIVE_CALENDAR_WRITE=1`; it uses a unique marker and guaranteed cleanup.
An uncertain write or cleanup reports `UNKNOWN` with the exact marker and
calendar to inspect manually.

The milestone evidence and complete Definition of Done matrix are in
[`docs/phase-1-acceptance.md`](docs/phase-1-acceptance.md).

## Phase 2 development runner

Phase 2A adds a one-shot host-level Implementer runner, Phase 2B adds a
separate independent Reviewer path, and Phase 2C adds only the bounded
three-iteration correction loop. None is a Compose service, and the app/worker
receive no Docker socket, development model credential, Git capability, or host
shell. Every correction creates a new exact candidate and fresh review. The
loop stops at `approved_candidate` or `needs_human`; there is no merge, push, or
deployment.

Build the externally isolated sandbox image:

```sh
docker buildx build \
  --target development-sandbox \
  --tag personal-agent-development-sandbox:local \
  --load \
  .
```

Create a human-approved task from a secret-free specification and criteria
file. Each criterion uses an argument vector; model-directed and final commands
are limited to `node` or `pnpm` inside the sandbox.

```json
[
  {
    "id": "tests",
    "description": "The relevant tests pass",
    "check": {
      "executable": "pnpm",
      "arguments": ["test"],
      "timeoutMs": 600000
    }
  }
]
```

```sh
DATABASE_URL=postgresql://personal_agent:personal_agent_local@127.0.0.1:5432/personal_agent \
pnpm --filter @personal-agent/dev-harness start -- \
  task-create \
  --title "Approved small change" \
  --spec-file /path/to/approved-spec.md \
  --criteria-file /path/to/acceptance-criteria.json \
  --base HEAD
```

For execution, configure a dedicated runner-owned Pi directory. Do not point it
at personal `~/.pi/agent` state. Concrete provider/model IDs remain runtime
configuration and are never persisted as task policy.

```sh
DATABASE_URL=postgresql://personal_agent:personal_agent_local@127.0.0.1:5432/personal_agent \
DEVELOPMENT_PI_AGENT_DIR=/var/lib/personal-agent/development-runner/pi \
DEVELOPMENT_SANDBOX_IMAGE=personal-agent-development-sandbox:local \
pnpm --filter @personal-agent/dev-harness start -- \
  run-once \
  --allowed packages/shared \
  --forbidden .git,.pi,.secrets,browser-profile \
  --relevant packages/shared/src/domain.ts \
  --profile balanced
```

Run one independent review with an explicitly bounded readable/source set. The
Reviewer gets no Implementer session state and can run only acceptance checks
already approved on the task.

```sh
DATABASE_URL=postgresql://personal_agent:personal_agent_local@127.0.0.1:5432/personal_agent \
DEVELOPMENT_PI_AGENT_DIR=/var/lib/personal-agent/development-runner/pi \
DEVELOPMENT_SANDBOX_IMAGE=personal-agent-development-sandbox:local \
pnpm --filter @personal-agent/dev-harness start -- \
  review-once \
  --readable AGENTS.md,docs,packages/shared \
  --forbidden .git,.pi,.secrets,browser-profile \
  --relevant packages/shared/src/domain.ts \
  --profile reasoning
```

Run the bounded Phase 2C loop only after an exact candidate has a finalized
review. Reconciliation remains separate from role-pure Reviewer finalization.

```sh
DATABASE_URL=postgresql://personal_agent:personal_agent_local@127.0.0.1:5432/personal_agent \
DEVELOPMENT_PI_AGENT_DIR=/var/lib/personal-agent/development-runner/pi \
DEVELOPMENT_SANDBOX_IMAGE=personal-agent-development-sandbox:local \
pnpm --filter @personal-agent/dev-harness start -- \
  fix-loop \
  --allowed packages/shared \
  --readable AGENTS.md,docs,packages/shared \
  --forbidden .git,.pi,.secrets,browser-profile \
  --relevant packages/shared/src/domain.ts
```

If the runner stops after a lease, cleanup, or finalization failure, an
authorized operator can run `recover-one` or `recover-review`. Recovery uses
PostgreSQL, Git, and governing repository documents, starts a fresh role session
when a bounded infrastructure retry is authorized, and never depends on prior
Pi session state.

Normal tests use a deterministic fake Pi transport and no provider account.
The current Pi SDK is pinned to `0.84.3`; it requires Node 22.19 or newer, which
is the concrete reason the repository's Node patch pin is 22.19.0.
