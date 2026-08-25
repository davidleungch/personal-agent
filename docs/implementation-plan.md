# Phase 1 Implementation Plan

## Status and authority

This document is the approved implementation plan for Phase 1 of the Personal
Autonomous Agent Platform. [`docs/design.md`](design.md) remains the product and
architecture source of truth. If this plan conflicts with the design, the design
wins unless the user approves an explicit architecture decision.

Milestones 1–5 are COMPLETE and have been reviewed. Their architectural
contracts below remain the historical and operational source of truth.
Milestone 6 — Product Surfaces is NEXT / NOT STARTED and is the only currently
authorized implementation milestone. Milestone 7 is NOT STARTED.

## Repository structure

```text
personal-agent/
├── apps/
│   ├── app/                 # Next.js UI and HTTP API
│   └── worker/              # Scheduler, control plane, and agent runner
├── packages/
│   ├── db/                  # Drizzle schema, migrations, and repositories
│   ├── agents/              # Model interfaces and agent execution
│   ├── tools/               # Tool registry, gateway, and adapters
│   └── shared/              # Shared types and validation schemas
├── docs/
│   ├── design.md
│   └── implementation-plan.md
├── .github/workflows/ci.yml
├── AGENTS.md
├── Dockerfile
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Package boundaries are code-organization boundaries, not services. The runtime
remains one app process, one worker process, and PostgreSQL.

## Dependencies

Direct dependencies are pinned in workspace manifests and the pnpm lockfile.
No dependency should be added without a current, concrete need.

| Area | Dependency | Version | Reason |
| --- | --- | ---: | --- |
| Platform | Node.js | 22.18.0 | Matches the development environment and portable official image |
| Package manager | pnpm | 11.23.0 | Deterministic workspaces and lockfile |
| Language | TypeScript | 6.0.3 | Newest release compatible with the lint toolchain |
| Web | Next.js | 16.3.2 | Server-rendered UI and HTTP API |
| UI | React / React DOM | 19.2.8 | Next.js UI runtime |
| Validation | Zod | 4.4.3 | Runtime validation at trust boundaries |
| Database | Drizzle ORM / Drizzle Kit | 0.45.2 / 0.31.10 | Typed SQL and checked-in migrations |
| PostgreSQL client | `pg` | 8.23.0 | Established Node PostgreSQL driver |
| Agents | `@openai/agents` | 0.17.0 | Maintained model/tool execution loop behind internal interfaces |
| Browser | Playwright / Playwright Test | 1.62.1 | Browser adapter and end-to-end tests |
| Google | `googleapis` | 176.0.0 | Official Gmail and Calendar API client |
| Scheduler | Croner | 10.0.1 | Timezone-aware cron occurrence calculation |
| Logging | Pino | 10.3.1 | Structured logging with redaction |
| Tests | Vitest / V8 coverage | 4.1.11 / 4.1.11 | Unit/integration tests and exact coverage gates |
| Tooling | ESLint / Next config | 9.39.5 / 16.3.2 | Newest supported ESLint maintenance release |
| TS execution | `tsx` | 4.23.12 | TypeScript scripts and worker development |

Use native Node facilities for UUIDs, environment files, HTTP health handling,
timers, and process signals. Do not add a queue, UI kit, date library, tracing
platform, or orchestration framework.

## Domain and configuration contracts

Persistent domain state uses semantic model profiles only:

```ts
type ModelProfile = "fast" | "balanced" | "reasoning";
```

Provider model IDs are runtime configuration, initially:

```text
MODEL_FAST=gpt-5.6-luna
MODEL_BALANCED=gpt-5.6-terra
MODEL_REASONING=gpt-5.6-sol
```

The model resolver maps a semantic profile to a configured ID immediately before
an invocation. Automations, policies, API payloads, checkpoints, and events never
persist provider model names. `model_invocations` may record the concrete ID as
historical audit metadata. Changing a mapping requires no database migration.

External integration availability is also configuration-derived. Missing OpenAI
or Google credentials is normal: the app and worker remain healthy, unavailable
capabilities are omitted, and requests requiring them return a structured
`integration_unavailable` result.

## Database schema

Milestone 2 added checked-in Drizzle migrations. IDs are application-generated
UUIDs; canonical timestamps use PostgreSQL `timestamptz`; JSON is accepted only
after Zod validation and must be secret-free. Historical records use restrictive
foreign keys rather than cascading deletion.

### `command_requests`

- `id uuid primary key`
- `content text not null` containing only validated, secret-free user intent
- `status text not null`: `pending`, `processing`, `needs_input`, `completed`, or
  `failed`
- `intent_type text`, `structured_result jsonb`, and safe `error_summary text`
- claim/lease fields and created/updated/completed timestamps

The table is a durable command queue, not a conversation transcript.

### `automations`

- `id`, `name`, secret-free `goal`, five-field `schedule`, and IANA `timezone`
- `enabled`, semantic `model_profile`, `tool_policy`, and `completion_mode`
- `next_run_at`, `last_run_at`, optimistic `version`, and timestamps

The default timezone is `Asia/Hong_Kong`. Overlap is not configurable in Phase 1.

### `automation_runs`

- `id`, `automation_id`, `trigger`, nullable `scheduled_for`, and lifecycle
  `status`
- domain-specific `workflow_phase` and validated `checkpoint jsonb`
- `attempt`, `available_at`, claim/lease fields, semantic `model_profile`
- safe result/error summaries and lifecycle timestamps

Required constraints:

- unique `(automation_id, scheduled_for)` for scheduled runs;
- one active run per automation through a partial unique index covering `queued`,
  `running`, `verifying`, `retry_wait`, and `needs_human`;
- claim indexes on `(status, available_at)`.

### Audit and safety tables

- `run_events`: append-only state transitions with safe structured payloads.
- `model_invocations`: semantic profile, concrete execution model ID, status,
  latency, usage, schema outcome, and safe summary; never prompts/transcripts.
- `tool_calls`: tool, attempt, status, side-effect class, idempotency key, safe
  summaries, external ID, failure class, and timestamps.
- `idempotency_records`: unique `(scope, key)` with `reserved`, `confirmed`, or
  `unknown` state.
- `evidence`: typed, secret-free proof linked to a run and optionally a tool call.

No development-task, code-review, merge, or deployment tables belong to Phase 1.

## Application runtime

The Next.js app owns presentation, request validation, and database-backed HTTP
boundaries. Planned endpoints are:

- `POST /api/commands` and `GET /api/commands/:id`
- `GET`, `POST`, and `PATCH /api/automations`
- `GET /api/runs` and `GET /api/runs/:id`
- `POST /api/runs/:id/resume`
- `GET /health`

The app never receives OpenAI or Google credentials. It binds to host loopback in
Compose. Phase 1 assumes one trusted local user; public exposure and remote-access
authentication require a separate approved design.

## Worker runtime

One Node worker contains four small loops:

1. command processing;
2. due-automation scheduling;
3. automation-run execution;
4. expired-lease recovery.

Initial execution concurrency is one. PostgreSQL transactions and `FOR UPDATE
SKIP LOCKED` own claims. Each model run is fresh and reconstructed from validated
durable state. The worker shuts down gracefully on process signals and stops
claiming new work before its active lease expires.

Missing external credentials do not stop the worker. Its health requires only
its own runtime and PostgreSQL once database integration exists.

## Scheduler design

- Accept standard five-field cron expressions only.
- Store `scheduled_for` and `next_run_at` in UTC.
- Calculate occurrences with Croner and explicit IANA timezones; Croner timers are
  never authoritative.
- Poll every 15 seconds and lock due automations transactionally.
- Catch up at most one missed run per automation.
- When several occurrences were missed, choose the most recent occurrence where
  `scheduled_for >= now - 24 hours` and `scheduled_for <= now`.
- If all missed occurrences are older than 24 hours, record one durable skipped
  outcome and advance to the first future occurrence without executing a run.
- Create/deduplicate the selected run and advance `next_run_at` in one transaction.
- Preserve unique `(automation_id, scheduled_for)` for ordinary and catch-up runs.
- Reclaim expired leases from checkpoints after process or host restart.

Test the exact 24-hour boundary, multiple missed occurrences, duplicate wakeups,
timezones, and DST transitions.

## Automation and run state

Generic lifecycle state and domain workflow phase remain separate:

```text
queued → running → succeeded
             ├─→ verifying → succeeded | retry_wait | blocked
             ├─→ retry_wait → queued
             ├─→ needs_human → queued
             └─→ failed | blocked | cancelled
```

Checkpoint and state-event writes occur transactionally around consequential
steps. If the worker loses its lease while a consequential tool call is in
progress, recovery records `unknown` and enters verification. Only confirmed
non-execution permits a retry.

## Tool registry and contract

The immutable project-owned registry hides adapter transports from agents:

```ts
type ToolStatus = "success" | "failed" | "unknown";

type ToolResult<T> = {
  status: ToolStatus;
  data?: T;
  evidence?: Evidence[];
  externalId?: string;
  retryable: boolean;
  failureClass?: FailureClass;
};

interface ToolDefinition<Input, Output> {
  name: string;
  inputSchema: ZodType<Input>;
  outputSchema: ZodType<Output>;
  permission: PermissionClass;
  sideEffect: SideEffectClass;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  idempotencyKey?: (input: Input) => string;
  verify?: VerificationHook<Input, Output>;
  execute(input: Input, context: ToolExecutionContext): Promise<ToolResult<Output>>;
}
```

The gateway validates schemas, capabilities, permissions, preconditions,
idempotency, timeout classification, evidence, redacted summaries, and audit
writes. Only the minimal capability set is exposed. Web and email content is
typed and prompted as untrusted data, never instructions.

## Browser integration

Playwright Chromium runs in the worker. Prefer accessible roles, labels, and
stable selectors. Use a worker-only persistent-profile volume for authenticated
sessions, protected with restrictive permissions. Cookies, local storage,
passwords, and session tokens never enter model context, tool output, or logs.

Browser tools are atomic navigation/read/input operations. Consequential submit
operations require explicit preconditions, idempotency strategy where possible,
and verification after timeouts. Screenshots are not authoritative workflow
state; structured evidence metadata remains in PostgreSQL.

## Gmail and Calendar boundaries

The Gmail adapter uses read-only OAuth scopes and exposes search, read, and
bounded wait operations. Phase 1 does not send mail or process attachments.

The Calendar adapter exposes model-facing list, create, and update operations.
Creation uses a stable private extended-property idempotency key, lookup before
create, and retrieval after create as verification.

Calendar deletion is not part of the production adapter or model-facing tool
registry. A live-smoke-test-only harness may call the Google client directly to
delete uniquely marked test events. It must verify the marker and configured test
calendar before deletion and must never be bundled into production tool exposure.

## Secrets and credentials

- Never commit or persist usable credentials.
- Never place credentials in prompts, model context, traces, logs, exceptions,
  tool summaries, evidence, or transcripts.
- Load real credentials from read-only files or Compose secrets in the worker.
- Keep the app free of OpenAI and Google credentials.
- Disable Agents SDK tracing by default pending an explicit privacy review.
- Redact known secret values before any external or persistent boundary.
- Reject recognized credential formats submitted through the command UI.
- Treat the protected browser profile as credential material, not durable state.

The default Compose database credential is an explicitly public, local-only
development value. PostgreSQL is not published to the host, so it is not a usable
secret or production credential. Any deployment that changes network exposure
must replace it with a mounted secret.

## Docker Compose and portability

The steady-state stack is:

```text
app ──────┐
          ├── PostgreSQL
worker ───┘
```

`docker compose up --build` from a clean checkout must start all three services
without OpenAI or Google credentials. Missing integrations report `unavailable`
without degrading base health.

Use `node:22.18.0-bookworm-slim`, install Playwright/Chromium dependencies for
the target architecture, and use an official multi-architecture PostgreSQL
image. Do not set a fixed Compose platform, mount host `node_modules`, or commit
architecture-specific artifacts. PostgreSQL and the future browser profile use
named volumes. Verify `linux/amd64` and `linux/arm64` image builds.

## Milestones

1. **Bootstrap — COMPLETE** — this document, root agent policy, minimal repository, CI,
   credential-free Compose startup, and quality-gate validation.
2. **Database foundation — COMPLETE** — schema, checked-in migrations, repositories,
   configuration, redaction, and clean-database tests.
3. **Durable scheduler — COMPLETE** — due-run transactions, catch-up, deduplication, overlap
   prevention, leases, recovery, and state transitions.
4. **Tool gateway and adapters — COMPLETE** — registry, capabilities, audit records,
   idempotency, unknown verification, Browser, Gmail, and Calendar boundaries.
5. **Agent runtime — COMPLETE** — fresh Agents SDK runs, structured output, semantic profile
   routing, durable context compilation, and deterministic escalation.
6. **Product surfaces — NEXT / NOT STARTED** — command creation, automation review/editing, run and
   activity views, evidence, and human resume.
7. **Phase 1 acceptance — NOT STARTED** — complete fixture workflow, optional live smoke tests,
   restart/resume verification, clean-checkout setup, and all 25 design criteria.

## Testing and coverage

Normal CI always runs deterministic tests and never accesses OpenAI, Google,
personal accounts, or public websites.

- Unit tests cover validation, scheduling, policies, retry classification,
  redaction, model-profile resolution, state transitions, and safe summaries.
- PostgreSQL integration tests cover clean migrations, concurrent claims,
  deduplication, active-run exclusion, leases, checkpoints, and idempotency.
- Browser fixtures cover navigation, extraction, form handling, timeouts,
  unknown outcomes, and verification.
- Fake Gmail/Calendar transports cover success, malformed responses, auth failure,
  rate limiting, duplicates, verification, and cleanup paths.
- API/UI tests cover the command-to-run history flow.
- Canary-secret tests prove fake secrets do not cross prohibited boundaries.
- Production-owned executable code must report exactly 100% statements, branches,
  functions, and lines coverage. Coverage exclusions and ignore directives may not
  be added to satisfy the gate.

Live smoke tests are separate, opt-in, and credential-gated. They are read-only
unless a uniquely marked test artifact is necessary, avoid consequential actions,
and clean artifacts in `finally`-style teardown. Calendar event deletion belongs
only to this test harness. An unverified outcome is reported as `unknown` with
manual cleanup instructions.

## Milestone 6 handoff

Milestones 1–5 are complete and reviewed. The contracts above for those milestones
remain authoritative for their implemented behavior and operational guarantees.
Milestone 6 is not started and is the only currently authorized implementation
milestone. This documentation update does not begin its implementation.

The current handoff instruction is:

> Implement Phase 1 Milestone 6 from `docs/implementation-plan.md`: Product
> Surfaces only. Add the validated database-backed command, automation,
> run/activity, evidence, and human-resume HTTP/UI boundaries required by Phase 1.
> Preserve the completed Milestones 1–5 contracts, run every applicable quality
> gate, and stop for review before beginning Milestone 7.
