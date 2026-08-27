# Phase 1 Acceptance

**Acceptance date:** 2026-08-27  
**Scope:** Phase 1 / Milestone 7 only  
**Overall result:** PASS

This document maps the 25 Phase 1 Definition of Done criteria from
[`design.md`](design.md) without changing their wording or semantics. Normal
acceptance uses only deterministic local model and adapter fixtures. No OpenAI,
Google, personal account, or public website was accessed.

## Definition of Done matrix

| # | Exact criterion from `docs/design.md` | Implementation | Test or verification evidence | Status |
|---:|---|---|---|:---:|
| 1 | A user can create an automation from natural language. | `POST /api/commands`; durable worker command processor in `apps/worker/src/command-processor.ts` | `phase-1-acceptance.integration.test.ts`; `durable natural-language command processing` | PASS |
| 2 | The automation is stored durably in PostgreSQL. | `command_requests` and `automations`; atomic command completion/automation insert | Full fixture queries PostgreSQL after command processing; repository integration tests | PASS |
| 3 | Restarting `app`, `worker`, or the host does not lose automation definitions. | PostgreSQL-authoritative automation records; disposable app/worker processes | Full fixture reconstructs scheduler after command processing; clean-stack stop/start and restart checks | PASS |
| 4 | A due schedule creates exactly one run for a given `(automation_id, scheduled_for)`. | Scheduler transaction plus unique index | Full fixture concurrent duplicate wake-up; `durable due scheduling`; database invariant tests | PASS |
| 5 | The same automation cannot accidentally execute overlapping runs under the default policy. | Partial unique PostgreSQL index for active run states | `database invariants`; concurrent scheduler and run-claim integration tests | PASS |
| 6 | Every run loads a fresh model session from durable state. | Agent Runtime reloads run, checkpoint, evidence metadata, and events before each invocation; SDK sessions disabled | Full fixture uses six separate invocations; `reconstructs a fresh next step...`; SDK boundary asserts no conversation/response IDs | PASS |
| 7 | Each run receives only the tools resolved for that task. | Capability resolver and immutable production registry | Full fixture asserts the exact `course-registration` bundle on every step; injection/unauthorized-tool regression tests | PASS |
| 8 | The general agent can use the browser, search/read Gmail, and create a Calendar event through adapters. | Browser, Gmail, and Calendar production tool definitions behind the Tool Gateway | Full fixture executes `browser.open`, `browser.read`, `gmail.search`, `gmail.read`, and `calendar.create_event`; Playwright adapter E2E | PASS |
| 9 | Every tool call is logged with normalized status and safe summaries. | Tool Gateway audit persistence and normalized `ToolResult` | Full fixture reads history and durable `tool_calls`; gateway normalization/redaction tests | PASS |
| 10 | Consequential tool calls support duplicate protection or explicit verification before retry. | Gateway idempotency reservations, verification hooks, stable adapter keys | Calendar duplicate call in full fixture; browser/Calendar consequential gateway tests | PASS |
| 11 | `unknown` side-effect outcomes enter verification rather than blind retry. | Gateway unknown state and run recovery to `verifying` | Timeout-after-side-effect and unresolved-operation integration tests | PASS |
| 12 | A crashed or interrupted run can resume from persisted workflow state. | Checkpoints, leases, interrupted invocation recovery, PostgreSQL reconstruction | Durable scheduler/runtime restart and reclamation tests listed below | PASS |
| 13 | A successful workflow stores evidence proving completion. | `evidence` linked to run/tool call; deterministic completion validator | Full fixture requires Calendar evidence before success and exposes it through history | PASS |
| 14 | Calendar creation is idempotent under retries. | Stable private extended-property key, lookup-before-create, read-back verification | Full fixture repeats the same create and observes one insertion; Calendar adapter/gateway duplicate tests | PASS |
| 15 | The user can inspect automations, latest run state, result, and tool-call history. | Product service, HTTP API, dashboard, run detail/activity/evidence views | Full fixture reads safe run history via the HTTP API; API/UI and Playwright tests | PASS |
| 16 | Secrets never appear in model context or persisted tool summaries. | Secret rejection/redaction, bounded context compiler, adapter-local credentials | Full fixture canary assertions; shared, gateway, runtime, and API canary tests | PASS |
| 17 | `docker compose up` starts the complete application runtime from documented setup. | Root Dockerfile, Compose app/worker/migrate/PostgreSQL stack, `README.md` | Isolated source-only checkout: `docker compose up --build -d`; health and restart checks | PASS |
| 18 | Database migrations work from a clean database. | Four checked-in Drizzle migrations and migration service | Clean-schema integration tests; isolated empty Compose volume; migration service exited 0; `drizzle-kit check` | PASS |
| 19 | Lint passes. | Root ESLint command | `pnpm lint` — exit 0 | PASS |
| 20 | Typecheck passes. | Workspace TypeScript commands | `pnpm typecheck` — exit 0 | PASS |
| 21 | Build passes. | Workspace builds and production Next build | `pnpm build` and Docker builds — exit 0 | PASS |
| 22 | All tests pass. | Vitest, PostgreSQL integration, deterministic fixture, Playwright fixtures | Root suite: 150 passed / 3 opt-in browser fixtures skipped; worker-image Playwright suite: 153/153 passed | PASS |
| 23 | Owned executable code reports exactly **100% statements, 100% branches, 100% functions, and 100% lines coverage**. | V8 coverage thresholds | `pnpm test:coverage`: 1474/1474 statements, 1021/1021 branches, 413/413 functions, 1287/1287 lines | PASS |
| 24 | No new coverage exclusions are introduced merely to satisfy the gate. | Repository coverage policy and source audit | No ignore directives or new exclusion patterns; meaningful behavior assertions cover new paths | PASS |
| 25 | A clean-checkout setup/run guide is complete and reproducible except for real external credentials. | Root `README.md`, `.env.example`, Docker Compose | Source-only isolated checkout install/build/start validation; credential-free base runtime; live-smoke instructions | PASS |

## Deterministic full fixture

`apps/app/test/phase-1-acceptance.integration.test.ts` exercises this real
control-plane chain:

```text
HTTP natural-language command
→ command_request
→ worker command claim + structured intent decision
→ atomic automation creation
→ restarted scheduler at due time
→ concurrent wake-up deduplication
→ one scheduled automation_run
→ worker PostgreSQL lease claim
→ six fresh durable model steps
→ minimum course-registration capability bundle
→ Browser open/read fixture
→ Gmail search/read fixture
→ idempotent Calendar create + read-back
→ tool calls, idempotency, evidence, and run events
→ deterministic completion validator
→ succeeded
→ HTTP run history
```

The fixture includes hostile webpage/email text and a canary secret. The hostile
text remains typed as untrusted data, cannot add tools, and the canary is absent
from every model context and persisted audit boundary.

## Restart and recovery acceptance

| Scenario | Evidence | Status |
|---|---|:---:|
| Restart before scheduled execution | Full fixture reconstructs a new scheduler from the persisted automation | PASS |
| Restart after run creation but before claim | `claimRun` operates only on the persisted queued row | PASS |
| Restart while a run is active | Expired running lease recovery tests | PASS |
| Restart after a durable checkpoint | Fresh runtime reconstruction test loads checkpoint/events/evidence metadata | PASS |
| Interrupted model invocation | Started invocation becomes `model_execution_interrupted`; fresh invocation resumes | PASS |
| Expired lease and reclamation | Durable lease recovery and re-claim tests | PASS |
| Old executor fenced after reclamation | Stale checkpoint/transition/tool persistence and command-completion writes rejected | PASS |
| Unresolved consequential operation resumes in verification | Pending checkpoint becomes unknown, run becomes `verifying`, idempotency becomes `unknown` | PASS |
| No duplicate consequential action after restart | Unknown/confirmed reservation verification tests and full Calendar duplicate check | PASS |
| `needs_human` survives restart and can later resume | PostgreSQL state plus API resume integration tests | PASS |
| Scheduler catch-up semantics after downtime | Exact 24-hour boundary and most-recent-missed tests | PASS |
| No replay of every missed occurrence | Multiple-miss test creates only the most recent eligible occurrence | PASS |

All recovery decisions reconstruct exclusively from PostgreSQL state. No test
reuses a prior model session.

## Idempotency, duplicates, and fencing

- Concurrent and repeated scheduler wake-ups create one scheduled run.
- The active-run partial unique index rejects overlap for one automation.
- Consequential retries use durable `(scope, key)` reservations.
- Timeout after a possible side effect becomes `unknown` and does not retry
  unless verification proves absence.
- Calendar duplicate create performs lookup/verification and does not insert a
  second event.
- Browser uncertain submit does not issue a second submit.
- Worker, gateway, run-state, and command writes reject stale lease owners.
- Duplicate human resume returns a safe no-op.

## Completion authority

The deterministic completion validator, not the model, owns success. Tests prove:

| Model says `complete` with... | Expected | Result |
|---|---|:---:|
| no required tool execution | blocked | PASS |
| tool progress without approved evidence | blocked | PASS |
| no required evidence | blocked | PASS |
| unresolved consequential operation | blocked | PASS |
| unresolved idempotency outcome | blocked | PASS |
| confirmed consequential checkpoint and matching evidence | succeeded | PASS |

## Security acceptance

Integrated and regression tests verify:

- credentials and canaries do not enter model context, logs, evidence, or safe
  summaries;
- prompts and full model responses are not persisted;
- OAuth tokens and browser profiles remain worker/adapter-local;
- webpage and email content is untrusted and cannot expand capabilities;
- client schemas reject internal lifecycle/audit fields, credential formats,
  and provider-specific model IDs;
- the deterministic router selects model profiles; the model cannot select its
  profile or invoke provider clients directly;
- all external actions pass through the Tool Gateway;
- production tools contain no Calendar delete, Gmail write, generic
  consequential browser click, shell, Git, or Codex development capability.

The repository audit found no committed secret, native runtime artifact,
coverage-ignore directive, fixed Compose platform, or production Phase 2/3
runtime surface.

## Clean checkout and runtime

An isolated source-only copy excluded `.git`, `node_modules`, build output,
coverage, caches, and local environment files. Acceptance verified:

- `pnpm install --frozen-lockfile` succeeds without generated artifacts;
- tests provision and remove their own PostgreSQL when no test URL is supplied;
- migrations apply to an empty PostgreSQL volume;
- `docker compose up --build -d` starts PostgreSQL, migrate, app, and worker;
- migrate exits 0 and the three steady-state services become healthy;
- `/health` succeeds on loopback and reports OpenAI/Google unavailable safely;
- only `127.0.0.1:3000` is published; PostgreSQL has no host port;
- app, worker, and full-stack restarts return to healthy state.

No host `node_modules`, generated build output, credentials, or prior Docker
volume was present in the isolated source tree/project.

## Portability

- Explicit `linux/amd64` worker image build: PASS.
- Explicit `linux/arm64` worker image build under emulation: PASS.
- ARM64 build installed the target Chromium and its OS dependencies: PASS.
- Compose has no `platform` field and uses multi-architecture official bases.
- No architecture-specific runtime artifact is committed.

## Live-smoke boundary

`pnpm smoke:live` is opt-in and credential-file gated. It is not called by CI or
normal tests. The default path is Gmail read-only, Calendar read-only, and an
optional non-consequential browser open. Calendar write requires a second
explicit flag and a configured test calendar, creates a uniquely marked event,
and cleans it through the test-only delete harness. Uncertain creation or cleanup
reports `UNKNOWN` with manual marker/calendar cleanup instructions.

With credentials absent, the command reported `SKIP` and accessed no account;
this is the expected accepted limitation, not an acceptance failure.

## Quality-gate evidence

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — 150 passed, 3 opt-in Playwright fixtures skipped |
| `pnpm test:coverage` | PASS — exact 100% on all four metrics |
| `pnpm build` | PASS |
| Real PostgreSQL integration | PASS |
| Clean migration from zero | PASS |
| `pnpm --filter @personal-agent/db exec drizzle-kit check` | PASS |
| Deterministic full fixture E2E | PASS |
| Playwright UI/adapter E2E in worker image | PASS — 153/153 |
| `docker compose config --quiet` | PASS |
| `docker compose build` | PASS |
| Isolated `docker compose up --build` and health | PASS |
| App/worker/full-stack restart | PASS |
| `linux/amd64` image build | PASS |
| `linux/arm64` image build | PASS |
| `git diff --check` | PASS |
| Repository secret/scope audit | PASS |

## Defects found and corrected

1. The worker had no durable command-processing loop, so a persisted natural-
   language command could not create an automation. Milestone 7 added a leased,
   fenced command processor, strict automation intent output, transactional
   automation creation/command completion, worker polling integration, and
   regression tests.
2. The completion validator allowed a successful tool observation to satisfy a
   tool-backed workflow without evidence. It now requires evidence from an
   approved tool for every tool-backed completion, while still requiring any
   consequential checkpoint to be confirmed by evidence from that same tool.
   Regression tests prove tool progress alone cannot authorize success.

## Limitations and blockers

- Real OpenAI, Gmail, Calendar, and public browser smoke was intentionally not
  run because credentials were absent and account access was forbidden for this
  milestone. The gated harness was validated in its safe `SKIP` path.
- Direct host Playwright execution could not load `libatk-1.0.so.0`, and the host
  could not install it without an interactive sudo password. The identical full
  suite passed inside the worker image, which is the supported runtime and
  includes all Chromium dependencies.
- There are no Phase 1 blockers and no known Phase 1/Phase 2 correctness blocker.
  Phase 2 and Phase 3 remain not started and not authorized.
