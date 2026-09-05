# Phase 2 Implementation Plan

## Status and authority

This document is the implementation contract for Phase 2 EVOLVE. It refines
execution order and milestone acceptance but does not override
[`design.md`](design.md), accepted ADRs, or Phase 1 guarantees. If a genuine
conflict is found, implementation stops for explicit user direction.

Current status:

| Phase or milestone | Status |
| --- | --- |
| Phase 1 — ACT | **COMPLETE** |
| Phase 2 — EVOLVE | **IN PROGRESS — PHASE 2C IMPLEMENTATION** |
| Phase 2A — Development Harness Spike | **COMPLETE (2026-08-28)** |
| Phase 2B — Independent Reviewer | **COMPLETE** |
| Phase 2C — Autonomous Fix Loop | **IN PROGRESS / IMPLEMENTATION AUTHORIZED** |
| Phase 2D — Auto-Merge + Deploy | **NOT STARTED** |
| Phase 2 Acceptance | **NOT STARTED** |
| Phase 3 — Self-Improvement | **NOT STARTED / NOT AUTHORIZED** |

Phase 2A was separately authorized by the user and completed on 2026-08-28.
Phase 2B was separately authorized and independently accepted at checkpoint
`f51aa91437317b1c9a6f66f4ae510748a9abb0e0`. Its completion does not authorize
Phase 2C. [`phase-2c-bounded-fix-loop.md`](phase-2c-bounded-fix-loop.md) is the
approved governing contract for the explicitly authorized Phase 2C implementation.
Phase 2C authorization does not authorize Phase 2D. Each later milestone requires
separate authorization after review of the preceding milestone. No milestone
passing implicitly starts the next one.

[`implementation-plan.md`](implementation-plan.md) and
[`phase-1-acceptance.md`](phase-1-acceptance.md) remain the historical Phase 1
contract and acceptance record. Phase 2 work must not alter or weaken them.

## Fixed architecture carried into Phase 2

Phase 1 ACT remains the accepted Action Agent Runtime path:

```text
PostgreSQL run state
→ fresh Action Agent execution
→ OpenAI Agents SDK behind project-owned abstractions
→ minimum capabilities
→ Tool Gateway
→ Browser / read-only Gmail / non-deleting Calendar adapters
→ verification and evidence
→ deterministic completion
```

Its PostgreSQL authority, leases, heartbeat and fencing, idempotency,
first-class `unknown` outcomes, deterministic verification, credential
boundaries, and completion policy remain unchanged. Pi neither replaces nor
enters this path.

Phase 2 adds a separate EVOLVE path:

```text
approved DevelopmentTask
→ PostgreSQL development state
→ Development Coordinator
→ Development Context Compiler
→ project-owned DevelopmentHarness
→ Pi adapter
→ Pi Coding Agent SDK
→ project-owned sandbox tools
→ externally isolated development sandbox
→ exact Git candidate revision
→ later review / CI / merge / deployment milestones
```

Authority remains divided as follows:

| Concern | Authority |
| --- | --- |
| Development-task and attempt lifecycle | PostgreSQL |
| Source, base revision, candidate revision, and merged revision | Git |
| Product and architecture intent | `docs/design.md` |
| Explicit architecture changes | Accepted ADRs |
| Approved milestone execution | This plan plus explicit user authorization |
| Mechanical quality evidence | CI and deterministic test tooling |
| Execution mechanics | `DevelopmentHarness`; initially Pi |
| Permissions, budgets, advancement, merge, and deploy decisions | Deterministic project code |

Model sessions, Pi sessions, transcripts, and compaction summaries are
disposable execution context. They never become a source of authority.

## Milestone progression rules

1. Implement only the explicitly authorized milestone.
2. Apply the checked-in greenfield baseline from zero. Before launch, superseded
   development-only migration history may be replaced when the user explicitly
   authorizes it; the baseline must preserve the final schema and invariants.
3. Keep the normal app/worker/PostgreSQL runtime healthy without development or
   external credentials.
4. Stop at the milestone boundary with exact test and acceptance evidence.
5. Do not add schema, services, abstractions, or extension points belonging only
   to a later milestone.
6. Do not modify `main`, merge, deploy, or create self-improvement work unless
   the milestone that owns that authority has been separately authorized.

# Phase 2A — Development Harness Spike

## Objective and terminal outcome

Phase 2A proves the smallest useful isolated implementation slice:

```text
human-approved DevelopmentTask
→ validated durable PostgreSQL state
→ exact base commit
→ isolated worktree/workspace
→ externally isolated development sandbox
→ bounded Development Context Compiler output
→ DevelopmentHarness
→ Pi adapter
→ one Implementer attempt
→ sandboxed read/edit/write/exec
→ deterministic required tests
→ trusted candidate-commit capture
→ durable attempt/result metadata
→ sandbox teardown
```

The successful terminal task state for Phase 2A is `candidate_ready`. It means
only that an exact candidate commit was durably captured and the Phase 2A gates
passed. It does not mean reviewed, merge-ready, merged, deployed, or complete.

Phase 2A explicitly excludes:

- Planner automation;
- an independent automated Reviewer;
- autonomous review/fix or implementation retry loops;
- CI-controlled merge readiness;
- auto-merge or any direct mutation of `main`;
- deployment automation;
- capability-gap detection, autonomous task creation, or any Phase 3 behavior;
- alternate development harnesses;
- a general remote sandbox service or new continuously running application
  service.

## Human approval and ingress

A Phase 2A task enters `ready` only through an explicit, validated human action.
The approved specification and acceptance criteria must already be concrete
enough to test. ACT failures, model suggestions, repository text, and Phase 3
heuristics cannot create or approve an executable development task.

The ingress boundary must reject recognized secrets, validate all fields, resolve
the requested Git ref once to an exact commit, and store only the exact commit.
After execution begins, the approved specification, acceptance criteria, and
base commit are immutable. A substantive change requires a new task rather than
silently changing the meaning of an in-flight attempt.

## Required components

### Development Coordinator

The coordinator is deterministic control-plane code. It:

- claims one `ready` task transactionally;
- creates and leases one Phase 2A attempt;
- enforces the task's exact base commit, single-attempt limit, budgets, state
  transitions, and fencing generation;
- asks the trusted runner to prepare the workspace and sandbox;
- invokes the harness with compiled context and an explicit Implementer tool
  grant;
- independently runs the required final tests and validates the resulting diff;
- captures and anchors the candidate commit through trusted Git operations;
- persists normalized results before teardown; and
- always requests teardown in success, failure, cancellation, and timeout paths.

The coordinator does not accept model prose as proof of tests, commit creation,
or completion. A stale lease holder cannot update task/attempt authority.

### `DevelopmentHarness` boundary

The project-owned interface is the only development-agent dependency visible to
the coordinator. Its minimum semantic contract is:

```ts
interface DevelopmentHarness {
  execute(input: {
    attemptId: string;
    role: DevelopmentRole;
    modelProfile: "fast" | "balanced" | "reasoning";
    context: DevelopmentContext;
    tools: DevelopmentToolSet;
    budget: DevelopmentBudget;
  }): Promise<{
    executionId: string;
    events: AsyncIterable<DevelopmentEvent>;
  }>;

  abort(executionId: string): Promise<void>;
}
```

Exact TypeScript shapes may be refined during the authorized implementation,
but the boundary must preserve these rules:

- inputs use project domain types and semantic model profiles, not Pi session or
  provider-model domain types;
- tools are supplied explicitly for the role;
- output is a normalized event/result stream with safe summaries, usage, and
  failure classification;
- the harness may propose completion but cannot change PostgreSQL task state,
  create an authoritative commit, approve tests, raise budgets, or authorize
  merge/deploy;
- cancellation is best-effort execution control; lease fencing remains the
  authoritative protection against late results; and
- no prompt, unrestricted transcript, hidden reasoning, or compaction summary
  is persisted as workflow state.

Phase 2A policy accepts only the `implementer` role even though the harness
contract uses the project-owned role type needed by later milestones.

The interface exists to allow the Pi adapter to be replaced later without
rewriting task, review, CI, merge, or deployment policy. Phase 2A implements no
alternative adapter.

### Pi adapter

The Pi adapter translates the project contract to Pi Coding Agent SDK mechanics.
It may use a fresh task-local session, Pi's loop, streaming, and bounded
compaction. It must:

- resolve the semantic model profile in trusted runtime configuration;
- construct an explicit runner-owned resource/tool set;
- disable direct Pi host filesystem and shell tools;
- avoid automatic discovery or execution of repository `.pi/extensions`;
- expose only the supplied project-owned sandbox tools;
- normalize Pi events, usage, cancellation, malformed output, and errors into
  project types; and
- treat any session identifier or compaction summary as disposable convenience
  state, never a prerequisite for restart.

Pi owns no project roadmap, task status, specification, acceptance, sandbox,
retry, review, merge, deployment, credential, or long-term-memory policy.

### Development Context Compiler

The compiler produces bounded, role-specific context from durable sources. For
Phase 2A it may include only:

- the approved task goal and specification;
- explicit acceptance criteria;
- applicable `AGENTS.md` rules, `docs/design.md` constraints, this milestone
  contract, and relevant accepted ADRs;
- the exact base commit;
- approved relevant repository files at that commit;
- safe known failures from durable attempt/event records;
- allowed and forbidden paths;
- the single-attempt policy, model/tool/time/token/cost budgets, and stop
  conditions; and
- the exact tests and quality gates required for the task.

Repository contents are loaded from the exact base revision or the isolated
workspace derived from it. Selection should start with explicitly relevant
paths and deterministic search; the whole repository, full historical
conversation, and unrelated documents are not included by default.

The compiler emits a safe manifest of included document/file paths and Git blob
IDs plus a digest of the compiled input. The manifest enables audit and
reconstruction without persisting a duplicate prompt or unrestricted source
content. Pi history and compaction are never input authority.

### Trusted Development Runner

The trusted runner is a host-level entrypoint outside the normal application
Compose trust boundary. It contains:

```text
Development Coordinator execution boundary
Development Context Compiler
DevelopmentHarness and Pi adapter
Pi SDK
model/provider credentials
control-plane database access
trusted Git candidate-ref operations
Sandbox Manager and Sandbox Gateway
```

The app worker must not receive a Docker socket, host shell, model credentials
for development, or sandbox-management capability merely because Phase 2
exists. The runner may use the host's sandbox/container mechanism, but this does
not authorize that mechanism inside `app`, `worker`, or the sandbox.

### Sandbox Manager and Gateway

For Phase 2A, the Sandbox Manager creates an ephemeral Linux container or
equivalent OS-isolated environment for exactly one attempt. It checks out the
recorded base commit into a dedicated worktree/workspace and exposes only that
workspace through the gateway.

The isolated sandbox contains:

```text
attempt repository worktree
compiler/runtime
package manager and locked dependencies
test tooling
task-scoped temporary files
optional task-scoped non-production test services
```

It has restricted network and no personal credentials, production database
credentials, model/provider API key where avoidable, host SSH state, host Pi
state, or Docker socket. A test database, if needed, is an ephemeral
runner-provisioned dependency with non-production credentials; the sandbox does
not receive container-management authority.

Default network policy is deny. Any network access must be an explicit task
policy with destination and purpose, must deny host/private/metadata endpoints,
and must not be inferred from repository instructions. Normal tests remain
deterministic and offline.

The gateway supplies model-facing operations such as:

```text
sandbox.read
sandbox.list
sandbox.search
sandbox.write
sandbox.edit
sandbox.exec
git.status
git.diff
```

The gateway contract requires:

- normalized workspace-relative paths;
- rejection of absolute paths, traversal, symlink escapes, device files, and
  access outside the approved workspace;
- a fixed workspace working directory and a minimal sanitized environment;
- argument-vector or otherwise policy-safe command execution, with command,
  duration, output, process, and resource limits;
- explicit executable/command policy suitable for build and test commands;
- no generic path from sandbox execution to host execution;
- typed input/output validation and size bounds; and
- safe audit events for every call without file contents, secrets, raw command
  output, or unrestricted diffs in persistent summaries.

The model is not given `git commit`, `git push`, merge, deployment, container,
credential, or account tools. Trusted runner code owns candidate capture.

## Exact Git and candidate handling

Every task and attempt is bound to an immutable exact base commit. Workspace
creation verifies `HEAD == base_commit` before execution. The agent never writes
to `main` and cannot change the recorded base.

After the harness stops, the trusted runner:

1. fences the attempt and stops accepting model tool calls;
2. runs the required tests independently of the model's claims;
3. rejects forbidden paths, submodule/worktree escapes, secrets, native build
   artifacts, and an empty or out-of-scope diff;
4. creates one candidate commit whose parent is the exact base commit;
5. anchors it under a trusted attempt-specific Git ref such as
   `refs/personal-agent/development-attempts/<attempt-id>`;
6. verifies that the commit and ref resolve to the same object; and
7. transactionally records the candidate commit/ref before reporting
   `candidate_ready`.

The trusted ref must exist before sandbox teardown so Git, not the disposable
worktree, retains revision truth. Phase 2A never pushes, merges, rebases, or
deploys the candidate.

## Minimal durable Phase 2A data model

Phase 2A adds only `development_tasks`, `development_attempts`, and the
append-only `development_attempt_events` required for safe reconstruction and
audit. Reviewer, CI, merge, deployment, and self-improvement tables wait for
their owning milestones.

### `development_tasks`

| Field | Why required now |
| --- | --- |
| `id` | Stable PostgreSQL identity for the approved task. |
| `title` | Short secret-safe human label for inspection. |
| `approved_spec` | Immutable human-approved implementation contract used to reconstruct context. |
| `acceptance_criteria` | Validated explicit criteria used by tests and final candidate checks. |
| `status` | Authoritative task lifecycle and eligibility for deterministic advancement. |
| `base_commit` | Exact immutable Git revision from which every Phase 2A workspace is created. |
| `approved_at` | Proof that explicit approval preceded execution eligibility. |
| `created_at` | Audit ordering and age. |
| `updated_at` | Safe concurrency/status projection for user inspection. |

Allowed Phase 2A task states are `ready`, `preparing`, `implementing`,
`testing`, `candidate_ready`, `blocked`, `failed`, and `cancelled`. No state is
named `reviewed`, `merge_ready`, `merged`, `deployed`, or `completed`.

The ordinary task path is `ready → preparing → implementing → testing →
candidate_ready`. Any non-terminal state may enter `blocked`, `failed`, or
`cancelled` only through an explicit deterministic transition.

### `development_attempts`

| Field | Why required now |
| --- | --- |
| `id` | Stable identity for one isolated execution attempt. |
| `task_id` | Restrictive foreign key to its authoritative task. |
| `attempt_number` | Enforces unique ordered attempts and the Phase 2A single-attempt limit. |
| `role` | Audits capability policy; Phase 2A permits only `implementer`. |
| `status` | Authoritative attempt lifecycle for recovery and terminal handling. |
| `harness_adapter` | Historical execution metadata; Phase 2A records `pi` without making it task policy. |
| `model_profile` | Approved semantic routing profile; concrete provider IDs do not become domain policy. |
| `base_commit` | Defensively binds this attempt and its workspace to the task's exact base. |
| `candidate_commit` | Exact Git result, nullable until a verified candidate is durably anchored. |
| `candidate_ref` | Trusted Git ref that keeps the candidate reachable after teardown. |
| `sandbox_id` | Opaque, secret-safe identity used for cleanup and reconciliation. |
| `context_manifest` | Validated paths/blob IDs used to reconstruct what durable sources were selected. |
| `context_digest` | Detects unintended context changes without storing prompts or transcripts. |
| `budget` | Validated immutable invocation, wall-clock, token, cost, tool-call, and exec limits. |
| `usage` | Validated counters used for deterministic budget enforcement and audit. |
| `lease_owner` | Identifies the currently authorized trusted runner. |
| `lease_expires_at` | Enables crash detection and reclamation. |
| `lease_generation` | Fences late writes and tool results from a stale runner. |
| `failure_class` | Normalized terminal/recovery classification without raw sensitive output. |
| `safe_summary` | Bounded secret-safe result useful after session and sandbox loss. |
| `started_at` | Establishes wall-clock budget and audit timing. |
| `completed_at` | Records terminal attempt timing. |
| `created_at` | Durable creation ordering. |
| `updated_at` | Safe status projection and concurrency support. |

`budget` and `usage` are runtime-schema-validated JSON only to keep related
provider-neutral counters atomic; arbitrary unvalidated JSON is forbidden.
Concrete provider model IDs may appear only in safe historical invocation-event
metadata, never in the task's model policy.

Allowed Phase 2A attempt states are `preparing`, `implementing`, `testing`,
`capturing_candidate`, `succeeded`, `interrupted`, `failed`, and `cancelled`.
`succeeded` means the attempt produced the candidate recorded on its task; it
does not mean the software change is accepted.

The ordinary attempt path is `preparing → implementing → testing →
capturing_candidate → succeeded`. An expired execution may enter `interrupted`;
it may return to `preparing` within the same attempt only after fenced recovery
verifies an intact exact-base workspace and remaining budgets. It may not create
a second attempt automatically.

### `development_attempt_events`

| Field | Why required now |
| --- | --- |
| `id` | Stable append-only event identity. |
| `attempt_id` | Restrictive foreign key to the affected attempt. |
| `sequence` | Deterministic per-attempt ordering with a unique constraint. |
| `kind` | Typed transition, harness, tool, test, Git, budget, or teardown event class. |
| `status` | Normalized `started`, `success`, `failed`, `unknown`, or `blocked` outcome. |
| `safe_metadata` | Validated bounded metadata needed for audit/recovery without raw content or reasoning. |
| `created_at` | Durable event time. |

Events record tool name, duration, normalized outcome, failure class, budget
delta, and relevant safe identifiers. They do not store prompts, transcripts,
hidden reasoning, unrestricted model output, complete source/diffs, environment
variables, credentials, or raw build/test output.

Required constraints include one initial attempt per task, unique
`(task_id, attempt_number)`, unique `(attempt_id, sequence)`, exact commit-format
validation, restrictive historical
foreign keys, and transactional/fenced task-attempt transitions. Candidate
fields may become non-null only together after the trusted Git ref verifies.

Use existing database conventions: application-generated UUIDs, PostgreSQL
`timestamptz`, checked text status values, positive integer attempt/lease
counters, full Git object IDs rather than short refs, and Zod-validated `jsonb`
for acceptance criteria, manifests, budgets, usage, and safe metadata.

## Budgets and stop conditions

Phase 2A performs exactly one implementation attempt. Before execution, the
human-approved or deterministic configuration fixes:

- maximum implementation attempts (`1`);
- maximum model invocations;
- maximum total input/output tokens;
- maximum cost;
- maximum attempt wall-clock duration;
- maximum tool calls;
- maximum sandbox command duration and output;
- maximum workspace/diff size; and
- cancellation and terminal failure conditions.

The coordinator and gateway count usage; the model and Pi adapter cannot raise,
reset, or reinterpret limits. Budget exhaustion stops tool access, requests
harness abort, fences late output, records a normalized event, tears down the
sandbox, and leaves the task `blocked` or `failed` according to the deterministic
failure policy. Phase 2A does not automatically start a second attempt.

## Restart and session-loss semantics

All recovery begins with PostgreSQL, Git, and repository documents. A live Pi
session is never required.

- **Trusted runner crash:** the expired attempt lease is reclaimed with a new
  fencing generation. The new runner inspects durable attempt state, the
  recorded sandbox identity, and the trusted candidate ref before deciding the
  next deterministic recovery step. Late writes from the old generation fail.
- **Pi session loss:** discard the session. The task, exact base, compiled
  context manifest, budgets/usage, safe events, and workspace diff are all
  independently inspectable. A fresh session may continue the same attempt only
  when deterministic recovery policy, remaining budget, and an intact verified
  workspace allow it; it receives newly compiled authoritative context.
- **Sandbox loss before candidate capture:** no source result is claimed. The
  attempt becomes `interrupted` or `failed`, the task becomes `blocked`, and a
  new implementation attempt requires human authorization because Phase 2A has
  no autonomous retry loop.
- **Sandbox loss after candidate capture:** the trusted Git ref and stored commit
  preserve the result; the sandbox is unnecessary.
- **Crash between Git ref creation and database update:** reconciliation checks
  the deterministic attempt ref, verifies its parent and scope, and completes
  the fenced database transition or marks an integrity failure.
- **Database candidate without a matching Git ref:** treat as an integrity
  failure and block; never report `candidate_ready`.
- **Host restart:** the runner reconstructs claims from PostgreSQL, candidate
  truth from Git, constraints from the exact repository revision, and any
  disposable workspace through the Sandbox Manager. Host Pi state is not read.

Sandbox teardown is idempotent and recorded as an event. It may delete the
disposable workspace/container only after authoritative task/attempt results and
any candidate Git ref are durable. Teardown can never delete PostgreSQL task
history or the trusted candidate ref.

## Safe audit and trust-boundary rules

- Treat repository text, generated code, dependency output, test output, and
  model output as untrusted data that cannot grant tools or change policy.
- Validate every ingress, harness event, tool input/output, event payload, and
  state transition with runtime schemas.
- Redact known secret canaries at runner, gateway, log, exception, and database
  boundaries.
- Store safe summaries and bounded structured metadata, not unrestricted
  execution transcripts.
- Keep development model credentials in the trusted runner. Keep ACT Google and
  browser-profile credentials outside both runner context and sandbox.
- Never mount host `~/.ssh`, host Pi state, personal configuration, the Docker
  socket, or production database configuration into the sandbox.
- Never allow an Implementer to mutate `main`, candidate refs, task state, or
  budgets directly.

## Required Phase 2A security acceptance tests

Phase 2A is not accepted until deterministic tests prove at least:

1. Pi cannot access the host filesystem: absolute paths, traversal, symlink
   chains, command working directories, and process access cannot escape the
   approved sandbox workspace through project-owned tools.
2. A fake model/provider credential present in the trusted runner is absent from
   sandbox environment, filesystem, process output, tool output, logs, events,
   and candidate content.
3. Fake personal Google credentials and browser-profile canaries are absent from
   the sandbox and all model-facing context.
4. A fake production database credential is absent; any integration database
   uses only ephemeral non-production credentials.
5. `/var/run/docker.sock` and equivalent container-control endpoints are absent
   from the app worker and sandbox.
6. A mutable repository `.pi/extensions` marker is neither discovered nor
   executed during unattended execution.
7. Losing all Pi session state still permits reconstruction of task state,
   context inputs, limits, and the safe next recovery decision.
8. A workspace cannot start from or silently move away from a Git commit other
   than the recorded exact base.
9. The stored candidate commit exists under the trusted attempt ref, has the
   exact base as parent, and remains available after sandbox teardown.
10. Sandbox teardown removes only the attempt workspace/container and does not
    erase PostgreSQL task/attempt/event state or the trusted candidate ref.
11. A stale lease generation cannot persist tool results, candidate metadata, or
    task transitions after reclamation.
12. The Implementer cannot call commit, push, merge, deploy, host-shell,
    credential, account, or container-management operations.

Use fake canary values only. Normal tests must not access OpenAI, Google, public
websites, personal accounts, or uncontrolled external services.

## Phase 2A quality gates

Before Phase 2A can be reported complete, run and report exact results for:

- `pnpm lint`;
- `pnpm typecheck`;
- `pnpm test`;
- `pnpm test:coverage` with exactly 100% statements, branches, functions, and
  lines for all production-owned executable code;
- `pnpm build`;
- PostgreSQL integration and concurrency/fencing tests;
- all migrations from an empty database;
- `pnpm --filter @personal-agent/db exec drizzle-kit check`;
- Docker Compose/config/build/runtime validation wherever affected;
- explicit `linux/amd64` portability validation;
- explicit `linux/arm64` portability validation;
- `git diff --check`; and
- a repository secret, credential, generated-artifact, coverage-exclusion,
  trust-scope, and Phase 2/3 authorization audit.

No coverage exclusion or ignore directive may be added to satisfy the gate.
Tests must cover validation failures, claims and fencing, budget exhaustion,
cancellation, crash points, candidate capture ordering, sandbox cleanup, and all
security invariants above.

## Phase 2A acceptance and stop boundary

Phase 2A passes only when one explicitly approved small task can produce a
tested, exact, durable candidate commit from an exact base through the
project-owned harness and isolated sandbox, while session loss, crash recovery,
credential isolation, scope enforcement, teardown, and every quality gate are
proven.

At acceptance, stop. The candidate must not be automatically reviewed, retried,
merged, or deployed. Record exact evidence and request separate authorization
for Phase 2B.

## Phase 2A completion record — 2026-08-28

Phase 2A is **COMPLETE** and stops at `candidate_ready`. The implemented slice
contains only the three approved durable entities, one fenced Implementer
attempt, the project-owned `DevelopmentHarness`, the Pi adapter, bounded context
compilation, the host-level one-shot runner, Docker-isolated sandbox tools,
trusted Git candidate capture, deterministic checks, reconciliation, and
teardown.

Durable and security evidence includes:

- clean PostgreSQL migrations create `development_tasks`,
  `development_attempts`, and append-only `development_attempt_events`, with no
  Reviewer, CI, merge, deployment, capability-gap, or self-improvement tables;
- exact base/candidate commits and the trusted attempt ref survive worktree and
  container teardown;
- transactional claim, heartbeat, generation fencing, stale-runner rejection,
  expired-attempt recovery, Pi-session loss, sandbox loss, and the Git-ref/DB
  crash window are covered by deterministic PostgreSQL and Git integration
  tests;
- a complete approved small-task fixture reaches `candidate_ready` through the
  fake deterministic harness transport and the real no-network Docker sandbox;
- the sandbox proves path/symlink/device/command isolation and absence of model,
  Google, production-database, Docker-socket, SSH, and host Pi canaries;
- Pi uses an in-memory task-local session, an explicit runner-owned resource
  loader with project context/extensions/skills/prompts/themes disabled, no
  built-in host tools, and only the eight approved project-owned tools; and
- ACT packages/tool resolution are unchanged, and credential-free Compose
  startup plus restart recovery remain healthy.

Final quality evidence:

- `pnpm install --frozen-lockfile`: pass;
- `pnpm lint`: pass;
- `pnpm typecheck`: pass;
- `pnpm test`: 187 passed, 3 skipped opt-in tests;
- `pnpm test:coverage`: exactly 100% statements (2287/2287), branches
  (1483/1483), functions (570/570), and lines (2046/2046);
- `pnpm build`: pass;
- empty-database migrations, PostgreSQL integration/concurrency/fencing, and
  `drizzle-kit check`: pass;
- sandbox/security integration, Docker Compose config/build/runtime, migration
  exit 0, credential-free health, and restart recovery: pass;
- development-sandbox image builds and inspects as both `linux/amd64` and
  `linux/arm64`;
- `git diff --check` and the secret/generated-artifact/coverage-exclusion/
  trust-scope/Phase 2B-3 authorization audits: pass.

Normal acceptance uses no OpenAI/Pi provider account, Google account, public
website, or personal data. A live provider smoke run remains explicit,
credential-gated, and non-blocking as approved. There are no Phase 2A blockers.
Phase 2B remains **NEXT / NOT STARTED / NOT AUTHORIZED**.

# Phase 2B — Independent Reviewer

## Contract

Phase 2B adds only:

```text
exact candidate commit
→ fresh isolated Reviewer execution
→ structured APPROVE or REQUEST_CHANGES
→ durable review bound to that exact commit
```

The Reviewer uses a new sandbox and fresh harness/session. Its authoritative
inputs are the approved specification and criteria, architecture rules, exact
candidate commit/diff, relevant source, and deterministic test evidence. It does
not receive the Implementer transcript, session, compaction, or self-assessment
as authority.

Reviewer tools are read-only repository operations plus approved sandboxed test
execution. The Reviewer cannot edit the candidate, create a new candidate,
merge, or deploy. Its result uses a strict schema containing the decision and
actionable findings with severity and acceptance/architecture references.

This milestone may add the minimal `development_reviews` state required to bind
the Reviewer attempt, decision, and findings to the exact candidate commit. A
changed candidate invalidates the review. Reviewer `APPROVE` is evidence, not
merge authority, and Phase 2B includes no autonomous fix/retry loop.

The trusted DevelopmentHarness/control plane establishes that the external
Reviewer execution occurred. PostgreSQL preserves its validated lifecycle,
context, proposal, cleanup, and exact-candidate bindings; it does not attest an
external model invocation against an actor able to forge a complete semantically
valid history across every trusted persistence table. Such unrestricted trusted
write authority is outside the Phase 2B threat model. Malformed state submitted
through normal trusted repository APIs and inconsistent direct durable
transitions remain in scope and must fail closed.

Acceptance proves reviewer independence, read-only enforcement, structured and
durable findings, exact candidate binding, session-loss reconstruction, and all
repository quality gates. Stop for separate Phase 2C authorization.

## Phase 2B completion record

Phase 2B was independently accepted at exact checkpoint
`f51aa91437317b1c9a6f66f4ae510748a9abb0e0` after one authoritative independent
review of one exact `candidate_ready` revision. The implementation adds no fix
loop, CI acceptance, merge, push, deployment, task generation, or later-phase
authority.

Durable and trust-boundary evidence includes:

- `development_reviews` records one fenced Reviewer attempt per task, the exact
  implementation attempt/candidate commit/ref, immutable context manifest,
  complete bounded read/source policy and digest, bounded semantic model policy
  and usage, strict decision/findings, safe summary, cleanup state, and
  finalization state;
- captured implementation candidate provenance is PostgreSQL-immutable, and
  authoritative lookup joins the current task, implementation attempt, and
  finalized review so blocked or inconsistent authority fails closed;
- append-only `development_review_events` records safe transition, harness,
  tool, check, integrity, cleanup, and finalization audit evidence;
- PostgreSQL constraints and triggers bind every review to the exact succeeded
  Phase 2A implementation candidate, protect immutable policy/context/proposal
  fields, enforce the Reviewer lifecycle and runtime-equivalent budget/usage/
  policy/manifest/finding structure in both pending and terminal rows, reject
  fabricated terminal approval, require mandatory finding traceability, and
  prevent review-history deletion or event mutation;
- the Reviewer uses a fresh in-memory Pi session and receives only durable task
  specification, criteria, base/candidate revisions, exact diff, bounded source,
  governing authority blobs, deterministic Phase 2A test evidence, and its own
  role budget—never Implementer session, transcript, compaction, hidden
  reasoning, self-assessment, or safe summary;
- Reviewer tools are explicitly limited to bounded read/list/search, trusted
  status/exact diff, approved criterion-ID checks, and one strict terminating
  result submission; no write/edit/arbitrary command/Git mutation/merge/deploy
  capability is granted;
- `APPROVE` requires zero findings and `REQUEST_CHANGES` requires at least one
  fully structured finding with severity, category, finding, required
  correction, optional relevant path, acceptance criterion ID, and architecture
  reference. Criterion IDs resolve to the approved task, architecture anchors
  resolve to a supplied governing Markdown heading, and relevant paths resolve
  to exact candidate blobs inside the durable Reviewer scope;
- authoritative success is persisted only after exact candidate/context
  re-verification, proposal audit, idempotent sandbox/worktree cleanup, cleanup
  audit, and one transactional finalization; non-final rows are never returned
  by the authoritative-review lookup;
- PostgreSQL time exclusively creates, renews, expires, and replaces Reviewer
  leases. Every authoritative operation locks first and then evaluates
  `clock_timestamp()`; a transaction that waited past expiry cannot renew or
  finalize, expired leases increment fencing generation, and stale writes fail.
  Recovery uses PostgreSQL/Git/documents only and never resumes or invokes Pi.
  Every nonterminal review remains reclaimable after cleanup is pending, failed,
  or already succeeded, and successful cleanup is not repeated;
- architecture headings receive deterministic unique anchors within each exact
  governing blob (`contract`, `contract-1`, `contract-2`, and so on), including
  fenced-code exclusion, and the immutable manifest is the durable catalog used
  by PostgreSQL finding validation;
- every review records a deterministic review-specific Git retention ref that
  keeps the PostgreSQL-authoritative candidate commit reachable without making
  the mutable ref an identity input; corrupt or unavailable retention fails
  reconstruction closed; and
- deterministic tests cover both decisions, malformed/missing/unsafe evidence,
  mandatory traceability, candidate/ref/context changes, read-only and command
  policy, tracked mutation, provider/budget/timeout failure, competing claims,
  stale fencing, duplicate persistence, persistence/audit/finalization failure,
  cleanup retry, crash after durable cleanup, candidate-ref deletion and Git GC,
  retention corruption/loss, durable policy reconstruction, session loss,
  exact-candidate non-transferability, forced PostgreSQL finalizer/recoverer and
  competing-recoverer lock contention, exactly-once terminal finalization, and
  the absence of automatic fix/merge/deploy behavior. Existing Phase 2A and ACT
  suites remain passing.

Final quality evidence:

- `pnpm install --frozen-lockfile`: pass;
- `pnpm lint`: pass with zero warnings;
- `pnpm typecheck`: pass;
- `pnpm test`: 218 passed, 3 skipped opt-in tests;
- `pnpm test:coverage`: exactly 100% statements (2830/2830), branches
  (1834/1834), functions (664/664), and lines (2551/2551);
- `pnpm build`: pass;
- the single greenfield `0000_baseline` migration, clean-database application
  to 13 tables, PostgreSQL integration/concurrency/fencing, and
  `drizzle-kit check`: pass;
- sandbox/security tests, Docker Compose config/build/runtime, migration exit 0,
  credential-free app/worker health, and full runtime restart recovery: pass;
- the development-sandbox target builds and inspects as both `linux/amd64` and
  `linux/arm64`;
- `git diff --check` and secret/generated-artifact/coverage-exclusion/
  trust-scope/Phase 2C-3 authorization audits: pass.

Validation used Node 22.19.0 and no OpenAI/Pi provider account, Google account,
public website, personal data, merge credential, or deployment credential.
Final independent acceptance decision: **APPROVE**. There were no Blocking,
Major, or Minor findings; the final invalidation finding was resolved; regression
status passed with 218 tests passing and 3 opt-in tests skipped; coverage was
exactly 100% for statements, branches, functions, and lines; and Node 22.19.0
validation passed. No Phase 2C, merge, push, deployment, or Phase 3 authority was
present during acceptance.

Phase 2C implementation is explicitly authorized and in progress. It is not
complete until independent acceptance occurs.

# Phase 2C — Autonomous Fix Loop

[`phase-2c-bounded-fix-loop.md`](phase-2c-bounded-fix-loop.md) is the governing
contract for the authorized implementation. Phase 2C remains **IN PROGRESS** and
must not be marked complete by its Implementer session.

## Contract

Phase 2C adds the bounded loop:

```text
implement
→ deterministic tests
→ independent review
→ durable findings
→ bounded fresh fix attempt
→ deterministic tests
→ independent review
```

Every fix creates a new durable implementation attempt and exact candidate
commit. Every review is fresh and bound to that candidate. Deterministic policy,
not either model, controls:

- maximum total implementation attempts;
- maximum review/fix cycles;
- maximum model invocations;
- token and cost budgets;
- attempt and total wall-clock timeouts;
- tool/command limits;
- infrastructure and CI retry counts where applicable; and
- terminal failure classes and `BLOCKED` conditions.

No failure automatically becomes another model call. Architecture ambiguity,
exhausted budgets, repeated findings, unsafe/unknown infrastructure outcomes,
and non-actionable review conflict enter durable `BLOCKED` or `NEEDS_HUMAN`
state. Limits are immutable to the model and cannot reset between sessions.

Phase 2C includes neither merge nor deployment. Acceptance proves finite loops,
durable attempt/review history, candidate-specific reviews, correct budget
accounting across restarts, deterministic terminal `BLOCKED`, and no long-lived
session dependency. Stop for separate Phase 2D authorization.

# Phase 2D — Auto-Merge and Deploy

## Contract

Phase 2D may advance an exact candidate only when all applicable predicates are
true:

```text
approved specification is still current
+ exact immutable candidate revision
+ independent Reviewer = APPROVE for that revision
+ CI = PASS for that revision
+ lint = PASS
+ typecheck = PASS
+ build = PASS
+ required unit/integration/E2E/migration/portability checks = PASS
+ exactly 100% statements/branches/functions/lines coverage
+ no unresolved blocking finding
+ deterministic merge policy authorizes automation
→ merge exact revision
→ deploy exact merged revision
→ verify migrations, health, and deployed revision
```

This milestone may add only the minimal CI-validation, merge, and deployment
records necessary to bind evidence to exact commits and recover after restart.
The merge gate must re-check current task/specification and repository state at
the moment of merge. A model decision or Reviewer approval alone is never
sufficient.

Merge and deployment run in trusted infrastructure outside coding-model and
application-container authority. Coding models receive no merge token,
deployment credential, host shell, Docker socket, or direct `main` access.

Deployment follows the exact merged revision through checkout, build, Compose
apply, migration/result checks, health checks, and deployed-revision
confirmation. Process/container startup alone is not success. Failure becomes
durable state with a deterministic recovery decision; it does not silently claim
completion or trigger unbounded model work.

Acceptance proves the model cannot bypass review/CI/coverage/merge policy,
cannot substitute a different commit after approval, and cannot declare deploy
success without exact revision and health evidence. Stop for integrated Phase 2
Acceptance.

# Phase 2 Acceptance

Phase 2 receives a durable acceptance record analogous to Phase 1. The
integrated acceptance must prove that one approved small software change travels
through:

```text
approved specification
→ durable DevelopmentTask
→ exact base commit
→ isolated implementation
→ deterministic tests
→ exact durable candidate commit
→ fresh independent review
→ bounded correction when required
→ CI on the exact candidate
→ deterministic merge gate
→ merge of the approved revision
→ direct deployment of the exact merged revision
→ migration/result, health, and deployed-revision verification
```

The acceptance record must map every Phase 2 Definition of Done criterion in
`docs/design.md` to implementation and exact test/evidence. It must include
crash/restart at each consequential boundary, lost Pi sessions, lost sandboxes,
stale leases, budget exhaustion, review independence, changed-candidate
invalidation, CI failure, merge denial, deploy failure, credential canaries,
sandbox escape attempts, and both target architectures.

The full path must have no dependency on long-lived model sessions, no
unrestricted transcript as authority, no coding-model merge/deploy authority,
and no violation of host, sandbox, account, Docker, or credential boundaries.
Phase 2 is not complete until that record is accepted explicitly by the user.

# Phase 3 boundary

Phase 3 remains **NOT STARTED / NOT AUTHORIZED** before and after all planning in
this document. Phase 2 code must not detect capability gaps for autonomous task
creation, translate runtime failures into self-directed development work, or
bypass human-owned product direction. A future Phase 3 authorization may
propose work only through the already accepted Phase 2 controls.
