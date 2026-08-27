# Personal Autonomous Agent Platform
## Design & Implementation Contract — Revision 3

**Status:** ARCHITECTURE SOURCE OF TRUTH  
**Revision:** v3 — ACT runtime preserved; EVOLVE runtime redesigned around a project-owned Development Harness with Pi as the initial coding-agent harness  
**Primary user:** Single-user personal system  
**Operating mode:** Active development, automation-first, direct-to-production after deterministic quality gates  
**Progress tracking:** Phase 1 history belongs in `docs/implementation-plan.md` and Phase 2 execution status belongs in `docs/phase-2-implementation-plan.md`; this document defines product intent, architecture, invariants, and phase boundaries.

---

# 1. Executive Summary

The project is a **Personal Autonomous Agent Platform** with three first-class capabilities:

1. **THINK** — research, reason, discuss, plan, and help the user make decisions.
2. **ACT** — execute real-world workflows through controlled tools such as Browser, Gmail, Google Calendar, APIs, and scheduled automations.
3. **EVOLVE** — implement, review, test, merge, deploy, and later propose software changes that improve the platform itself.

The platform is not a single long-lived chat session. Durable state lives in PostgreSQL, Git history, repository documentation, ADRs, automation definitions, workflow checkpoints, tool-call/evidence records, development-task records, and CI/deployment records.

Model sessions are temporary compute. They may be created, compacted, resumed for a bounded task, abandoned, or lost without becoming the authoritative source of workflow state.

The system has one governing rule:

> **Models provide intelligence. Deterministic control-plane code owns authority, persistence, permissions, verification, success criteria, retries, merge policy, and deployment policy.**

Revision 3 introduces a second execution harness for software development:

- **ACT Runtime:** the existing controlled action-agent runtime using the OpenAI Agents SDK behind project-owned interfaces and the Tool Gateway.
- **EVOLVE Runtime:** a project-owned `DevelopmentHarness` abstraction whose first implementation uses the **Pi Coding Agent SDK** for coding-agent sessions, context compaction, model interaction, and agent-loop mechanics.

Pi does **not** replace the ACT runtime and does **not** become the platform control plane.

---

# 2. Fixed Architectural Decisions

The following decisions are normative and may not be silently changed by an implementation agent.

## 2.1 Product and Runtime Scope

- Single trusted user.
- TypeScript-first monorepo.
- PostgreSQL is the durable workflow authority.
- Git is the source-code history authority.
- Repository documentation and ADRs are architecture/product authority.
- The user owns vision, goals, preferences, subjective judgment, and major product direction.
- Models never own credentials, permissions, scheduling, workflow state, retry policy, completion criteria, merge policy, or deployment policy.
- Phase 1 ACT remains independent from the Phase 2 development harness.
- Direct-to-production is acceptable after the development pipeline is proven and deterministic quality gates pass.
- No mandatory staging or canary environment initially.

## 2.2 Infrastructure Restraint

Do not add any of the following without a concrete, demonstrated limitation:

- Redis;
- Temporal;
- Kafka;
- Kubernetes;
- LangGraph;
- a general-purpose workflow framework;
- an enterprise observability platform;
- a large microservice decomposition;
- a multi-agent “society” framework.

Use ordinary TypeScript state machines plus PostgreSQL until a real requirement proves insufficient.

## 2.3 Quality

Owned executable code has a hard merge gate of:

```text
Statements: 100%
Branches:   100%
Functions:  100%
Lines:      100%
```

Coverage is necessary but not sufficient. Tests must assert meaningful behavior and system invariants.

## 2.4 Framework Encapsulation

External frameworks and providers sit behind project-owned interfaces.

Current intended mappings:

```text
ActionAgentRuntime      -> OpenAI Agents SDK
DevelopmentHarness     -> Pi Coding Agent SDK
BrowserAdapter         -> Playwright
GmailAdapter           -> Google Gmail API
CalendarAdapter        -> Google Calendar API
Persistence            -> PostgreSQL + Drizzle
CI                     -> GitHub Actions
Deployment             -> Git + Docker Compose
```

No framework is allowed to become the durable domain model.

---

# 3. Product Vision

The desired product behaves like a persistent personal operator.

Examples:

```text
"Every day, check whether a suitable evening SUA course has opened.
If it has, register me, verify the registration, and add it to Calendar."

"Monitor this collectible and only notify me when the long-term entry is attractive."

"Every morning, check whether the investment thesis materially changed."

"This browser workflow keeps failing. Propose a dedicated adapter."

"Add a new product feature to the personal agent."
```

The system classifies requests into domains such as:

```text
QUERY
ACTION
AUTOMATION_CREATE
AUTOMATION_UPDATE
PLANNING_DISCUSSION
PRODUCT_CHANGE
DEVELOPMENT_FIX
SYSTEM_COMMAND
```

The user should not need to manually manage cron syntax for ordinary requests, long-lived LLM sessions, coding-agent context, worktrees, review sessions, CI retries, routine merges, or routine deployments.

---

# 4. Core Principles

## 4.1 Persistent State, Disposable Sessions

No workflow depends on a model remembering prior turns.

```text
durable state
    ↓
compile bounded context
    ↓
fresh execution
    ↓
reason / act
    ↓
persist validated result
    ↓
session may end
```

If a process or model session disappears, a new execution reconstructs the workflow from durable state.

## 4.2 Intelligence Is Not Authority

A model may propose a tool call, a plan, code, a review finding, completion, or a development task.

Deterministic code decides whether the action is allowed, whether it is authorized for this run, whether it has already happened, whether the current executor still owns the lease, whether external success is proven, whether retry is safe, whether a run is complete, whether code may merge, and whether a deployment is accepted.

## 4.3 Semantic Ownership Remains Human/Deterministic

AI may propose specifications, architecture, tests, and policies, but it may not silently redefine user-owned invariants or acceptance semantics.

Autonomous implementation begins only when the governing constraints are explicit enough to verify mechanically or have been explicitly approved by the user.

## 4.4 Existing Primitive Before Custom Infrastructure

Use maintained libraries for generic mechanics.

Build custom code for the platform-specific value:

- personal state;
- durable policies;
- domain workflows;
- context selection;
- tool permission rules;
- completion validators;
- development-task policy;
- independent review policy;
- self-improvement policy.

---

# 5. High-Level Architecture

```text
                                  USER
                                   │
                                   ▼
                           Chat / Command UI
                                   │
                                   ▼
                              Intent Router
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
              THINK               ACT               EVOLVE
                │                  │                  │
                │                  │                  ▼
                │                  │          Development Coordinator
                │                  │                  │
                └──────────┬───────┘                  │
                           ▼                          │
                    CONTROL PLANE                    │
                           │                          │
          ┌────────────────┼────────────────┐         │
          │                │                │         │
      Scheduler       State/Leases      Policies      │
      Model Router    Idempotency       Budgets       │
      Completion      Audit/Evidence    Recovery      │
          │                                             │
          ├──────────────────────────────┐              │
          ▼                              ▼              ▼
  ACTION AGENT RUNTIME              TOOL GATEWAY   DEVELOPMENT HARNESS
  OpenAI Agents SDK                      │              │
  fresh execution                         │              ▼
          │                               │          Pi Adapter
          │                       ┌───────┼───────┐      │
          │                       ▼       ▼       ▼      ▼
          │                    Browser  Gmail  Calendar  Pi SDK
          │                                             │
          │                                      custom sandbox tools
          │                                             │
          │                                             ▼
          │                                    ISOLATED DEV SANDBOX
          │                                    repo/worktree only
          │                                             │
          └─────────────────────────────────────────────┘
```

The two agent runtimes share the same control philosophy but have different threat models.

---

# 6. Technology Stack

| Area | Decision |
|---|---|
| Language | TypeScript |
| Runtime | Pinned Node.js LTS/current project version |
| Package manager | pnpm workspaces |
| Web app | Next.js + React + TypeScript |
| Main worker | Plain Node.js TypeScript |
| Database | PostgreSQL |
| ORM/migrations | Drizzle ORM |
| ACT agent harness | OpenAI Agents SDK behind internal abstraction |
| EVOLVE development harness | Project-owned `DevelopmentHarness`; initial adapter: Pi Coding Agent SDK |
| Runtime schemas | Zod |
| Browser automation | Playwright |
| Gmail / Calendar | Official Google APIs |
| Unit/integration tests | Vitest |
| Browser/E2E tests | Playwright |
| CI | GitHub Actions |
| Local runtime | Docker Compose |
| Development isolation | Ephemeral container/VM-style sandbox managed outside the app Compose trust boundary |
| Source control | Git + GitHub |

TypeScript is preferred for orchestration. Python may be introduced later only when a domain workload clearly benefits, such as quant research or scientific computing.

---

# 7. Sources of Truth

Authority is deliberately split:

```text
PostgreSQL
= workflow truth

Git
= source-code and revision truth

docs/design.md
= architecture/product truth

docs/implementation-plan.md
= completed Phase 1 execution contract and status

docs/phase-2-implementation-plan.md
= approved Phase 2 execution contract and status

ADRs
= approved architecture changes

CI results
= mechanical quality evidence

Pi sessions / ACT model sessions
= disposable execution context only
```

No session file, compaction summary, conversation log, or model response may override the sources above.

---

# 8. Phase 1 — ACT Runtime Contract

Phase 1 is the personal-operator runtime. It remains architecturally separate from Pi.

## 8.1 Runtime Topology

Steady state:

```text
app ──────┐
           ├── PostgreSQL
worker ───┘
```

A one-shot migration container is permitted but is not a continuously running service.

The base runtime must start without OpenAI or Google credentials. Missing integrations are `unavailable`, not health failures.

## 8.2 Scheduler

The scheduler is deterministic and PostgreSQL-backed.

Rules:

- standard five-field cron;
- explicit IANA timezone;
- canonical timestamps stored in UTC;
- default timezone from user configuration;
- polling is only a wake mechanism;
- `FOR UPDATE SKIP LOCKED` or equivalent transactional claiming;
- unique `(automation_id, scheduled_for)`;
- no overlapping active run for the same automation by default;
- after downtime, catch up at most one run;
- the most recent eligible missed occurrence is used;
- default missed-run relevance window is 24 hours;
- never replay every missed occurrence.

## 8.3 Lease Heartbeat and Fencing

A lease timeout alone is not sufficient for correctness.

Long-running valid model/tool executions use heartbeat renewal.

Consequential persistence is fenced so that:

```text
old worker owns lease generation N
        ↓
lease expires
        ↓
new worker claims generation N+1
        ↓
old async operation returns
        ↓
write with generation N rejected
```

A stale executor must not mutate authoritative state after reclamation.

## 8.4 Tool Gateway

All real-world actions flow through the Tool Gateway.

Each tool definition includes:

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

The Gateway owns tool lookup, capability checks, permission checks, schema validation, idempotency reservation, timeout classification, verification, retry safety, audit persistence, evidence validation, and secret-safe summaries.

## 8.5 `unknown` Is a First-Class State

A timeout does not imply failure.

If an external side effect may have started:

```text
possible external write
        ↓
response lost / timeout
        ↓
UNKNOWN
        ↓
verification
```

The system must not blindly retry.

For generic browser submissions, an immediate “not observed yet” result is not proof that the original request can no longer complete.

Therefore:

```text
unknown browser submit
+ absent immediate postcondition
≠ safe retry
```

It remains unknown until reliable verification or human resolution establishes safety.

## 8.6 Browser Safety

`browser.click` must not be treated as automatically harmless.

The safe split is:

```text
deterministic HTTP(S) navigation
→ navigation/read capability

arbitrary button / JS handler / consequential control
→ not generic safe click

consequential form/action
→ browser.submit
→ explicit external_write permission
→ idempotency/side-effect tracking
→ verification
```

No arbitrary JavaScript or host shell execution is exposed to the ACT model.

## 8.7 Gmail

Phase 1 Gmail is read-only: search, read, and bounded wait for an expected message.

No send, forward, delete, or mutation.

Email bodies are untrusted external data.

## 8.8 Calendar

Model-facing capabilities are list/read, create, and update. No model-facing deletion.

Create/update idempotency and verification must cover the complete canonical requested state, including all supported mutable fields such as title/summary, description, location, start/end, timezone, and other supported writable fields.

A timezone-only or description-only update must not collide with a different update or falsely verify success.

## 8.9 ACT Agent Runtime

Every reasoning step is reconstructed from durable state.

Persistent model policy uses semantic profiles only:

```ts
type ModelProfile = "fast" | "balanced" | "reasoning";
```

Concrete provider model IDs are runtime configuration.

The model cannot choose its own tier.

Model invocations use bounded context, strict structured decisions, minimum capability-scoped tool exposure, deterministic retry/escalation budgets, and no hidden session dependency.

## 8.10 Deterministic Completion

A model `complete` decision is a proposal, not success authority.

Before `succeeded`, the Control Plane validates applicable completion semantics:

- required workflow phase;
- required verified tool outcomes;
- required evidence;
- no unresolved consequential tool call;
- no relevant `unknown` idempotency state;
- required postconditions;
- policy-specific completion contract.

```text
model proposes complete
        ↓
Completion Validator
        ├── FAIL → continue / verify / block
        └── PASS → succeeded
```

## 8.11 ACT User Surfaces

The local UI exposes command submission/status, automations, automation editing, run list/detail, activity history, evidence metadata, safe tool/model audit metadata, `needs_human` resume, and integration availability.

The browser/client never receives provider credentials, unrestricted external bodies, raw browser state, prompts, hidden reasoning, or secret-bearing data.

---

# 9. Phase 2 — EVOLVE Runtime

Phase 2 adds autonomous software development **after Phase 1 acceptance is complete**.

The platform does not replace the existing action runtime. Instead it adds a separate software-development execution path.

---

# 10. EVOLVE Architecture

```text
                  Approved Development Task
                            │
                            ▼
                  Development Coordinator
                            │
            ┌───────────────┼────────────────┐
            │               │                │
        State Machine   Context Compiler   Sandbox Manager
            │               │                │
            └───────────────┼────────────────┘
                            ▼
                    DevelopmentHarness
                            │
                            ▼
                        Pi Adapter
                            │
                            ▼
                         Pi SDK
                            │
                ┌───────────┼────────────┐
                │           │            │
              Planner    Implementer   Reviewer
                │           │            │
                │           ▼            │
                │      Sandbox Tools     │
                │           │            │
                │           ▼            │
                │    Isolated Worktree   │
                │                        │
                └────────────┬───────────┘
                             ▼
                      Candidate Commit
                             │
                    ┌────────┴─────────┐
                    ▼                  ▼
              Independent Review       CI
                    └────────┬─────────┘
                             ▼
                        Quality Gate
                       ┌─────┴─────┐
                       │           │
                      FAIL        PASS
                       │           │
                    Fix loop    Merge Ready
                                   │
                                   ▼
                               Auto Merge
                                   │
                                   ▼
                              Direct Deploy
                                   │
                                   ▼
                             Health Verify
```

---

# 11. DevelopmentHarness Abstraction

Pi is an implementation detail behind a project-owned contract.

Illustrative interface:

```ts
interface DevelopmentHarness {
  execute(
    task: DevelopmentTask,
    workspace: SandboxWorkspace,
    context: DevelopmentContext,
    role: DevelopmentRole,
  ): AsyncIterable<DevelopmentEvent>;

  abort(runId: string): Promise<void>;
}
```

The Control Plane and development state machine depend on `DevelopmentHarness`, not directly on Pi APIs.

This permits later adapters without rewriting task state, review policy, CI, or merge logic.

---

# 12. Pi's Role

Pi is the initial **coding-agent harness** for Phase 2.

It may provide generic execution mechanics such as agent loop, model interaction, tool-call handling, streaming, task-local sessions, session trees/branching, context compaction, extension hooks, and model-provider abstraction.

Pi does **not** own development-task state, project roadmap, specification authority, architecture rules, acceptance criteria, merge policy, deployment policy, long-term memory, project secrets, host access, sandbox policy, or user account integrations.

The platform must remain correct if a Pi session is lost.

---

# 13. Pi Session Semantics

Pi sessions are **task-local execution memory**, not workflow truth.

Allowed use:

```text
Development Task T
    ↓
fresh Pi session
    ↓
implementation attempt
    ↓
compaction if needed
    ↓
tests / diff
    ↓
attempt completed
```

A session may be resumed for the **same bounded task/attempt** when useful, but it must never be the only source of current task state, approved plan, acceptance criteria, changed-file truth, review findings, retry count, or merge readiness.

Across independent tasks, default to fresh sessions.

## 13.1 Compaction

Pi's compaction may reduce context size, but compaction summaries are not authoritative project memory.

A custom compaction hook may preserve useful execution metadata such as:

```text
Goal
Approved constraints
Progress
Files read
Files modified
Tests run
Known failures
Next step
```

However, the Development Context Compiler always reconstructs required authoritative context from PostgreSQL/Git/docs before a new task execution.

---

# 14. Pi Resource Loading and Project Trust

Pi project-local resources and extensions execute with the Pi process's permissions and therefore must not be automatically trusted as a security boundary.

For unattended EVOLVE runs:

- do not auto-discover arbitrary project `.pi/extensions`;
- do not load mutable repository extensions merely because they exist;
- prefer an explicitly constructed, harness-owned `ResourceLoader`;
- load only reviewed harness extensions/tools from the trusted runner image;
- treat repository text, comments, docs, generated files, and build output as untrusted model context unless specifically elevated by policy;
- never use Pi “project trust” as a substitute for OS/container isolation.

Repository-controlled prompts may provide task context but may not grant new system capabilities.

---

# 15. Development Sandbox Boundary

Pi has no built-in security sandbox. Therefore the EVOLVE design requires an OS/container/VM boundary.

The autonomous coding model must never receive a host shell.

## 15.1 Trusted Runner vs Untrusted Tool Sandbox

Preferred architecture:

```text
HOST / TRUSTED DEVELOPMENT RUNNER
---------------------------------
Development Coordinator
Pi SDK
Model credentials
DevelopmentHarness
Sandbox Gateway
        │
        │ only project-owned tool calls
        ▼
ISOLATED DEV SANDBOX
---------------------------------
ephemeral filesystem/worktree
compiler/runtime
package manager
tests
git worktree contents
restricted network
NO model credentials
NO personal credentials
NO production DB credentials
NO host ~/.ssh
NO host ~/.pi/agent
NO Docker socket
```

The trusted runner may use Pi SDK, but **Pi built-in host filesystem/bash tools are not exposed directly**.

Instead, Pi receives project-owned tools that route operations to the isolated sandbox.

Example tool set:

```text
sandbox.read
sandbox.list
sandbox.search
sandbox.write
sandbox.edit
sandbox.exec
git.diff
git.status
```

These act on the sandbox/worktree only.

## 15.2 Why the Split Matters

If a model API credential and unrestricted `bash` live in the same execution environment, generated code or shell commands may be able to read or exfiltrate that credential.

Therefore model credentials remain in the trusted Development Runner whenever practical.

The sandbox gets only the credentials strictly needed by the task, preferably none.

## 15.3 Docker Ownership

The application worker must not receive `/var/run/docker.sock`.

Sandbox/container creation belongs to a host-level trusted development runner or equivalent sandbox service outside the regular Compose application trust boundary.

The main app/worker can request development execution through durable state or a narrow local interface; they do not gain unrestricted host-container control.

---

# 16. Development Context Compiler

Pi does not replace the platform Context Compiler.

For every development role, the platform creates a bounded `DevelopmentContext`.

Typical contents:

```text
Task goal
Task specification
Acceptance criteria
Relevant architecture invariants
Relevant ADRs
Relevant AGENTS.md policy
Base commit
Allowed paths / forbidden paths
Relevant files
Known failures
Previous review findings
Required quality gates
Budget / attempt limits
```

Do not dump the entire repository or full task history by default.

Context selection is role-specific.

---

# 17. Development Roles

## 17.1 Planner

Purpose: clarify implementation approach, identify ambiguity, identify affected components, and propose tests/acceptance mapping.

Default capabilities:

```text
read
search
list
restricted test discovery
```

No write/merge/deploy authority.

Planning output is structured and becomes authoritative only after the user or deterministic policy approves it.

## 17.2 Implementer

Purpose: modify code, write tests, run local quality checks, and produce a candidate commit/diff.

Capabilities are sandbox-only:

```text
read
search
write
edit
exec
git status/diff
```

No host access, production credentials, personal integrations, merge authority, or deployment authority.

## 17.3 Reviewer

Reviewer always uses a fresh execution context independent of the Implementer session.

Inputs:

- original task/specification;
- acceptance criteria;
- architecture rules;
- candidate diff/commit;
- relevant source;
- test results;
- CI results.

The Reviewer does **not** inherit the Implementer conversation, Implementer compaction, or the Implementer's claim that the task is complete.

Reviewer capabilities should normally be read-only plus sandboxed test execution.

The Reviewer returns structured:

```text
APPROVE
or
REQUEST_CHANGES(findings[])
```

Reviewer approval alone is still insufficient for merge; deterministic CI gates must also pass.

---

# 18. Development Task State Machine

Suggested durable Phase 2 state:

```text
DRAFT
  ↓
PLANNING
  ↓
AWAITING_PLAN_APPROVAL
  ↓
READY
  ↓
PREPARING_SANDBOX
  ↓
IMPLEMENTING
  ↓
TESTING
  ↓
REVIEWING
  │
  ├── REQUEST_CHANGES → FIX_REQUIRED → IMPLEMENTING
  │
  └── APPROVE
           ↓
       VALIDATING
           │
           ├── FAIL → FIX_REQUIRED
           └── PASS
                  ↓
             MERGE_READY
                  ↓
               MERGED
                  ↓
              DEPLOYING
                  ↓
              VERIFYING
                  ↓
              COMPLETED
```

Exceptional states:

```text
NEEDS_HUMAN
BLOCKED
FAILED
CANCELLED
```

The state lives in PostgreSQL, not in Pi.

---

# 19. Git and Workspace Model

Every implementation attempt gets an isolated workspace.

Preferred model:

```text
base commit
    ↓
create Git worktree / isolated copy
    ↓
sandbox
    ↓
Pi Implementer
    ↓
tests
    ↓
candidate commit
```

Rules:

- record exact base commit;
- record resulting candidate commit;
- reviewer evaluates the exact candidate revision;
- merge only the approved revision;
- no agent writes directly to `main`;
- sandbox destruction must not lose durable task/review state.

---

# 20. Development Retry and Budget Policy

The development loop is bounded.

Example controls:

- max implementation attempts;
- max reviewer cycles;
- max model invocations;
- max wall-clock time;
- max token/cost budget;
- max CI retries;
- explicit terminal conditions.

Failure classes differ:

```text
model/provider transient error
→ retry transport

malformed structured output
→ bounded model retry

test failure
→ implementation feedback

review finding
→ implementation retry

architecture ambiguity
→ NEEDS_HUMAN / plan approval

sandbox infrastructure failure
→ deterministic infrastructure retry

repeated failure
→ BLOCKED
```

The model cannot raise its own limits.

---

# 21. CI and Independent Acceptance

A candidate may merge only if all applicable gates pass.

Required baseline:

- unit tests;
- integration tests;
- E2E tests where applicable;
- statements 100%;
- branches 100%;
- functions 100%;
- lines 100%;
- lint;
- typecheck;
- build;
- migration checks if relevant;
- security/scope checks;
- independent Reviewer approval.

A model-generated test suite cannot serve as the only acceptance oracle.

Where important behavior is domain-specific, encode deterministic invariants or property tests.

---

# 22. Auto-Merge

Auto-merge is deterministic.

Required conditions:

```text
task revision still current
AND approved plan/spec unchanged
AND independent review = APPROVE
AND CI = PASS
AND coverage = exact required thresholds
AND no unresolved blocking finding
AND merge policy allows automation
```

The coding agent cannot merge itself by merely claiming completion.

---

# 23. Direct Deployment

After merge to `main`:

```text
merge main
   ↓
CI / trusted deploy runner
   ↓
checkout exact expected revision
   ↓
docker compose build
   ↓
docker compose up -d
   ↓
health verification
   ↓
verify deployed revision
```

The deploy mechanism must run outside the application containers it needs to restart.

A deployment is not successful merely because a process started.

Verify expected revision, migrations, service health, and required runtime checks.

If deployment fails, use simple Git/Docker recovery first. Do not add a sophisticated rollout platform without need.

---

# 24. Phase 2 Implementation Sequence

Phase 2 should be built incrementally.

## 24.1 Phase 2A — Development Harness Spike

Goal:

```text
Human-approved development task
        ↓
durable DevelopmentTask
        ↓
isolated workspace
        ↓
DevelopmentHarness
        ↓
Pi Implementer
        ↓
code + tests
        ↓
candidate commit
        ↓
sandbox destroyed
```

No auto-merge yet.

Acceptance:

- one real small task can be implemented from a bounded spec;
- exact base/result commits recorded;
- no host credential leakage;
- sandbox is disposable;
- task remains reconstructable without Pi session state.

## 24.2 Phase 2B — Independent Review

Add:

```text
candidate commit
    ↓
fresh Reviewer session
    ↓
APPROVE / REQUEST_CHANGES
```

Acceptance:

- reviewer receives no implementer session;
- reviewer cannot mutate candidate;
- findings are durable;
- review is bound to exact candidate commit.

## 24.3 Phase 2C — Autonomous Fix Loop

Add:

```text
implement
→ test
→ review
→ findings
→ fresh/bounded fix attempt
→ test
→ review
```

Acceptance:

- bounded attempts;
- deterministic stop conditions;
- durable retry history;
- no infinite loop.

## 24.4 Phase 2D — Merge and Deploy

Add:

```text
Reviewer PASS
+ CI PASS
+ deterministic merge gate
→ auto-merge
→ direct deploy
→ health verification
```

Acceptance:

- agent cannot bypass CI/review;
- deployed revision is verified;
- deployment failure becomes durable failure/fix work.

---

# 25. Phase 2 Definition of Done

Phase 2 is complete only when all applicable criteria below pass.

1. Development tasks are durable in PostgreSQL.
2. Every task records an exact base revision.
3. Development execution uses `DevelopmentHarness`, not Pi-specific business logic.
4. Pi is replaceable behind the harness interface.
5. Development sessions are task-local and non-authoritative.
6. A task can restart without depending on Pi session memory.
7. Every implementation attempt runs against an isolated workspace.
8. The coding model has no host shell.
9. The coding model has no Docker socket.
10. Sandbox code receives no personal Gmail/Calendar credentials.
11. Sandbox code receives no production database credentials.
12. Model credentials are not exposed to sandbox shell/processes under the approved runner architecture.
13. Project-local Pi extensions are not automatically trusted/loaded in unattended mode.
14. Context is compiled from durable sources and bounded.
15. Planner, Implementer, and Reviewer capabilities are role-scoped.
16. Reviewer uses fresh context independent from Implementer conversation/session.
17. Candidate code is bound to an exact commit/diff.
18. Review findings are durable.
19. CI and review gates are independent.
20. Owned executable code remains at exact 100% statements/branches/functions/lines.
21. Development retries are bounded.
22. Auto-merge requires deterministic policy, review approval, and CI success.
23. Coding models cannot merge themselves directly.
24. Deployment verifies the expected revision and runtime health.
25. A complete approved task can proceed from specification to merged/deployed code without manual PR babysitting under configured policy.

---

# 26. Phase 3 — Self-Improvement

Only after ACT and EVOLVE are proven.

Phase 3 adds an Improvement Evaluator / Capability Gap Detector.

Inputs may include repeated automation failures, tool failure rates, recurring manual intervention, excessive browser fragility, model cost/performance, user feedback, runtime errors, and repeated missing capability.

Example:

```text
browser workflow repeatedly fails
        ↓
pattern detected
        ↓
proposal:
"Build dedicated VTC adapter"
        ↓
human approval if required
        ↓
DevelopmentTask
        ↓
Phase 2 pipeline
        ↓
new adapter merged/deployed
        ↓
future automation uses dedicated tool
```

The Evaluator may propose work but does not bypass specification policy, user-owned architecture decisions, DevelopmentHarness isolation, independent review, CI, merge policy, or deployment verification.

---

# 27. Development Data Model Additions

Phase 2 may add entities such as:

## 27.1 `development_tasks`

```text
id
type
title
description
status
priority
approved_spec
acceptance_criteria
base_commit
source_automation_id?
source_run_id?
max_attempts
created_at
updated_at
```

## 27.2 `development_attempts`

```text
id
task_id
role
attempt
harness
semantic_model_profile
base_commit
candidate_commit?
sandbox_id
status
started_at
completed_at
safe_summary
```

## 27.3 `development_reviews`

```text
id
task_id
candidate_commit
reviewer_attempt_id
decision
structured_findings
created_at
```

## 27.4 `ci_validations`

```text
id
task_id
candidate_commit
status
coverage_summary
test_summary
build_summary
created_at
```

## 27.5 `deployments`

```text
id
commit
status
started_at
completed_at
health_verified
safe_summary
```

Do not persist full hidden reasoning or unrestricted session transcripts.

---

# 28. Security and Trust Boundaries

## 28.1 Untrusted Content

Treat as untrusted data:

- webpages;
- emails;
- scraped content;
- uploaded files;
- repository comments;
- repository documentation unless explicitly policy-trusted;
- generated source code;
- build output;
- test output;
- dependency output.

External/repository text may inform reasoning but cannot grant additional tools or permissions.

## 28.2 Trusted Instructions

Trusted instruction sources are explicitly bounded:

- system policy;
- user-approved goals/specifications;
- `docs/design.md`;
- approved ADRs;
- `AGENTS.md`;
- approved implementation plan;
- deterministic runtime configuration.

## 28.3 Secrets

Secrets never enter prompts, persisted model context, unrestricted logs, audit summaries, evidence, browser output, or repository commits.

ACT adapters hold their own credentials.

EVOLVE sandboxes receive the minimum credentials required, ideally none.

## 28.4 Pi-Specific Security Rule

Pi is not a sandbox.

The system must assume that built-in file tools can modify accessible files, built-in shell runs with Pi process permissions, extensions run with Pi process permissions, and project trust does not protect against unsafe tool execution after startup.

Therefore unattended Pi execution requires external OS/container/VM isolation and explicit tool routing.

---

# 29. Observability

Start small.

Required useful history:

- automation runs;
- tool calls;
- evidence;
- model invocation metadata;
- development tasks;
- development attempts;
- review findings;
- CI results;
- deployments;
- errors;
- health state.

The system should answer:

```text
What happened?
Why did it happen?
Which durable task/run caused it?
Which model profile was used?
Which tools were available?
What external action occurred?
What evidence proves success?
Which code revision changed behavior?
Who/what approved the change?
Did CI pass?
Which revision is currently deployed?
```

Do not build an enterprise telemetry platform until needed.

---

# 30. Monorepo Direction

Existing Phase 1 structure remains valid:

```text
personal-agent/
├── apps/
│   ├── app/
│   └── worker/
├── packages/
│   ├── db/
│   ├── agents/
│   ├── tools/
│   └── shared/
├── docs/
│   ├── design.md
│   ├── implementation-plan.md
│   └── decisions/
├── AGENTS.md
├── Dockerfile
├── docker-compose.yml
└── package.json
```

Phase 2 may add:

```text
packages/
├── dev-harness/
│   ├── contract.ts
│   ├── context-compiler.ts
│   ├── roles.ts
│   ├── pi/
│   │   └── pi-harness.ts
│   └── sandbox/
│       ├── contract.ts
│       └── gateway.ts
```

and a host-level trusted development-runner entrypoint if required by the sandbox architecture.

Do not create a new network service merely for package organization.

---

# 31. Deployment Topology After Phase 2

Application runtime:

```text
Docker Compose
├── app
├── worker
└── postgres
```

Development execution boundary:

```text
Host / trusted machine
└── dev-runner
    ├── Pi SDK
    ├── model credentials
    ├── sandbox manager
    └── sandbox gateway
          │
          ▼
      ephemeral sandbox
      └── repo worktree + toolchain
```

Deployment runner may also be host-level.

The app worker must not gain broad host privileges merely because EVOLVE exists.

---

# 32. What We Intentionally Do Not Build Yet

```text
LangGraph
Temporal
Redis
Kafka
Kubernetes
complex distributed queues
large multi-agent society
staging/canary platform
automatic arbitrary infrastructure provisioning
host-shell access for coding agents
Docker socket inside the app worker
long-lived authoritative Pi sessions
automatic loading of mutable project Pi extensions in unattended runs
custom coding-agent loop if Pi already provides the required generic primitive
```

---

# 33. Architecture Change Policy

A change requires an explicit ADR when it modifies any of:

- authority boundaries;
- durable state ownership;
- ACT vs EVOLVE runtime separation;
- sandbox model;
- merge/deploy policy;
- secret handling;
- completion semantics;
- 100% coverage requirement;
- introduction of a new infrastructure framework/service.

A library upgrade or adapter substitution behind an existing interface usually does not require an architecture rewrite.

---

# 34. Implementation Strategy

## Phase 1 — ACT

Complete and accept the personal operator vertical slice before Phase 2.

The Phase 1 implementation plan owns its exact milestone status and acceptance matrix.

## Phase 2 — EVOLVE

Implement in order:

```text
2A DevelopmentHarness + isolated implementer spike
2B Independent reviewer
2C Bounded autonomous fix loop
2D Deterministic auto-merge + direct deploy
```

Do not skip directly to self-improvement.

## Phase 3 — Self-Improvement

Add capability-gap detection and improvement proposals only after the development loop itself is reliable.

---

# 35. Final System Definition

The system is a **human-directed, machine-operated personal agent platform**.

The human owns:

```text
vision
goals
preferences
ideas
subjective judgment
major product direction
approval of major architecture changes
semantic acceptance where it cannot be made deterministic
```

The deterministic platform owns:

```text
durable workflow state
scheduling
permissions
capability exposure
leases/fencing
idempotency
retry policy
completion validation
budgets
audit/evidence
development task state
review/CI gate enforcement
merge authority
deployment verification
```

Models/harnesses provide:

```text
reasoning
research
planning proposals
tool-selection proposals
coding
test generation
review findings
implementation suggestions
```

The key separation is:

> **The model may decide what it believes should happen next. The platform decides what is allowed to happen, what actually happened, whether the result satisfies the approved specification, and whether the workflow may advance.**

---

# 36. External Framework Notes

The initial Phase 2 Pi integration relies on the following verified properties of the current Pi documentation:

- Pi exposes a TypeScript SDK with `createAgentSession`, configurable tools, session management, and extension/resource loading.
- Pi session files support tree-shaped history and JSONL persistence.
- Pi supports automatic compaction and branch summarization, with extension hooks that can customize summaries.
- Pi intentionally does not provide a built-in sandbox.
- Built-in file/shell tools and extensions run with the permissions of the Pi process.
- Pi documentation recommends containers, VMs, micro-VMs, or policy-controlled sandboxes for unattended/untrusted work.

These are **framework facts**, not platform authority. If Pi changes, update the adapter or ADR while preserving this design's control and isolation invariants.

Official references consulted for Revision 3:

- https://pi.dev/docs/latest/sdk
- https://pi.dev/docs/latest/sessions
- https://pi.dev/docs/latest/compaction
- https://pi.dev/docs/latest/security
- https://pi.dev/docs/latest/containerization

---

# 37. Final Acceptance Philosophy

The platform is not successful because it can generate large amounts of code.

It is successful when:

```text
THINK
The user can reason and plan with it.

ACT
The user can state a recurring or immediate goal once.
The platform performs permitted work, survives restart, avoids duplicate actions,
verifies consequential outcomes, and records evidence.

EVOLVE
The platform can turn an approved software change into an isolated implementation,
independent review, deterministic CI decision, merge, deployment, and verified runtime
change without surrendering authority to the coding model.

SELF-IMPROVE
The system can recognize repeated operational deficiencies and propose improvements,
while all software-change authority still flows through the same controlled EVOLVE pipeline.
```

The engineering system exists to reduce repeated manual digital work. It must not become a self-referential infrastructure project whose complexity exceeds the value it creates.
