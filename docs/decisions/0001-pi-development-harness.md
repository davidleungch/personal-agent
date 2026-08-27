# ADR 0001: Pi Behind the DevelopmentHarness Boundary

## Status

Accepted

## Context

Phase 1 ACT is complete and uses the existing Action Agent Runtime, project-owned
model/runtime abstractions, the OpenAI Agents SDK, and the Tool Gateway. Phase 2
EVOLVE needs coding-agent loop, model, tool-call, session, and compaction
mechanics without transferring project authority or weakening the accepted ACT
runtime.

Pi Coding Agent SDK supplies useful coding-agent execution mechanics, but Pi is
not a security sandbox and its sessions are not durable workflow state. Direct
Control Plane dependence on Pi concepts would make task, review, CI, merge, and
deployment policy dependent on one replaceable framework.

## Decision

Phase 2 development execution goes through a project-owned
`DevelopmentHarness` interface. The initial implementation is an adapter for Pi
Coding Agent SDK.

The Control Plane owns development-task lifecycle, context policy, role and tool
policy, budgets, retries, audit, review, CI, merge, and deployment decisions. It
depends on `DevelopmentHarness`, not Pi-specific business or domain concepts.
PostgreSQL remains development-workflow authority, Git remains source and
revision authority, and approved repository documents remain specification and
architecture authority.

Pi does not replace or enter the Phase 1 ACT runtime. Pi sessions and compaction
are non-authoritative, task-local execution conveniences. Losing a session must
not prevent reconstruction from PostgreSQL, Git, and approved repository
documents.

Development execution is externally sandboxed. Pi receives only explicit,
project-owned, role-scoped sandbox tools; it does not receive unrestricted host
filesystem or shell tools.

## Alternatives considered

- Replace ACT with Pi: rejected because ACT has accepted real-world action,
  completion, idempotency, verification, and Tool Gateway guarantees that are a
  separate runtime concern.
- Depend on Pi directly from the Control Plane: rejected because framework
  sessions and provider concepts would leak into authoritative domain state.
- Build a custom coding-agent loop first: rejected because Pi already provides
  the required generic mechanics and no concrete need justifies duplicating
  them.
- Run unattended Pi with its host filesystem and shell tools: rejected because
  Pi process permissions are not an isolation boundary.

## Consequences

- Phase 2 must define and test a small stable `DevelopmentHarness` contract and
  a Pi adapter.
- Some Pi features may be unavailable unless they can operate through approved
  project-owned tools and bounded context.
- The trusted development runner must manage model credentials and an external
  sandbox boundary, adding a deliberate execution component outside the normal
  application Compose trust boundary.
- Harness events and failures must be normalized before they affect durable
  state. Pi transcripts, hidden reasoning, and compaction summaries are not
  persisted as authority.
- No alternative harness is implemented until a concrete need exists.

## Security invariants

- Autonomous development always executes inside an external OS/container/VM
  isolation boundary.
- Unattended runs expose no unrestricted host shell, host filesystem, Docker
  socket, personal credentials, production credentials, or host Pi state.
- Model/provider credentials remain in the trusted runner and outside sandbox
  processes wherever practical.
- The application worker does not receive the Docker socket or unrestricted
  host execution capability.
- Mutable repository `.pi/extensions` are not automatically trusted or loaded.
  Only reviewed, runner-owned resources may execute with Pi process privileges.
- Sandbox tools validate scope and operate only on the approved isolated
  workspace. Repository content and tool output cannot grant capabilities.
- Pi must not receive any model-facing filesystem or command capability that
  bypasses the project-owned Sandbox Gateway, even when the trusted runner itself
  has broader host privileges.
- A coding model cannot approve its own merge, merge directly, or deploy
  directly.

## Replacement boundary

A future coding-agent harness may replace the Pi adapter if it implements the
same project-owned contract and preserves the same sandbox, context, audit, and
budget invariants. Replacing the harness must not require rewriting development
task state, review policy, CI policy, merge policy, or deployment policy.
