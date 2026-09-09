# ADR 0002: Phase 2D v1 Exact-Candidate Merge and Bounded Deployment

## Status

Accepted by explicit human approval on 2026-09-09.

Phase 2D v1 contract/design is **APPROVED**. Implementation is **AUTHORIZED only
after this authority promotion is committed**, for a separately scoped fresh
session. Live activation and Phase 3 remain **NOT AUTHORIZED**. Implementation
has not started; this promotion stops at documentation commit/push.

## Context

[Design sections 22–24](../design.md#22-auto-merge) require deterministic merge
and exact-revision direct deployment. [Section 33](../design.md#33-architecture-change-policy)
requires an ADR for merge/deploy policy changes. The accepted Phase 2C result is
an immutable approved candidate, with restart-safe authority preservation and
fail-closed escalation. It is not release authority.

The human approved the bounded v1 contract and GitHub Actions transport in the
[reviewed proposal](../proposals/phase-2d-contract-proposal.md) after Astra
challenge and Luna independent verification. This ADR records that policy;
[the governing Phase 2D contract](../phase-2d-merge-deploy.md) contains the exact
predicates, protocols, state model, budgets and acceptance matrix, incorporated
by the [Phase 2 implementation plan](../phase-2-implementation-plan.md#phase-2d--auto-merge-and-deploy).

## Decision

- Preserve the terminal Phase 2C task and acceptance history. PostgreSQL owns a
  separate bounded CI-validation and release lifecycle; Git owns exact source
  identity. No model participates in release authority.
- Admit only the current approved task's latest succeeded candidate C with
  finalized independent exact-C APPROVE, intact full original-base B..C lineage,
  current governing policy and independently issued exact-C CI evidence.
- Use GitHub Actions with create-only immutable candidate publication, a trusted
  trigger and authenticated result import. Persist intent before these actions;
  freeze successful receipts bound to durable task/attempt/review/validation and
  candidate identity. CI success alone cannot grant merge/deploy authority.
- Merge only C by single-target strict B-to-C fast-forward expected-old-SHA CAS.
  Guard explicit `--force-with-lease=refs/heads/main:B` independently with strict
  ancestry checks; no history rewrite, deletion, rebase, squash or merge commit.
  Drift escalates. Lost acknowledgements reconcile exact remote state against
  prior intent, without blind redispatch or exactly-once claims.
- Deploy only app/worker artifacts built from exact C to one enrolled Linux
  Docker daemon/Compose project. Bind trusted build provenance, immutable local
  image IDs, manifest and observed containers/health to C and the release ID.
  Verify the unchanged migration ledger read-only. Do not run candidate-built
  privileged migrators or implicit migration/dependency jobs during releases.
- Use ordered short DB transactions, fresh PostgreSQL time, fenced generations,
  explicit monotonic counters, durable reservations and a host lock. Lease expiry
  grants reconciliation authority, not competing external-write authority. An
  admitted in-flight external effect cannot be undone by a DB fence.
- Separate runtime, CI issuer, release and maintenance capabilities using narrow
  trusted DB gates and actual grants. Keep host/Docker/merge/deploy credentials
  outside models, candidate builds and ordinary application authority.
- Fail closed to durable human escalation on failed/ambiguous deployment or
  health. No automatic rollback or arbitrary crash continuation. Human hold
  resolution does not replay writes, reset budgets or revive terminal releases.
- Exclude task creation, policy/specification changes, fix-loop invocation and
  Phase 3 authority from the release path, including production DB grants.

## Activation and scope

H1/H2 contract choices are resolved. H3/H4 enrollment remains unapproved: exact
repository/main target, one actual Linux host, Compose project, persistent
volume identity/ownership, credentials and capabilities must be separately
confirmed and verified. No production credentials or host are invented here.
Fixture implementation may proceed in a separately scoped session after the
promotion commit; live activation remains disabled. Stop for review at each
implementation milestone and before integrated Phase 2 acceptance.

The app/worker-only automatic release envelope does not forbid human-directed
implementation of Phase 2D schema/gates. Bootstrap and maintenance use separately
pinned trusted tooling under separate authority. Phase 1/2A/2B/2C contracts and
acceptance history are unchanged; design section 24.4's durable failure/fix work
is satisfied by release evidence for human-directed follow-up, without creating
an autonomous development task.

## Consequences and alternatives

Strict original-base CAS rejects even an intervening target advance that remains
an ancestor of C; ordinary fast-forward push cannot enforce this contract.
A changed candidate requires fresh task/review/CI authority. Unresolved external
work holds the target and may require human quiescence proof, sacrificing
availability to preserve authority. Read-only ledger verification keeps
privileged migration execution out of candidate-built artifacts.

One concrete Compose adapter and local immutable image IDs avoid a speculative
registry abstraction or orchestration service. Generic deployment plugins,
multi-environment management, automatic rollback, Temporal-style continuation,
external exactly-once claims and Phase 3 remain deferred. A01–A29 in the governing
contract are required future tests, not implementation acceptance claimed here.
