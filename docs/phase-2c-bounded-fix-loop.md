# Phase 2C — Bounded Autonomous Fix Loop

## Status

Phase 2C is authorized for design and implementation only after Phase 2B is complete.

Phase 2C does not authorize merge, push, deployment, self-generated tasks, specification changes, or Phase 3 self-improvement.

## Human-approved v1 recovery refinement

This is a human-approved scope refinement from **automatic restart-safe continuation**
to **restart-safe authority preservation + deterministic fail-closed escalation**.
Candidate E was rejected under the superseded stronger recovery contract; that
review is not being reinterpreted. Phase 2C v1 requires bounded autonomous work
only while an execution has an active lease. It does not require automatic
continuation after arbitrary process or machine crashes, multi-worker takeover,
or ambiguous external-resource ownership.

When an interrupted `preparing`, `implementing`, `testing`, `fix_required`, or
`interrupted` execution cannot be completed by a cheap deterministic
reconciliation, recovery must transition to `needs_human`. It must never return
`undefined` while leaving a task active. A valid captured candidate remains
reviewable from PostgreSQL plus its trusted Git ref; Implementer workspace and
container teardown are operational cleanup debt, not candidate authority.

Recovery does not reuse or destructively clean up an expired worker's workspace
or container. It performs no autonomous fix continuation after lease loss.
Full autonomous crash recovery, generation-fenced external resources, and
exactly-once external cleanup are explicitly deferred to a later authorized
hardening phase.

## Objective

Phase 2C allows the system to autonomously repair a candidate that received `REQUEST_CHANGES` from an independent Phase 2B Reviewer.

The system may:

1. consume durable Reviewer findings;
2. start a fresh bounded Implementer fix attempt;
3. produce a new exact candidate commit;
4. submit that new candidate to a fresh independent Reviewer;
5. repeat within a strict retry budget;
6. stop with either:

   * `APPROVE`; or
   * `needs_human`.

Core principle:

> The system may autonomously repair a rejected implementation, but it may not autonomously redefine what success means.

---

# 1. Authority Boundaries

Phase 2C may modify implementation code only within the authority of the existing DevelopmentTask.

It may not modify or weaken:

* task specification;
* acceptance criteria;
* approved architecture/design authority;
* Reviewer policy;
* security policy;
* test thresholds;
* coverage requirements;
* budget limits;
* phase boundaries.

If resolving a finding requires changing any of the above, Phase 2C must stop and escalate to a human.

Reviewer findings authorize repair work; they do not create new product scope.

---

# 2. Entry Condition

The fix loop may start only when all of the following are true:

* a DevelopmentTask exists;
* there is an exact durable rejected candidate;
* that candidate has a finalized independent Reviewer result of `REQUEST_CHANGES`;
* the review remains authoritative for that exact candidate;
* the task authority has not been invalidated;
* the findings are structurally valid and durably bound to the review;
* autonomous fix budget remains available;
* no human-escalation condition is active.

A stale, invalidated, superseded, incomplete, or non-authoritative review must never start a fix attempt.

---

# 3. Candidate Lineage

Every fix iteration creates a new implementation attempt and a new immutable candidate.

Never mutate or reinterpret an existing candidate.

Example:

```text
Candidate A
  ↓ REQUEST_CHANGES
Fix Attempt 1
  ↓
Candidate B
  ↓ REQUEST_CHANGES
Fix Attempt 2
  ↓
Candidate C
  ↓ APPROVE
```

Candidate B must durably reference:

* the DevelopmentTask;
* the previous candidate A;
* the authoritative review of A;
* the exact findings consumed;
* the fix-attempt number;
* its own exact Git commit;
* its own context digest.

Candidate identity is immutable after capture.

An approval for A can never authorize B or C.

---

# 4. Fix Attempt Context

Each fix attempt must run in a fresh bounded Implementer execution context.

The Fix Context Compiler may include:

* original approved task/specification;
* acceptance criteria;
* governing architecture/design authority;
* exact rejected candidate commit;
* rejected candidate diff;
* relevant candidate source;
* authoritative Reviewer findings;
* deterministic test/CI evidence;
* bounded previous-attempt metadata;
* current fix-loop budget and policy.

It must not include correctness-critical dependency on:

* previous Pi session state;
* hidden Reviewer reasoning;
* Reviewer transcript;
* Implementer transcript;
* model memory;
* compaction state.

Durable findings are the interface between Reviewer and Implementer.

---

# 5. Session Policy

Each new fix attempt uses a fresh Implementer session.

Each review uses a fresh independent Reviewer session.

A Reviewer session must never be reused as an Implementer session.

If a fix attempt process/session crashes before the attempt is durably complete,
recovery inspects PostgreSQL and Git but does not reconstruct process-local
orchestration position. If no safely captured candidate exists, it marks the
fix attempt `needs_human`. It never starts a fresh fix session solely because a
lease expired. Session state is optimization only, never authority.

---

# 6. Fix Scope

A fix attempt should resolve all currently authoritative Blocking and Major findings that are within the existing task contract.

Supporting implementation changes are permitted when reasonably necessary to resolve those findings.

The Implementer may not:

* add unrelated features;
* redesign unrelated modules;
* broaden product scope;
* change acceptance criteria;
* alter Reviewer rules;
* disable or weaken tests;
* reduce coverage;
* bypass security controls;
* change phase policy;
* merge or deploy.

Minor findings may be included according to policy, but autonomous progress must never depend on cosmetic or optional hardening work.

---

# 7. Autonomous Retry Budget

Default maximum:

```text
max_fix_iterations = 3
```

One iteration means:

```text
REQUEST_CHANGES
→ one fresh fix attempt
→ one new candidate
→ one fresh independent review
```

The counter is durable and monotonic.

It must not reset through:

* process restart;
* session loss;
* worker reclamation;
* task status mutation;
* re-running the same candidate.

When the maximum is exhausted:

```text
needs_human
```

No fourth autonomous fix attempt may start without explicit human authorization.

---

# 8. Reviewer Behavior

Every new candidate receives a fresh Phase 2B-style independent review.

Reviewer authority and read-only capability rules remain unchanged.

The Reviewer evaluates the entire exact new candidate against:

* the original task;
* original acceptance criteria;
* governing architecture;
* current candidate;
* deterministic evidence.

It is not limited to checking only previous findings.

Therefore a Reviewer may identify new defects introduced by the fix.

Possible result:

```text
APPROVE
```

or:

```text
REQUEST_CHANGES
```

No Reviewer may directly start an Implementer.

The Phase 2C coordinator decides whether another bounded fix attempt is authorized.

---

# 9. Human Escalation Conditions

Phase 2C must stop with `needs_human` when any of the following occurs:

* retry budget exhausted;
* acceptance criteria are ambiguous or contradictory;
* Reviewer finding requires architecture/specification changes;
* task scope must expand materially;
* approved architecture conflicts with required correction;
* security/trust boundary must change;
* destructive or externally consequential action requires new approval;
* candidate/task authority is invalidated;
* durable state is inconsistent;
* exact candidate/review binding cannot be proven;
* required context cannot be reconstructed;
* repeated failure suggests non-convergence;
* policy or budget authority is missing.

Phase 2C must fail closed rather than guessing new authority.

---

# 10. Non-Convergence Detection

Phase 2C should include simple deterministic safeguards against useless loops.

Track at minimum:

* finding fingerprints;
* finding severity/category;
* candidate ancestry;
* changed paths;
* test outcome;
* review result;
* iteration count.

Escalate to human when, for example:

* the same Blocking/Major finding survives multiple consecutive candidates;
* a previously resolved finding repeatedly reappears;
* candidates oscillate between equivalent implementations;
* fixes create an increasing number of Blocking/Major findings;
* no meaningful implementation delta occurs;
* the same deterministic failure repeats without new evidence.

Do not attempt sophisticated semantic or ML-based convergence scoring in Phase 2C.

Simple conservative heuristics are sufficient.

---

# 11. Durable State

Phase 2C state must be reconstructable without LLM sessions.

The durable model must be able to answer:

* which rejected candidate triggered the fix loop;
* which authoritative review triggered it;
* which findings were consumed;
* current iteration number;
* current fix attempt;
* resulting candidate;
* resulting review;
* remaining retry budget;
* whether the loop is active, approved, exhausted, failed, or awaiting human action.

A useful conceptual lineage is:

```text
DevelopmentTask
  └─ Candidate A
      └─ Review A: REQUEST_CHANGES
          └─ FixAttempt 1
              └─ Candidate B
                  └─ Review B: REQUEST_CHANGES
                      └─ FixAttempt 2
                          └─ Candidate C
                              └─ Review C: APPROVE
```

Every transition must be fenced and restart-safe.

---

# 12. Concurrency and Fencing

Only one authoritative fix attempt may operate for a task/fix-loop generation at a time.

Use durable leases/generation fencing consistent with the proven Phase 2A/2B model.

Stale workers must not be able to:

* create a new candidate;
* consume findings twice;
* increment/decrement retry budget incorrectly;
* schedule duplicate reviews;
* finalize an obsolete fix attempt;
* overwrite a newer candidate.

Recovery must be idempotent.

Exactly one authoritative next step may be produced from one authoritative review result.

---

# 13. Failure Semantics

Infrastructure failure is not automatically equivalent to an implementation failure.

Classify failures at minimum into categories such as:

* implementation/review result;
* provider/session failure;
* timeout;
* deterministic test failure;
* sandbox failure;
* persistence failure;
* lease/fencing failure;
* integrity failure;
* policy/budget failure.

Do not consume a full autonomous fix iteration merely because infrastructure failed before a genuine fix candidate was durably produced, unless the existing architecture explicitly defines otherwise.

Retries for infrastructure failure must themselves be bounded.

---

# 14. Completion Conditions

Phase 2C succeeds for a DevelopmentTask when:

```text
new exact candidate
→ fresh independent Reviewer
→ APPROVE
```

The task then has an approved candidate but remains unmerged and undeployed.

Phase 2C stops without success when:

```text
needs_human
```

or a fail-closed terminal condition is reached.

Phase 2C does not merge, push, or deploy the candidate.

---

# 15. Explicitly Out of Scope

Phase 2C does not include:

* Git merge;
* push;
* pull-request merge;
* deployment;
* production rollout;
* automatic rollback;
* task generation;
* autonomous specification changes;
* architecture rewriting;
* acceptance-criteria rewriting;
* model-routing optimization;
* self-modifying skills;
* self-improvement;
* unlimited retries.

These belong to later explicitly authorized phases.

---

# 16. Minimum Acceptance Tests

Phase 2C should not be considered complete until tests prove at least:

1. one `REQUEST_CHANGES` produces one fresh fix attempt;
2. fix attempt creates a new exact candidate rather than mutating the old candidate;
3. new candidate receives a fresh independent Reviewer;
4. `REQUEST_CHANGES → fix → APPROVE` succeeds;
5. multiple bounded fix rounds succeed;
6. retry limit causes `needs_human`;
7. task/spec/acceptance criteria cannot be changed by the fix loop;
8. stale review cannot trigger a fix;
9. invalidated authority cannot trigger or continue a fix;
10. crash/session loss reconstructs from durable state;
11. stale workers are fenced;
12. concurrent coordinators cannot create duplicate authoritative attempts;
13. same review cannot be consumed twice;
14. infrastructure retry does not incorrectly reset or bypass the fix budget;
15. repeated/non-convergent findings escalate;
16. ambiguous interrupted fix/reviewer execution reaches `needs_human` without
    autonomous continuation;
17. Reviewer and Implementer sessions remain independent;
18. no Phase 2D merge/deploy capability exists;
19. Phase 1, Phase 2A, and Phase 2B regression suites remain green.

---

# Phase 2C Completion Definition

Phase 2C is complete when the system can safely and durably execute:

```text
authoritative REQUEST_CHANGES
        ↓
bounded fresh Implementer fix attempt
        ↓
new immutable candidate
        ↓
fresh independent Reviewer
        ↓
APPROVE
```

or stop deterministically at:

```text
needs_human
```

without redefining task authority, relying on persistent LLM sessions, exceeding bounded retry authority, or performing merge/deployment behavior.
