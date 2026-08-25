# Personal Autonomous Agent Platform
## Final Design & Implementation Contract

**Status:** FINAL — implementation-ready source of truth  
**Primary user:** Single-user personal system  
**Operating mode:** Active development, direct-to-production, automation-first  
**Core idea:** The user provides goals, preferences, ideas, and high-level direction. The platform reasons, performs real-world actions through tools, runs persistent automations, and later evolves its own software capabilities when existing tools are insufficient.

**Implementation priority:** prove the ACT runtime first. Self-development is deliberately deferred until the personal operator is already useful.

---

# 1. Executive Summary

The project is a **Personal Autonomous Agent Platform** with three first-class capabilities:

1. **THINK** — answer questions, research, reason, plan, and discuss ideas with the user.
2. **ACT** — perform real-world actions using tools such as a browser, Gmail, Google Calendar, APIs, shell commands, and scheduled automations.
3. **EVOLVE** — modify its own codebase through an autonomous software-development loop when a desired capability cannot be implemented reliably using existing tools.

The platform is not designed around one long-running LLM conversation. Long-term state lives in durable system data: PostgreSQL, Git history, architecture documentation, task records, automation definitions, run history, and stored decisions. Every agent execution can therefore be **fresh, isolated, and disposable**.

The system uses a deterministic **Control Plane** to manage scheduling, workflow state, permissions, retries, tool access, model selection, budgets, and verification. Models provide intelligence, but they do not own authority or persistent workflow state.

The main operating principle is:

> **LLMs decide what should be done next; deterministic code decides whether the action is allowed, whether it has already happened, whether it succeeded, whether it should be retried, and when the workflow is complete.**

## 1.1 Final Decisions

The following decisions are intentionally fixed for the first implementation and should not be changed by an implementation agent without an explicit architecture decision:

- **Single-user system.** Optimize for one trusted owner, not enterprise multi-tenancy.
- **TypeScript-first monorepo.** Platform and orchestration code are TypeScript. Python may be introduced later only for workloads where its ecosystem provides a clear advantage, such as quantitative research or ML.
- **One small runtime.** Start with PostgreSQL, one application process, and one worker process.
- **Automation-first.** Build a useful personal operator before building self-development.
- **Direct to production.** No staging or canary environment in the initial system.
- **Persistent state, disposable model sessions.** PostgreSQL and Git hold state; LLM sessions may die at any time.
- **Deterministic authority.** Models never own workflow state, credentials, permissions, retries, scheduling, or success criteria.
- **Existing primitives before custom infrastructure.** Use maintained SDKs/libraries for agent loops, browser automation, APIs, and protocols instead of reimplementing them.
- **100% coverage is a hard merge gate** for owned executable code, across statements, branches, functions, and lines.
- **Independent automated code review** is required before automatic merge once Phase 2 is implemented.
- **No framework proliferation.** Do not introduce Redis, Temporal, Kafka, Kubernetes, LangGraph, or a new microservice unless a concrete limitation justifies it.

## 1.2 Implementation Order

The project is bootstrapped in three stages:

```text
Stage 0 — Manual development bootstrap
User + Codex build the platform

Stage 1 — ACT runtime
Chat → Automation → Scheduler → Agent → Browser/Gmail/Calendar → verified result

Stage 2 — EVOLVE runtime
Platform can create development tasks → invoke coding agent → independent review → CI → auto-merge → deploy

Stage 3 — Self-improvement
Operational failures/capability gaps can propose or initiate development work under policy
```

**Only Stage 1 / Phase 1 is the initial implementation target.** Phase 2 and Phase 3 architecture must be preserved, but their runtime should not be implemented until Phase 1 Definition of Done is satisfied.

The platform is intentionally optimized for a **single-user personal environment under active development**. It therefore avoids unnecessary enterprise infrastructure. There is no mandatory staging environment, canary rollout, Kubernetes, Kafka, Temporal, or Redis in the initial implementation. Changes that pass automated review and CI are merged and deployed directly to the live personal system.

---

# 2. Product Vision

The desired interaction model is closer to a persistent personal operator than to a conventional dashboard or chatbot.

The user should be able to say things such as:

- “Every day, check whether a suitable evening SUA Advanced Rating course near Tsuen Wan has opened. If it has, register me and add the confirmed session to Google Calendar.”
- “Monitor Van Gogh Pikachu PSA 10 prices and only notify me when the long-term entry looks materially attractive.”
- “Every morning, check whether anything material changed in the IONQ thesis.”
- “Add PSA population history to the Pokémon card page.”
- “This browser workflow is unreliable. Build a dedicated tool for it.”

The system should determine whether the request is:

- an immediate information query,
- an executable action,
- a recurring automation,
- a planning discussion,
- or a software capability change.

The user does not need to write implementation prompts, manually manage sessions, review ordinary pull requests, or repeatedly configure cron jobs. The platform converts human-level intent into structured, executable work.

---

# 3. Design Goals

## 3.1 Primary Goals

The platform should:

- accept natural-language goals and commands;
- support interactive planning before major product or architecture changes;
- execute real-world tasks through connected tools;
- persist recurring and conditional automations;
- resume safely after crashes or restarts;
- connect browser, email, calendar, APIs, Git, shell, and custom tools behind a unified interface;
- choose models according to task type, complexity, reliability, latency, and cost;
- restrict each agent run to only the capabilities required for that task;
- verify external side effects rather than assuming a tool call succeeded;
- autonomously implement, review, test, merge, and deploy software changes;
- enforce **100% test coverage** on owned executable code before merge;
- learn operationally by turning repeated failures or missing capabilities into improvement proposals or development tasks.

## 3.2 Non-Goals for the Initial Version

The first version does **not** need:

- multi-user tenancy;
- enterprise RBAC;
- Kubernetes;
- Kafka;
- Redis unless queue pressure later justifies it;
- Temporal unless genuinely long-running durable workflows become difficult to manage with PostgreSQL state;
- a separate staging environment;
- canary releases;
- a complex rollback platform;
- a large multi-agent framework for every workflow;
- a dedicated microservice for every component;
- a custom integration for every website.

The system should begin with a small, comprehensible runtime and add infrastructure only after a concrete limitation appears.

---

# 4. Core Architectural Principles

## 4.1 Persistent State, Disposable Agents

No workflow depends on keeping one model session alive.

Persistent memory lives in:

- PostgreSQL;
- Git history;
- architecture documentation;
- ADRs and project decisions;
- automation definitions;
- task definitions;
- agent-run records;
- tool-call records;
- execution evidence;
- user-configured policies;
- operational logs.

An agent run is temporary compute:

```text
spawn
  ↓
load durable state
  ↓
compile context
  ↓
reason and act
  ↓
persist results
  ↓
exit
```

If the machine restarts, a new agent can continue from the persisted workflow state.

## 4.2 Intelligence Is Not Authority

The LLM may propose the next action, but all side effects go through deterministic policy and validation.

```text
Model proposes tool call
        ↓
Schema validation
        ↓
Capability / permission check
        ↓
Precondition check
        ↓
Idempotency check
        ↓
Execute
        ↓
Postcondition verification
        ↓
Persist result
```

## 4.3 Prefer Existing Tools Before Writing New Code

The platform should escalate through three levels:

### Level 1 — Use existing tools directly

If a browser, API, Gmail, Calendar, shell, or existing internal tool can complete the task reliably, use it.

### Level 2 — Create a reusable automation

If the goal is recurring or conditional, store the workflow as an automation definition and run it on schedule or on demand.

### Level 3 — Develop a new capability

Only when the generic tool path is too slow, unreliable, repetitive, or impossible should the system propose or build a dedicated tool or feature.

This prevents every new user request from becoming a software-development project.

## 4.4 Direct-to-Production Development

This is a single-user system under active development.

The software loop is therefore:

```text
code
  ↓
independent review
  ↓
CI + 100% coverage
  ↓
auto-merge
  ↓
direct deploy
  ↓
run
```

There is no mandatory staging or canary layer. If something breaks, the system creates or executes a fix task and iterates quickly.

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
             ┌─────────────────┼──────────────────┐
             ▼                 ▼                  ▼
           QUERY          AUTOMATION          DEV CHANGE
             │                 │                  │
             └─────────────────┼──────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │    CONTROL PLANE    │
                    │                     │
                    │ Workflow state      │
                    │ Scheduler           │
                    │ Model router        │
                    │ Capability resolver │
                    │ Tool policy         │
                    │ Retry logic         │
                    │ Budget controls     │
                    │ Audit trail         │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┴─────────────┐
                 ▼                           ▼
          MODEL / AGENT LAYER           TOOL GATEWAY
                 │                           │
      ┌──────────┼───────────┐      ┌────────┼───────────────┐
      ▼          ▼           ▼      ▼        ▼               ▼
   General    Planner      Coder   Browser  Gmail          Calendar
    Agent       Agent       Agent      │       │               │
      │                      │         ▼       ▼               ▼
      │                   Reviewer  Playwright Google API   Google API
      │
      └──────────────────────────────────────────────┐
                                                     │
                                                     ▼
                                              Real-world actions

                         DEVELOPMENT / EVOLUTION LOOP

        Missing capability / approved feature / recurring failure
                               │
                               ▼
                            Task DB
                               │
                               ▼
                        Agent Supervisor
                               │
                               ▼
                         Context Compiler
                               │
                               ▼
                           Coder Agent
                               │
                               ▼
                              PR
                         ┌─────┴─────┐
                         ▼           ▼
                    Reviewer        CI
                         └─────┬─────┘
                               ▼
                         Quality Gate
                               │
                               ▼
                           Auto Merge
                               │
                               ▼
                         Direct Deploy
```

---

# 6. Final Technology Stack

The initial repository uses a deliberately narrow TypeScript-first stack.

| Area | Decision |
|---|---|
| Language | TypeScript |
| Runtime | Current Node.js LTS, pinned at repository bootstrap |
| Package manager | pnpm workspaces |
| Web app / UI | Next.js + React + TypeScript |
| Worker | Plain Node.js TypeScript process |
| Database | PostgreSQL |
| ORM / migrations | Drizzle ORM |
| Agent harness | OpenAI Agents SDK for TypeScript behind internal interfaces |
| Runtime validation | Zod |
| Browser automation | Playwright |
| Google integration | Gmail API + Google Calendar API through `googleapis` or equivalent official client |
| Unit/integration tests | Vitest |
| Browser / E2E tests | Playwright |
| CI | GitHub Actions |
| Local deployment | Docker Compose |
| Source control | Git + GitHub |

## 6.1 TypeScript-First, Not TypeScript-Only

TypeScript is the platform language because the MVP is primarily orchestration, web UI, APIs, browser automation, scheduling, state management, and tool integration. Shared TypeScript types should be reused across app, worker, tools, and database boundaries.

Python is allowed later for domain-specific workloads where it materially improves implementation quality or ecosystem access, for example:

- quantitative research;
- backtesting;
- scientific computing;
- large-scale dataframe processing;
- ML / model training.

Python must not be introduced merely to add another agent framework or queue.

## 6.2 Assemble, Do Not Rebuild the Ecosystem

The implementation should use existing maintained primitives for generic infrastructure:

- Agents SDK for model/tool execution loops and structured tool calls;
- Playwright for browser control;
- Google APIs for Gmail and Calendar;
- MCP only where an external integration is naturally exposed through MCP;
- GitHub Actions for CI;
- Git / worktrees for isolated code changes.

OpenClaw is an architectural reference for persistent personal-agent automation. The project may adopt a useful component if it cleanly fits behind an internal interface, but Phase 1 must not become dependent on replacing or reimplementing OpenClaw wholesale.

All external frameworks sit behind project-owned interfaces so they can be replaced without rewriting business logic.

---

# 7. User Plane and System Plane

## 7.1 User Plane

The user-facing product should remain simple.

Primary surfaces:

- **Chat / Command** — main interaction surface;
- **Automations** — list of recurring or conditional jobs, statuses, and last results;
- **Activity / History** — what the agent did and why;
- **Domain modules** — optional dedicated views for data-heavy areas such as IONQ, Pokémon, markets, or travel;
- **Development status** — optional view showing feature work, failures, retries, and deployments.

The user should not need to interact with internal task IDs, worktrees, CI jobs, or model sessions during normal use.

## 7.2 System Plane

The system plane contains:

- Control Plane;
- Scheduler;
- Task DB;
- Model Router;
- Context Compiler;
- Tool Registry / Tool Gateway;
- Agent Supervisor;
- Coder and Reviewer agents;
- CI and quality gates;
- Git / GitHub integration;
- direct deployment logic;
- structured logs and run history.

The system plane modifies and extends the user plane over time.

---

# 8. Request and Intent Routing

Every user input first becomes a typed intent.

Initial intent types:

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

Examples:

```text
"What changed in IONQ today?"
→ QUERY

"Add this confirmed course to my calendar."
→ ACTION

"Every day, check for an evening VTC SUA course and register me if one opens."
→ AUTOMATION_CREATE

"Add PSA population history to the Pokémon detail page."
→ PRODUCT_CHANGE
```

The router should return structured output. It should not directly execute external side effects.

---

# 9. Control Plane

The Control Plane is the authority layer of the system.

It owns:

- workflow state;
- scheduling;
- retry classification;
- model selection;
- capability exposure;
- tool permissions;
- tool-call validation;
- idempotency;
- budgets and rate limits;
- run cancellation;
- evidence recording;
- completion criteria.

A model can request an action, but the Control Plane decides whether the request can execute.

## 9.1 Control Plane Rule

```text
LLM decides:
- what should happen next?
- what information is missing?
- which permitted tool is appropriate?

Code decides:
- is the action allowed?
- has it already happened?
- are required preconditions satisfied?
- did it actually succeed?
- is retry safe?
- which model profile is used?
- how much may this run spend?
- when does the workflow terminate?
```

---

# 10. Tool Architecture

## 10.1 Unified Tool Registry

Agents should not know whether a capability is implemented through REST, MCP, Playwright, a local library, or a subprocess.

They see a typed registry such as:

```text
web.search
web.open

browser.open
browser.read
browser.click
browser.type
browser.select
browser.upload
browser.submit

 Gmail.search
Gmail.read
Gmail.wait_for_message

calendar.list_events
calendar.create_event
calendar.update_event

shell.run

git.diff
git.commit
git.push

automation.create
automation.disable

task.create
```

Each tool has:

- typed input schema;
- typed output schema;
- permission class;
- timeout;
- retry policy;
- side-effect classification;
- optional idempotency support;
- optional verification hook.

## 10.2 Tool Adapters

### Browser Adapter

Implementation: controlled browser session, preferably Playwright-backed.

Use for:

- websites without suitable APIs;
- form filling;
- registration workflows;
- page extraction;
- navigation;
- ordinary web interactions.

### Gmail Adapter

Use a direct Gmail API / connector path where possible.

Capabilities include:

- search messages;
- read messages;
- wait for confirmation messages;
- extract confirmation numbers or dates.

### Google Calendar Adapter

Use the Calendar API rather than browser automation.

Capabilities include:

- list events;
- create event;
- update event;
- check for duplicates.

### Git Adapter

Provides controlled access to:

- branches;
- worktrees;
- diffs;
- commits;
- pushes;
- pull requests.

### Shell Adapter

Restricted local execution for development and system maintenance.

### MCP Adapters

MCP can be used as a standard integration path for compatible external tools, but the platform does not require every tool to be MCP-based.

The Tool Registry hides the underlying transport from agents.

---

## 10.3 Unified Tool Result Contract

Every tool call returns a normalized result. Business logic must not infer success from an exception-free function call.

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
```

`unknown` is a first-class state. It means the external action may have succeeded but the platform cannot yet prove the outcome. Consequential actions in `unknown` state must enter verification before any retry.

Example:

```text
registration submit times out
        ↓
status = unknown
        ↓
check account / confirmation page / email
        ↓
confirmed? → success
not confirmed with evidence? → safe retry if policy allows
```

---

# 11. Capability Resolution and Least-Privilege Tool Exposure

An agent should never receive every tool available in the system.

Before a run, the Capability Resolver determines the minimal tool set required by the task.

Example:

```text
Task: "What changed in IONQ today?"

Allowed:
- web.search
- web.open
- thesis.read

Not exposed:
- Gmail
- Calendar
- shell
- Git
- browser form submission
```

Example:

```text
Task: "Register me for this course and add it to Calendar."

Allowed:
- browser navigation / form tools
- Gmail search/read
- Calendar create

Not exposed:
- Git merge
- arbitrary shell
- unrelated finance tools
```

This reduces accidental misuse and limits prompt-injection blast radius.

---

# 12. Model Architecture and Model Routing

Models are interchangeable execution engines behind role-based interfaces.

The application should not scatter hard-coded model names throughout business logic.

## 12.1 Model Roles

Recommended logical profiles:

```text
ROUTER
- fast
- low cost
- strong structured-output reliability

EXTRACTOR
- fast
- low cost
- schema-oriented

GENERAL_AGENT
- strong reasoning
- strong tool use
- suitable for open-ended personal tasks

PLANNER
- strong reasoning
- architecture and requirements discussion

CODER
- coding-specialized model / coding agent

REVIEWER
- independent fresh model/session
- strong reasoning and code understanding
```

## 12.2 Deterministic Model Router

The Control Plane selects the model based on:

- task type;
- complexity;
- risk;
- required tools;
- past success rate;
- schema adherence;
- latency;
- cost;
- context size.

The model does **not** choose its own replacement.

## 12.3 Escalation Policy

Simple tasks should begin with a cheaper profile.

```text
cheap / fast model
       ↓ failure
retry once if appropriate
       ↓ failure
stronger reasoning model
       ↓ failure
specialized model or human escalation
```

Different failure types have different responses. A network timeout should not trigger a more expensive reasoning model.

## 12.4 Continuous Model Evaluation

The system should collect per-profile metrics:

- task success rate;
- tool-call success rate;
- malformed-output rate;
- number of retries;
- latency;
- token / monetary cost;
- human corrections;
- reviewer rejection rate for coding tasks.

Model selection can later be updated from observed performance rather than preference or marketing claims.

---

# 13. Scheduler and Automation System

Cron is only a wake-up mechanism. The automation definition contains the actual goal and policy.

## 13.1 Automation Definition

Example:

```json
{
  "id": "AUTO-001",
  "name": "VTC SUA Registration",
  "schedule": "0 9 * * *",
  "goal": "Find a suitable evening SUA Advanced Rating course near Tsuen Wan. Register when eligible and available, then add the confirmed session to Google Calendar.",
  "enabled": true,
  "modelProfile": "GENERAL_AGENT",
  "toolPolicy": "course-registration",
  "completionMode": "stop_after_success"
}
```

## 13.2 Scheduler Responsibilities

The scheduler only:

1. finds due automations;
2. creates an `AutomationRun`;
3. places it into executable state;
4. updates `nextRunAt`.

The scheduler itself performs no reasoning.

## 13.3 Scheduler Semantics

The scheduler must behave predictably across restarts and duplicate wakeups.

Initial rules:

- store canonical timestamps in **UTC**;
- each automation has an explicit IANA timezone, defaulting to the user-configured timezone;
- the same automation may not have overlapping active runs unless a future automation explicitly opts in;
- a missed run caused by downtime is executed once after recovery when still relevant;
- claiming a due run is transactional;
- `(automation_id, scheduled_for)` is unique to prevent duplicate scheduled runs;
- scheduler wakeups are idempotent;
- schedule calculation is deterministic and covered by tests, including DST/timezone edges where applicable.

The scheduler does not call models directly. It creates durable work; the runner executes it.

## 13.4 Automation Runtime

```text
schedule fires
      ↓
create run
      ↓
load automation + policies
      ↓
resolve capabilities
      ↓
select model
      ↓
spawn fresh agent
      ↓
reason / use tools
      ↓
persist state + evidence
      ↓
complete / retry / block
```

---

# 14. Durable Workflow State

The platform must never depend on an agent “remembering” what it already did.

For consequential workflows, state is explicit.

Example registration workflow:

```text
CREATED
  ↓
SEARCHING
  ↓
CANDIDATE_FOUND
  ↓
VALIDATING
  ↓
FILLING_FORM
  ↓
READY_TO_SUBMIT
  ↓
SUBMITTED
  ↓
VERIFYING
  ↓
CONFIRMED
  ↓
CALENDAR_CREATING
  ↓
COMPLETED
```

Possible alternate states:

```text
RETRY_WAIT
NEEDS_HUMAN
BLOCKED
FAILED
CANCELLED
```

If the process crashes after `SUBMITTED`, a new agent resumes at `VERIFYING`; it does not submit again simply because the prior model session disappeared.

---

# 15. Idempotency and Side-Effect Safety

External actions can succeed even when the client does not receive a response.

Therefore every consequential action should support an idempotency strategy where practical.

Examples:

## Course Registration

Before retrying submission:

- check the account’s current registrations;
- inspect the confirmation page state;
- search email for a confirmation;
- compare the course identity and user identity.

## Calendar Creation

Store a stable external key such as:

```text
registration_confirmation_id
```

Before creating another event, check whether an event for that key already exists.

The objective is **at-most-once external side effects** where possible, even when internal attempts are retried.

---

# 16. Verification and Evidence

A tool call returning successfully is not sufficient evidence that the real-world goal succeeded.

Each workflow defines postconditions.

Example:

```text
clicked "Submit"
≠ registration completed
```

Valid evidence may include:

- confirmation number;
- success page text;
- account registration entry;
- confirmation email;
- created Calendar event ID;
- expected database state;
- expected Git commit or PR state.

Agent outputs should be structured, for example:

```json
{
  "status": "success",
  "nextAction": "verify_email",
  "evidence": [
    {
      "type": "confirmation_number",
      "value": "ABC123"
    }
  ]
}
```

Malformed output is rejected and retried according to policy.

---

# 17. Human-in-the-Loop Policy

The platform is intended to operate autonomously, but human interaction remains useful at specific boundaries.

## 17.1 Human-Owned Decisions

The user primarily owns:

- product direction;
- new goals;
- subjective preferences;
- major architecture choices;
- approval of significant new system behavior when discussion is useful.

## 17.2 Pre-Authorized Autonomous Actions

The user can explicitly authorize classes of actions, for example:

- register for matching free courses;
- create Calendar events after confirmation;
- run recurring research jobs;
- modify the personal app after approved planning;
- auto-merge development changes that satisfy quality gates.

## 17.3 Human Escalation

The workflow may pause for:

- CAPTCHA;
- OTP / 2FA;
- 3-D Secure;
- identity checks;
- legally meaningful declarations requiring user action;
- ambiguous high-impact decisions;
- repeated unrecoverable failures.

The desired behavior is not to abandon the workflow. It should preserve state, request the smallest required human step, then resume.

---

# 18. Prompt Injection and Trust Boundaries

The system will routinely process untrusted external content.

Treat the following as **untrusted data**:

- web pages;
- emails;
- third-party API responses;
- uploaded files;
- scraped text.

Treat the following as **trusted instructions**:

- user commands;
- system policies;
- stored automation definitions;
- application configuration;
- approved architecture rules.

External text must never automatically gain instruction authority.

Security depends on:

- minimal tool exposure;
- tool-level permissions;
- isolated execution;
- hidden credentials;
- schema validation;
- side-effect policies;
- explicit state machines;
- audit logs.

---

# 19. Secrets and Credentials

Models should not receive raw credentials.

```text
Agent
  ↓
calendar.create_event(...)
  ↓
Tool Gateway
  ↓
credential store / OAuth session
  ↓
Google Calendar API
```

The agent only receives the action result, not refresh tokens, passwords, or API secrets.

For browser workflows, prefer a controlled persistent browser profile or OAuth session over putting usernames and passwords into prompts.

---

## 19.1 Phase 1 Credential Bootstrap

Phase 1 requires explicit local setup for credentials that cannot be generated by an agent.

Expected configuration includes:

```text
OPENAI_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
Google OAuth refresh/session material
GitHub credentials required for CI/deployment, where applicable
```

Rules:

- never commit secrets;
- never include secrets in prompts, model context, tool summaries, traces, or persisted agent messages;
- adapters may access secrets at execution time;
- browser login state should use a protected persistent Playwright profile when appropriate;
- setup documentation must describe exact manual OAuth/bootstrap steps;
- tests use fakes/mocks or dedicated test credentials and must not require the user's production account.

---

# 20. Retry and Failure Classification

Retry behavior should be deterministic by failure class.

```text
Network timeout
→ deterministic retry with backoff

Rate limit
→ wait / backoff using retry metadata

Malformed structured model output
→ model retry

Insufficient reasoning
→ stronger model profile

Website layout changed
→ browser re-observation and re-plan

Tool repeatedly unreliable
→ improvement proposal or development task

Repeated unrecoverable failure
→ BLOCKED / human notification
```

Do not treat every failure as a reason to “ask the model again.”

---

# 21. Development and Self-Evolution Loop

When the system needs a new durable capability, it enters the development loop.

Sources of development work include:

- explicit user feature requests;
- approved planning discussions;
- bugs discovered during use;
- repeated automation failures;
- a generic browser workflow that should become a dedicated adapter;
- poor performance or excessive cost;
- missing tool capability.

## 21.1 Development Flow

```text
Idea / capability gap
       ↓
Planning discussion if needed
       ↓
Approved specification
       ↓
Task decomposition
       ↓
Task DB
       ↓
Agent Supervisor
       ↓
Context Compiler
       ↓
Coder Agent
       ↓
PR
   ┌───┴───┐
   ▼       ▼
Reviewer   CI
   └───┬───┘
       ▼
Quality Gate
       │
       ├── FAIL → feedback → coder retry
       │
       └── PASS
              ↓
          Auto Merge
              ↓
          Direct Deploy
```

## 21.2 Independent Review

The reviewer should use a fresh session and preferably an independent model profile from the coder.

Inputs:

- task specification;
- acceptance criteria;
- architecture rules;
- Git diff;
- relevant source files;
- test results;
- coverage results.

Review for:

- correctness;
- edge cases;
- failure handling;
- concurrency;
- architecture violations;
- security;
- unnecessary complexity;
- test quality;
- maintainability.

The reviewer returns structured `APPROVE` or `REQUEST_CHANGES` findings.

---

# 22. CI and Quality Gates

For owned executable code, **100% test coverage is a hard merge requirement**.

Required metrics:

```text
Statements: 100%
Branches:   100%
Functions:  100%
Lines:      100%
```

A merge requires all applicable checks:

- unit tests;
- integration tests;
- E2E tests where appropriate;
- 100% statements coverage;
- 100% branches coverage;
- 100% functions coverage;
- 100% lines coverage;
- type checking;
- lint;
- build;
- security checks;
- independent reviewer approval.

## 22.1 Coverage Integrity

Agents may not escape the coverage gate by silently adding new exclusions.

Examples of prohibited behavior without explicit repository policy:

- `istanbul ignore` additions;
- arbitrary coverage ignore patterns;
- excluding files solely because they are difficult to test.

Generated code, vendored code, and pure declarations can be excluded at repository-policy level where appropriate.

## 22.2 Coverage Is Necessary, Not Sufficient

The reviewer must inspect whether tests assert meaningful behavior rather than merely executing lines.

Important paths should test:

- happy path;
- boundary conditions;
- invalid input;
- error handling;
- retries;
- timeouts;
- state transitions;
- side effects;
- idempotency where relevant.

Mutation testing may later be enabled selectively for critical modules if needed.

---

# 23. Direct Deployment

After auto-merge to `main`, the system deploys directly to the running personal environment.

Recommended initial mechanism:

```text
merge main
   ↓
GitHub Actions
   ↓
self-hosted runner on the personal server / Mac mini
   ↓
./scripts/deploy.sh
   ↓
git fetch / checkout expected revision
   ↓
docker compose build
   ↓
docker compose up -d
   ↓
/health verification
```

The deploy runner must live outside the Docker Compose application stack so it can restart `app` and `worker` without killing the deployment mechanism itself.

No separate staging environment is required initially.

A deployment is not considered successful merely because containers started. The deploy script must verify the expected revision and health endpoint. If deployment itself fails, CI reports failure and the system remains on or returns to the last runnable revision using simple Git/Docker mechanics. A sophisticated rollout platform is intentionally deferred.

---

# 24. Observability

The MVP does not need an enterprise monitoring stack.

Start with:

- structured application logs;
- automation run history;
- tool-call logs;
- error table;
- task / agent-run history;
- deployment history;
- basic `/health` endpoint;
- optional lightweight usage and model-cost metrics.

These are sufficient to answer:

- what happened?
- which automation caused it?
- which model and tools were used?
- what failed?
- was it retried?
- what evidence proved success?
- which code change introduced the behavior?

A more advanced observability system can be added later if operational complexity justifies it.

---

# 25. Core Data Model

## 25.1 Automation

```json
{
  "id": "AUTO-001",
  "name": "VTC SUA Registration",
  "goal": "...",
  "schedule": "0 9 * * *",
  "enabled": true,
  "modelProfile": "GENERAL_AGENT",
  "toolPolicy": "course-registration",
  "createdAt": "...",
  "updatedAt": "...",
  "nextRunAt": "...",
  "lastRunAt": "..."
}
```

## 25.2 AutomationRun

```json
{
  "id": "ARUN-100",
  "automationId": "AUTO-001",
  "state": "VERIFYING",
  "attempt": 2,
  "startedAt": "...",
  "updatedAt": "...",
  "completedAt": null,
  "modelProfile": "GENERAL_AGENT",
  "result": null,
  "evidence": []
}
```

## 25.3 ToolCall

```json
{
  "id": "TCALL-900",
  "runId": "ARUN-100",
  "tool": "calendar.create_event",
  "status": "success",
  "idempotencyKey": "registration:ABC123",
  "requestedAt": "...",
  "completedAt": "...",
  "inputSummary": "...",
  "outputSummary": "..."
}
```

## 25.4 Development Task

```json
{
  "id": "TASK-123",
  "type": "feature",
  "title": "Add dedicated VTC course adapter",
  "description": "...",
  "status": "READY",
  "priority": 7,
  "acceptanceCriteria": [],
  "baseCommit": "abc123",
  "sourceAutomation": "AUTO-001"
}
```

## 25.5 AgentRun

```json
{
  "id": "RUN-456",
  "taskId": "TASK-123",
  "role": "coder",
  "attempt": 1,
  "modelProfile": "CODER",
  "startCommit": "abc123",
  "resultBranch": "agent/TASK-123/attempt-1",
  "status": "completed",
  "testsPassed": true,
  "coveragePassed": true,
  "summary": "..."
}
```

---

# 26. Development Task State Machine

```text
DRAFT
  ↓
PLANNING
  ↓
AWAITING_PLAN_APPROVAL
  ↓
READY
  ↓
CODING
  ↓
REVIEWING
  ↓
VALIDATING
  │
  ├── failure → FIX_REQUIRED → CODING
  │
  └── pass
       ↓
   MERGE_READY
       ↓
     MERGED
       ↓
    DEPLOYING
       ↓
   COMPLETED
```

Exceptional states:

```text
BLOCKED
FAILED
CANCELLED
```

The state lives in PostgreSQL, not in the conversation.

---

# 27. Example End-to-End Workflow: Course Registration

User instruction:

> “Every day, check for an evening SUA Advanced Rating course near Tsuen Wan. If a suitable course has space and I am eligible, register me. After confirmation, add it to Google Calendar.”

## Creation

```text
User
 ↓
Intent Router → AUTOMATION_CREATE
 ↓
Planner clarifies criteria if necessary
 ↓
Automation stored
```

## Daily Execution

```text
Scheduler fires
 ↓
AutomationRun created
 ↓
Capability Resolver
 ↓
Allowed tools:
- browser
- Gmail
- Calendar
 ↓
General Agent starts
 ↓
Browser searches course site
 ↓
Candidate found?
 ├─ no → record result → complete run
 └─ yes
      ↓
   validate course criteria
      ↓
   fill form
      ↓
   read back form summary
      ↓
   submit
      ↓
   verify confirmation
      ↓
   Gmail confirmation if necessary
      ↓
   Calendar create with idempotency key
      ↓
   verify event exists
      ↓
   Automation marked completed if configured to stop after success
```

If CAPTCHA or OTP appears:

```text
persist current state
 ↓
NEEDS_HUMAN
 ↓
user completes required step
 ↓
resume same AutomationRun
```

---

# 28. Example Self-Evolution Workflow

Assume the VTC workflow repeatedly fails because browser extraction is unreliable.

```text
Automation failures accumulate
       ↓
Evaluator identifies repeated pattern
       ↓
Proposal:
"Build dedicated VTC course adapter"
       ↓
User approves direction if required
       ↓
Development task
       ↓
Coder Agent
       ↓
Reviewer Agent
       ↓
CI + 100% coverage
       ↓
Auto merge
       ↓
Direct deploy
       ↓
Tool Registry now exposes:
- vtc.search_courses
- vtc.get_course
- vtc.register_course
```

The automation can then use the dedicated tool instead of generic browser navigation.

The platform therefore evolves from generic interaction toward reliable domain-specific capabilities only where justified by actual use.

---

# 29. Monorepo Structure

Keep the initial codebase compact.

```text
personal-agent/
│
├── apps/
│   ├── app/                 # web UI + API + chat
│   └── worker/              # scheduler + control plane + agent runner
│
├── packages/
│   ├── db/                  # schema and repositories
│   ├── agents/              # model interfaces and role prompts
│   ├── tools/               # tool registry and adapters
│   └── shared/              # shared types / utilities
│
├── docs/
│   ├── architecture.md
│   ├── decisions/
│   └── policies/
│
├── AGENTS.md
├── docker-compose.yml
└── package.json
```

Inside `apps/worker`, components can initially remain simple modules rather than separate packages:

```text
worker/src/
├── scheduler.ts
├── control-plane.ts
├── intent-router.ts
├── model-router.ts
├── capability-resolver.ts
├── policy.ts
├── runner.ts
├── context-compiler.ts
├── supervisor.ts
└── evaluator.ts
```

Do not split these into independent services until a real scaling or ownership boundary requires it.

---

# 30. Runtime Deployment

Initial always-on runtime:

```text
Mac mini / personal server
│
├── postgres
├── app
└── worker
```

The AI models themselves are not continuously running.

The worker waits for:

- due automations;
- user actions;
- development tasks;
- webhook events;
- retries.

When work appears, it launches a disposable agent run. After completion, the model session ends.

This keeps the system available 24/7 without continuously consuming model tokens.

---

# 31. Implementation Strategy

## 31.1 Phase 1 — The Only Initial Implementation Target

Build one complete useful workflow before autonomous development.

```text
Chat / command
  ↓
Create automation
  ↓
Persist automation
  ↓
Scheduler wakes it
  ↓
Create durable AutomationRun
  ↓
Resolve minimal capabilities
  ↓
Select model profile
  ↓
Fresh agent
  ↓
Browser / Gmail / Calendar tools
  ↓
Verify real-world outcome
  ↓
Persist result + evidence + history
```

Phase 1 includes:

- PostgreSQL schema and migrations;
- Next.js app with minimal Chat/Command, Automations, and Runs/Activity surfaces;
- worker process;
- scheduler;
- durable AutomationRun state;
- model profiles and deterministic router;
- capability resolver;
- tool registry;
- browser adapter;
- Gmail adapter;
- Calendar adapter;
- normalized `ToolResult`;
- idempotency and verification hooks;
- audit/run history;
- credential bootstrap documentation;
- Docker Compose local runtime;
- CI with the required quality gates.

### Phase 1 Definition of Done

Phase 1 is complete only when all of the following are true:

1. A user can create an automation from natural language.
2. The automation is stored durably in PostgreSQL.
3. Restarting `app`, `worker`, or the host does not lose automation definitions.
4. A due schedule creates exactly one run for a given `(automation_id, scheduled_for)`.
5. The same automation cannot accidentally execute overlapping runs under the default policy.
6. Every run loads a fresh model session from durable state.
7. Each run receives only the tools resolved for that task.
8. The general agent can use the browser, search/read Gmail, and create a Calendar event through adapters.
9. Every tool call is logged with normalized status and safe summaries.
10. Consequential tool calls support duplicate protection or explicit verification before retry.
11. `unknown` side-effect outcomes enter verification rather than blind retry.
12. A crashed or interrupted run can resume from persisted workflow state.
13. A successful workflow stores evidence proving completion.
14. Calendar creation is idempotent under retries.
15. The user can inspect automations, latest run state, result, and tool-call history.
16. Secrets never appear in model context or persisted tool summaries.
17. `docker compose up` starts the complete application runtime from documented setup.
18. Database migrations work from a clean database.
19. Lint passes.
20. Typecheck passes.
21. Build passes.
22. All tests pass.
23. Owned executable code reports exactly **100% statements, 100% branches, 100% functions, and 100% lines coverage**.
24. No new coverage exclusions are introduced merely to satisfy the gate.
25. A clean-checkout setup/run guide is complete and reproducible except for real external credentials.

**Do not implement Phase 2 or Phase 3 until every Phase 1 criterion is satisfied.**

## 31.2 Phase 2 — Autonomous Development Loop

After Phase 1 is useful in daily operation, add:

- development task state machine;
- Git worktrees;
- Context Compiler;
- coding-agent adapter (Codex or equivalent behind an interface);
- independent reviewer agent;
- CI-driven quality gate;
- automatic coder retry from review/CI findings;
- automatic merge;
- direct deployment through the mechanism in Section 23.

The implementation agent must preserve the same principle: coding models can propose and modify code, but Git, CI, coverage, state transitions, and merge/deploy authority remain deterministic.

## 31.3 Phase 3 — Self-Improvement

Only after the ACT runtime and development loop are proven:

- detect repeated operational failures;
- identify capability gaps;
- propose dedicated tools when generic browser workflows are unreliable;
- connect approved proposals to development tasks;
- collect model/tool success metrics;
- improve routing policies from evidence;
- evolve generic workflows into reliable domain-specific tools where usage justifies the maintenance cost.

## 31.4 Bootstrap Rule

During Stage 0 and Phase 1, the user manually uses Codex as the development agent. The platform does **not** need to invoke Codex programmatically yet. This avoids requiring the system to self-host its own development loop before its basic operator runtime exists.

---

# 32. What We Intentionally Do Not Build Yet

To avoid losing the project inside infrastructure work, the following are deferred until a concrete requirement appears:

```text
Temporal
Redis
Kafka
Kubernetes
separate staging environment
canary deploys
full feature-flag platform
enterprise observability stack
large microservice decomposition
complex multi-agent society
custom adapter for every website
```

The system should first prove that one user can reliably say:

> “Do this for me, keep doing it, and improve yourself when necessary.”

and have the platform actually complete the end-to-end task.

---

# 33. Codex Implementation Handoff

This document is intended to be directly usable as the project source of truth.

When bootstrapping the repository, give Codex this instruction together with this file:

```text
Read this design document completely before making changes.
Treat it as the source of truth for product intent, architecture, scope, and quality gates.

Implement PHASE 1 ONLY. Do not implement Phase 2 or Phase 3 yet.

Before coding:
1. Identify only genuine blockers required for Phase 1.
2. Create docs/implementation-plan.md mapping Phase 1 Definition of Done to implementation milestones.
3. Bootstrap the pinned TypeScript-first monorepo and document all assumptions.

While implementing:
- keep the architecture simple;
- use existing maintained libraries instead of rebuilding generic infrastructure;
- keep state durable in PostgreSQL;
- keep model sessions disposable;
- keep secrets out of model context and logs;
- use typed schemas and structured results;
- implement idempotency and verification for side effects;
- write meaningful tests with the production code;
- maintain 100% statements, branches, functions, and lines coverage for owned executable code;
- do not add coverage exclusions merely to pass CI;
- run lint, typecheck, tests, coverage, and build after meaningful milestones;
- do not introduce Redis, Temporal, Kafka, Kubernetes, staging, canary deployments, LangGraph, or additional services without an explicit requirement from this document.

For Google OAuth or other external credentials:
- implement the integration and exact setup instructions;
- never invent credentials;
- never commit secrets;
- continue all work that does not require the missing credential.

Continue autonomously until every Phase 1 Definition of Done criterion is satisfied or a genuine product/credential blocker remains.

Before declaring completion:
- verify a clean checkout setup;
- verify migrations from an empty database;
- verify scheduler deduplication;
- verify restart/resume behavior;
- verify side-effect idempotency;
- verify audit history;
- verify secrets are not exposed;
- verify 100% coverage;
- update the runbook with exact start, test, and setup commands.
```

Codex may create an implementation plan and ADRs, but it must not silently change the fixed decisions in Sections 1.1, 6, 13, 21, 23, or 31.

---

# 34. Final System Definition

The project is a **human-directed, machine-operated personal agent platform**.

The human owns:

```text
vision
preferences
goals
ideas
subjective judgement
major product direction
```

The platform owns:

```text
reasoning
research
scheduling
automation
browser actions
email operations
calendar operations
tool orchestration
workflow state
retries
verification
model selection
software implementation
code review
testing
100% coverage enforcement
auto merge
direct deployment
operational iteration
```

The system has three modes:

```text
THINK
- research
- reason
- discuss
- plan

ACT
- use browser
- use email
- use calendar
- call APIs
- run scheduled jobs
- complete real-world workflows

EVOLVE
- detect missing capability
- plan a software change
- code it
- review it
- test it
- merge it
- deploy it
- use the new capability in future work
```

The key architectural separation is:

> **Models supply intelligence. The Control Plane supplies authority, persistence, verification, and reliability.**

That separation allows the platform to remain flexible enough to use increasingly capable models while keeping real-world actions and software changes under deterministic system control.


---

# 35. Final Acceptance Summary

The architecture is considered successfully implemented when it proves the following progression:

```text
THINK
User can ask and plan.

ACT
User can give a recurring goal once; the platform wakes itself, uses the minimum necessary tools, completes or safely pauses the workflow, verifies the outcome, and records evidence.

EVOLVE
After ACT is proven, the platform can safely turn approved capability gaps into tested, independently reviewed, automatically merged and deployed software improvements.
```

The product is valuable only if it reduces repeated manual digital work. The engineering system exists to support that goal, not to become the goal itself.
