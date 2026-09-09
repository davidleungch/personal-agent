# Phase 2D v1 — Exact-Candidate Merge and Bounded Deployment

## 1. Status, authority and provenance

Human-approved on 2026-09-09. This is the governing Phase 2D v1 contract,
incorporated by the [Phase 2 implementation plan](phase-2-implementation-plan.md#phase-2d--auto-merge-and-deploy)
and [ADR 0002](decisions/0002-phase-2d-v1-merge-deploy.md).
It refines [design.md](design.md) without changing Phase 1/2A/2B/2C acceptance.

| Boundary | Recorded status |
| --- | --- |
| Phase 2D v1 contract/design | **APPROVED** |
| Phase 2D v1 implementation | **AUTHORIZED only after this authority promotion is committed** |
| Phase 2D live activation | **NOT AUTHORIZED** |
| Phase 3 | **NOT AUTHORIZED** |

Implementation has not started. Once this promotion is committed, implementation
planning and implementation against this contract are authorized for a separately
scoped fresh session. This promotion session stops at documentation commit/push.
Review and stop at each implementation milestone; completion does not implicitly
start the next milestone or integrated Phase 2 acceptance.

The accepted source is the [reviewed proposal](proposals/phase-2d-contract-proposal.md),
prepared against `d44ea683dbab6b672e588db753d379d1a1ee8f8b`, with Astra challenge
and Luna independent verification recorded in its section 18. Its bytes are
preserved as historical review evidence, including its then-unapproved status.
The SHA256 of the promoted source file is `2ebdd204ad2b20c8a97e98a72b870a76e3e29677bc18c159aba904fed23e1f0b`.
That digest identifies this source snapshot; the earlier revised-text digest in
the proposal identifies an earlier review snapshot, not these final bytes.

Proposal sections 2–16 are promoted below with approval/authority wording updated;
section numbering is retained for traceability. Record/interface names describe
required future implementation, not existing code. H1/H2 are resolved by human
approval in section 17; H3/H4 remain activation prerequisites. The proposal's
unapproved status and the earlier Phase 2C documents' Phase 2D stop statements
are historical, superseded only for Phase 2D by this explicit approval.
Phase 2C recovery, retry limits, rejected candidates and acceptance remain intact.

> Deterministic code owns authority; CI supplies independently verifiable evidence
> and performs only explicitly authorized external actions.

CI success alone cannot create merge/deploy authority. Every imported result
must bind the exact durable operation, task and candidate identity.

## 2. Approved v1 scope

One explicitly enrolled repository, one Git remote, `refs/heads/main`, one
Linux deployment host and one Compose project. A deterministic host runner
consumes an already human-approved task's exact current approved candidate,
obtains independent exact-candidate CI evidence, fast-forwards the remote target
to that commit, builds that commit, applies its pinned release and verifies it.

Ordinary automatic releases update app/worker artifacts only and verify the
unchanged migration ledger read-only. Schema/grant bootstrap and changes to
migration, policy or deployment infrastructure remain separately human-directed
maintenance outside this v1 automatic release path.

Use one separate release lifecycle, a durable exclusive target/environment
reservation, and bounded action records. No model invocation occurs in 2D.
Keep `DevelopmentTask.status = approved_candidate` as the completed 2C result;
show release status separately. A release failure is durable failure evidence
for human-directed follow-up, satisfying design section 24.4 without generating
new development work. Phase 2 integrated acceptance remains a separate stop.

## 3. Explicit non-goals

No rebase, squash, merge commits, GitHub merge API, force-rewrite, branch deletion,
automatic candidate regeneration, automatic re-review, automatic rollback,
registry publication, promotion, multi-environment orchestration, external
resource takeover, arbitrary crash continuation, generic workflow engine,
staging/canaries, new always-running application service or exactly-once claims.
No Phase 3 detection, task creation, policy rewriting or self-improvement.

No changes to Phase 2C retry budgets or its accepted cleanup/recovery semantics.
No speculative deployment-provider abstraction: one concrete Compose adapter
with narrow operations and a deterministic fake for tests.

## 4. Entry authority predicate

Define `B` = task original base, `I` = latest implementation attempt, `C` = its
candidate commit, `R` = its independent review. Admission is a relational
predicate evaluated under the locks in section 7, not a caller-supplied flag.

| Required predicate | Source of truth / validation |
| --- | --- |
| 2D enabled for enrolled repo/target/environment by human policy | Host-owned immutable policy revision; not candidate files, task prose or model output |
| Task exists, status exactly `approved_candidate`, approvedAt present, no invalidation, no inconsistent human reason | Locked `development_tasks` row |
| Spec/criteria/base/approval are the executed immutable contract and remain current | Task row, existing immutability triggers, review manifest; hash canonical spec/criteria into release binding |
| Governing authority is still current | Review authority blob IDs must equal the host-enrolled current authority catalog, including ADRs; pin catalog digest in release; any mismatch needs human direction, never implicit approval inheritance |
| I is the latest attempt of any status; no later failed, active or successful attempt supersedes it | All task attempts ordered by unique attemptNumber; task lock serializes insertion; no “latest successful” shortcut |
| I succeeded, failureClass null, complete paired candidate fields, valid context/budget/usage and lineage | Attempt row plus schemas/DB constraints |
| R belongs to same task and I, succeeded, finalized/completed, cleanup succeeded, failureClass null | Review row and existing finalization/proposal/cleanup event authority |
| R decision APPROVE with exactly zero findings; context/policy/manifest/digest reconstruct and match | Strict review schemas, original task authority blobs and durable policy; independently validate all prerequisites |
| R.baseCommit = B; R.candidateCommit = I.candidateCommit = C; R.candidateRef = I.candidateRef | Locked task/attempt/review joins |
| Candidate ref has exact deterministic name and resolves to C; review retention ref resolves to C; C exists | Trusted Git object/ref inspection; neither mutable ref can override the stored SHA |
| Every fix lineage link is intact and C is a strict descendant of B through captured single-parent commits | Git parent objects plus attempt parentCandidateCommit/sourceReviewId chain; initial candidate parent B |
| Target remote currently exactly B | Read actual enrolled remote ref, not local main or origin/main cache |
| Complete deterministic acceptance evidence for C from trusted CI, current policy, no unresolved blocking result | Frozen successful receipt of `ci_validations` record, independent issuer and required-check matrix |
| No prior release for this task; no unresolved action/reservation for target or environment | Required release uniqueness and durable reservation |

Separate **CI eligibility** from **release admission**: the same candidate and
review checks may permit bounded CI preparation before CI evidence exists.
Local inspection is read-only; candidate publication and CI triggering are
separately authorized consequential actions owned by section 15's validation
record. No
merge-capable release is admitted until all CI gates pass. Do not call CI absence
an authorized merge pending an eventual green status.

Finalized Reviewer lease expiry is not review expiry. A completed review remains
evidence until its candidate/task/policy authority is invalidated; 2D leases its
own release, never renews or reclaims the old Reviewer execution.

After release admission, repeat all relevant DB/policy/ref/evidence predicates
before each new consequential dispatch. Expected remote SHA becomes C after
verified merge. Persist observed invalidation as a release escalation without
rewriting completed 2C history. Missing authority never selects an older review.

## 5. Exact identity model and TOCTOU

```text
task original base B → candidate A → optional fixes → approved C
                                                  │
attempt C = candidate ref C = review C = exact CI checkout C
                                                  │
                                 remote main CAS B → C
                                                  │
                       exact clean build source C + tree digest
                                                  │
                   immutable per-service image IDs + release manifest
                                                  │
                       Compose runtime image IDs + release ID + C
```

Commit identity is mandatory even when two trees are equal. The final review
covers the complete B..C diff, not only the final fix. Earlier rejected commits
can be ancestors of C without receiving their own release authority.

Release manifest binds task/attempt/review/CI IDs, repo identity, B, C, tree ID,
policy revision, environment ID, release ID, platform, build recipe/context
digest and exact image IDs for app and worker. PostgreSQL and any enrolled
maintenance tooling have separately pinned identities, not falsely labeled C.
Ordinary releases do not execute a candidate-built privileged migrator.
Image labels such as `org.opencontainers.image.revision=C` are corroboration,
not proof by themselves. Trusted source acquisition/build receipt binds C to
the actual resulting image IDs. Record exact base image digests used.

TOCTOU checks cover discovery→DB lock; DB lock→dispatch; refs→object reads;
CI trigger→checkout→receipt import; remote observation→push; push→DB receipt;
checkout→build context; build→image selection; render→Compose apply; apply→health;
health→finalization; and lease loss at each boundary. Use immutable inputs,
non-expiring unresolved reservations, external CAS where available, and terminal
escalation where cross-system atomicity is unavailable. Mutable refs/tags and
freshness timestamps alone do not close these gaps.

## 6. Small durable state machine

Use `development_releases` plus typed append-only release events and bounded
`ci_validations` whose binding is immutable and whose successful receipt freezes.
Section 15 defines the pre-admission CI lifecycle and action journal. Keep image
manifest and bounded per-step intent/outcome metadata
on the release/events rather than adding services or a generic job framework.
A small enrolled-target row holds the active release reservation and last
verified current release. Uniqueness covers task release, repository/branch and
environment; unresolved `needs_human` with possible side effects retains its
reservation and blocks successors.

```text
approved_candidate (existing task; remains unchanged)
    + complete exact CI + entry predicate
    → release: merge_pending → merged → build_pending
                                       → deploy_pending → verifying → deployed
           any nonterminal → needs_human (reason + last proven facts)
```

`merged` means remotely verified C, not local branch advancement. `deployed`
means verified release at a recorded instant, not an eternal assertion about
future runtime state. No separate `blocked` release state is needed in v1;
`needs_human` carries precise failure class and possible-effect status.

| State | Durable authority / actor / entry | Permitted action and success | Retry / reconciliation / escalation |
| --- | --- | --- | --- |
| merge_pending | Full admission receipt, B/C and reservation; trusted release runner | Persist push intent then exact B→C push; verified remote C → merged | Read-only reconciliation; uncertain or moved target → needs_human; no blind push |
| merged | Verified remote C receipt; same release runner | Revalidate authority/remote, reserve build identity → build_pending | No replay of merge; remote missing/other SHA blocks deployment |
| build_pending | C, recipe/context/platform and build budget fixed | Isolated build; persist manifest with exact image IDs → deploy_pending | One bounded clean rebuild only after prior build conclusively stopped; inability to establish this → needs_human |
| deploy_pending | Manifest, expected unchanged migration ledger, current release precondition and exclusive environment reservation | Verify ledger read-only, persist apply intent; trusted host applies exact app/worker release → verifying | Persist substep outcomes; ambiguous apply never replayed automatically |
| verifying | Exact release/container/image identities, apply receipt and ledger observations | Read-only health/ledger/revision verification → deployed | Bounded reads while same release remains current; failed health, supersession or ambiguity → needs_human |
| deployed | All required evidence persisted atomically with completion event | Release reservation may be cleared after all dispatchers/jobs are known finished | Terminal; later deployments do not mutate historical success; environment projection points to latest verified release |
| needs_human | Reason, observations and unresolved action identity preserved | Terminal for automatic execution; human inspection and fenced hold-resolution only | No write replay or implicit resume; reservation retained until pending work and external state are resolved |

Each action has `not_started`, `started`, `success`, `failed` or `unknown` outcome
with deterministic retry class `retry_safe`, `reconciliation_required` or
`no_automatic_retry`. These are subordinate operation facts, not parallel
workflow engines. `started` must be durable before dispatch; success/unknown and
state change must be recorded with their events in one fenced transaction.

Minimum release fields: immutable binding IDs/hashes, B/C/ref, target/environment,
expected prior release, policy version, state/reason, lease owner/generation/
expiry, immutable deadlines/limits, counters, operation identities/outcomes,
merge receipt, image manifest, ledger/apply/health receipts and timestamps.
Validated bounded data only; no hidden reasoning, credentials or raw transcripts.

## 7. Transactions, lock order and fencing

All 2D transactions lock in this order:

```text
enrolled target/environment reservation
→ development task
→ implementation attempts in attempt-number order
→ reviews in attempt-number order
→ CI validation
→ release row
→ action/event sequence allocation
→ fresh PostgreSQL clock_timestamp() and predicate/fence check
```

This preserves existing task→attempt→review order. No path holding a later lock
may acquire an earlier lock. Existing task/attempt mutation APIs must serialize
on the task row; new release gates/triggers must reject later attempts or authority
changes that would silently supersede a dispatched release. Explicit irreversible
human invalidation remains permitted under the task lock and stops every subsequent
action admission. Its transaction only records invalidation; later release
reconciliation follows the canonical lock order. Do not reject revocation merely
because an external action is already admitted. Test direct malformed
DB transitions as well as repository APIs; unrestricted trusted DB forgery remains
outside the already accepted trust model.

Use short transactions for claim, heartbeat, intent and receipt. Do not hold a
database transaction across build, push, Docker or health polling. Use PostgreSQL
time **after** locks to reject expiry during contention. Lease generation is
monotonic and fenced for every write. Heartbeat uses 30-second renewals on a
90-second lease; fixed budgets do not reset on renewal or restart.

These locks are taken inside narrow trusted DB gate/transition routines, not by
granting broad UPDATE access on task/review evidence to the release principal.
PostgreSQL SELECT-only privileges cannot execute `SELECT ... FOR UPDATE`.
Use fixed-search-path, strictly typed owner routines with no dynamic SQL or
caller-supplied approval/evidence-success flags; grant only their required EXECUTE
capability. The trusted CI issuer alone may freeze validated CI evidence.

Acquire the host lock before the short dispatch-check transaction. No transaction
may wait for a host lock; discovery/claim transactions finish first. Recovery and
human hold resolution use this same order and may not bypass the reservation.

The environment reservation is **not** the lease: expiration transfers permission
to reconcile, never permission to start a competing external mutation. One
host-level exclusive lock surrounds dispatch/build/apply/verification, and the
DB reservation survives process death. Child processes must remain supervised;
losing the parent/lock is not evidence that a Docker daemon job has stopped.
Never release a reservation because a lease merely expired.

Admission of an immutable action intent is the authorization linearization
point. Invalidation before admission prevents dispatch. After admission, an
already dispatched or admitted operation may complete even if its DB connection
or lease is subsequently lost. Git/Docker cannot atomically consult PostgreSQL
at their external commit point. State this limit explicitly: DB fencing rejects
stale persistence and **new** dispatch; it cannot undo in-flight external work.
On loss, stop new substeps, attempt bounded local cancellation, retain the exact
intent/reservation and reconcile or escalate. Do not issue a replacement deploy.

Do not admit later releases or superseding attempts while an earlier action
remains potentially executable. Clearing such a hold requires proof of process/job
quiescence, external observations and a fenced durable resolution. A stalled host
may require human termination/revocation; that is accepted fail-closed behavior.
This is a concrete single-host Compose exclusion, not generalized resource fencing.

## 8. Git merge and push protocol

**Approved mode: remote fast-forward only.** Push is the sole externally
consequential merge action. No local `main` update is a prerequisite or separate
authority source, and no working tree is merged. Operate from a trusted private
Git store using explicit commit C and a single target ref.

1. Verify entry, complete lineage, object/tree, retained refs and exact remote B.
2. Reserve immutable `(repository, remote, refs/heads/main, B, C, releaseId)`
   intent. Disable hooks, replacement objects, incidental config, tag following,
   submodule recursion and credential-bearing URLs/output. Credentials come from
   the release component's narrowly scoped credential boundary.
3. Verify `B != C` and `B` is an ancestor of `C` from actual Git objects. Use no
   replace refs/grafts/shallow shortcuts. Verify full one-parent captured lineage.
4. Execute a **single-ref exact-old compare-and-swap** push. Approved CLI
   mechanism is explicit `--force-with-lease=refs/heads/main:B` with explicit
   `C:refs/heads/main`, guarded by the independent strict fast-forward predicate.
   No bare `--force`, `+refspec`, implicit tracking lease, mirror, deletion, tag
   push, overwrite or alternative SHA is permitted. This lease option can permit
   non-fast-forwards in general; this adapter must never permit one. Remote policy
   must also deny branch deletion/history rewrites. This exact-lease choice is
   explicitly approved; it does not authorize history-rewriting pushes.
5. Read the enrolled remote directly. Only exact remote C confirms the v1 merge
   postcondition; persist receipt under current release fence. Descendant-of-C
   is recorded as containment evidence but escalates branch drift, not deploy
   permission. Remote local tracking refs are never the verification oracle.

Why ordinary `git push` is insufficient for this chosen strict-base contract:
an intervening target advance to an ancestor of C can still permit a normal
fast-forward push. Explicit expected-old CAS rejects any different current tip.
The installed Git 2.34.1 `git-push(1)` manual confirms explicit lease compares the
actual target against the supplied expected SHA; an implicit lease is unsuitable.

Target drift before dispatch or CAS rejection → `needs_human`. No auto-rebase,
merge commit or regeneration. Human may approve a new task based on new target
and fresh review/CI, but 2D cannot do that itself. A target initially at C without
this release's durable push intent does not retroactively manufacture merge
authorization; escalate for provenance reconciliation.

Unknown push result: retain the same operation identity. Remote C plus valid
prior intent confirms desired external state (not which actor performed it).
Remote B is only an observation, not proof an old receive-pack cannot still
finish; v1 defaults to no automatic resend after timeout. Remote other/missing,
unreachable or ambiguous → needs_human. No unrelated subsequent release begins
until the old sender/server-side possibility is resolved. Read-only polls are
bounded. A conclusively rejected/no-dispatch failure can be safely classified
failed; v1 still escalates rather than introducing push retry orchestration.

## 9. Concrete bounded deployment protocol

**No concrete production deployment target is enrolled in the repository.**
Do not infer one from this checkout, Docker context, `origin`, local secrets or
the fact that Compose can start. Human enrollment must identify repository/remote,
host Docker context, Compose project, production data volume identity, runtime
configuration, trusted runner installation and readiness checks.

The narrow interface is one Compose adapter with typed operations conceptually
`buildExactRelease`, `applyExactRelease`, `inspectExactRelease`. Inputs are stored
release IDs/bindings resolved by deterministic code, not model-selected commands,
paths, endpoints or credentials. No generic deployment provider registry.

1. Re-read remote main = C, current release = stored predecessor, current policy,
   review/candidate authority and environment reservation. Confirm no pending job.
2. Export/check out **C** into a fresh release-owned read-only source tree. Verify
   tree/context digest and exclude host files, credentials, `.git` execution hooks
   and local Compose overrides. Never build the user's mutable checkout.
3. Build app and worker for the actual host architecture using reviewed
   root Dockerfile targets in an isolated build boundary. Repository build scripts
   are untrusted execution: no production/model/Git credentials, production mounts
   or host Docker socket inside them. The trusted host may control Docker outside
   the build boundary; build tooling cannot control the host daemon.
4. Persist exact local Docker image IDs and a digest of the canonical release
   manifest. A local content-addressed image ID is sufficient for this one-daemon
   v1; no registry or imaginary registry digest is required. Retain those images.
   Use trusted generated Compose input referencing exact IDs, with build and
   implicit pull disabled. If a Compose version cannot consume immutable local
   IDs as specified, resolve that during adapter validation before acceptance,
   not by trusting tags.
5. Validate the effective Compose configuration against host-owned policy before
   any credentialed operation. Preserve the enrolled three steady services,
   loopback exposure, expected named volumes, allowed secret mounts, no
   privileged mode/host networking/new mounts/Docker socket. Do not execute
   arbitrary candidate Compose extensions, commands or lifecycle hooks on host.
6. Verify the exact enrolled migration ledger read-only and persist the observed
   digest/result. V1 automatically releases only candidates that do not change
   schema/migration history or deployment/authority infrastructure. There is no
   per-release privileged migration job. Schema/grant bootstrap or a real migration
   is separate human-authorized maintenance using pinned trusted tooling built
   independently of C; its resulting expected ledger is enrolled explicitly.
   Protecting migrator Git paths alone is insufficient: candidate build scripts
   can overwrite files inside the shared workspace image. Never supply migration
   credentials to a C-built image on this automatic path.
7. Record apply intent; apply exact app/worker images under the same Compose
   project, without volume deletion or unrelated service replacement. Pin the
   infrastructure PostgreSQL image and preserve its data volume. Verify the
   previous release precondition immediately before apply. No rebuild at apply.
   The fixed effective Compose apply excludes migration/dependency reruns and
   applies only app/worker, without implicitly recreating the enrolled PostgreSQL
   service. Raw default `compose up` that reruns `migrate` is not this protocol.
8. Inspect resulting service/container IDs, image IDs, release labels, source C,
   unchanged ledger result and service state. Persist receipt and enter `verifying`.
9. Verify app and worker readiness, DB connectivity, required non-consequential
   runtime checks, migration ledger and identity of **those same containers**.
   A new revision endpoint, if added, is corroboration, not the sole source of
   identity. Existing generic 200/healthy status alone is insufficient.
10. Reinspect container/image/release identities after health checks and compare
    environment reservation/current release. Persist `deployed`, health receipt,
    deployed revision and environment pointer atomically, under a live fence.
    Release the reservation only after all supervised operations are finished.

No artifact publication, promotion or rollback action is part of v1. Missing
local images after restart is not permission to rebuild and silently replace
the recorded manifest; before apply, a clean bounded build can create a new
manifest only after old work conclusively stopped and within original limits.
After possible apply, image loss/inconsistent manifest requires human resolution.

## 10. Idempotency and bounded reconciliation

Use a canonical versioned hash over typed immutable fields, not mutable tags,
attempt counters alone, wall-clock time or random identity on every retry.

| Action | Stable identity | Retry rule / proof |
| --- | --- | --- |
| Exact CI request | repo + C + policy digest + check-matrix digest | One validation identity; at most one infrastructure retry after old validation known terminal; no retry of failed quality assertions |
| Remote merge/push | releaseId + repo/remote/ref + B + C | One dispatch in v1; lost ack reconciles remote; absence not safe resend proof |
| Local artifact build | releaseId + C + tree/context/recipe + platform | At most two builds total, only after previous stopped; one selected immutable manifest before apply |
| Migration ledger check | releaseId + environment + expected ledger digest | Read-only bounded observations; mismatch escalates; no migration mutation in automatic v1 |
| Compose apply | releaseId + environment + predecessorRelease + manifest digest | One dispatch; repeated coordinator call returns stored outcome or inspects; never reapply unknown |
| Health verification | releaseId + manifest + exact container IDs | Read-only bounded repeats while exact release remains current |
| Publish / promotion / rollback | None | Not implemented; no hidden optional execution path |

Schema/grant bootstrap has no implicit release-operation identity: it is separately
human-authorized maintenance, not a hidden automatic action. Image publication
also has no v1 dispatch; candidate-ref publication is separately covered in section 15.

Approved fixed ceilings: lease 90 seconds/heartbeat 30 seconds; each Git action
120 seconds; CI 30 minutes per execution, at most 2 executions; build 30 minutes
per execution, at most 2 executions; ledger check 30 seconds; apply 5 minutes; health
5 minutes with at most 30 observations, 10-second request timeouts; reconciliation
at most 3 observations per invocation and 3 automatic invocations total. Release
wall-clock ceiling 90 minutes from admission; pre-admission CI ceiling 60 minutes.
All elapsed time, attempts and observations persist; restart never resets them.
These are approved v1 limits, not claims about implemented runtime settings.

If a deadline expires during a possible write, classify unknown, stop new work
and escalate; a deadline is not proof of cancellation. A database outage cannot
be durably recorded while it persists: on reconnect, started intent remains
unresolved and must be reconciled. This contract claims at-most-one automatic
dispatch per consequential step, not exactly-once effects across Git/DB/Docker.

## 11. Crash/restart and failure/escalation matrix

Recovery invokes no Pi/model and requires no session/transcript. A new generation
may gather observations and persist a reconciled outcome; automatic continuation
to the next write after process restart is optional and **disabled by default**
in v1. Reconciled merge does not automatically mean restart-time deploy authority.

| Boundary / failure | Observation / durable result | Next action |
| --- | --- | --- |
| Before admission | No release/intent | Fresh full admission allowed |
| Admission complete, push not started | Immutable merge_pending with no dispatched intent | Verify no sender, revalidate; human inspection/re-authorization, no implicit write continuation |
| During push / response lost | Started/unknown intent; query remote | C confirms desired state; B alone inconclusive; other/missing/unreachable escalates |
| Push succeeded before DB receipt | Prior intent + remote C | Fenced reconciliation records merged; no duplicate push; human inspection/re-authorization before deployment write |
| DB says unmerged, remote advanced | If exact C with prior intent, reconcile; otherwise provenance/drift failure | No new merge or deploy from guessed history |
| DB says merged, remote lacks C or differs | Preserve historical receipt, record current mismatch | No deployment; needs_human; never force-repair remote |
| Build interrupted | No prod mutation authorized by build | Verify builder stopped; bounded rebuild only with full authority; otherwise escalate |
| Ledger check interrupted/mismatched | Only read-only observation interrupted; no migration was dispatched | Bounded fresh ledger check; mismatch/unprovable result needs_human |
| During apply request | Started intent, daemon may still work | Inspect exact job/containers; no second apply or next release |
| Deploy succeeded, acknowledgement lost | Manifest-bound app/worker containers + ledger proof + all prior jobs quiescent | Record observed apply and perform bounded health reads; otherwise needs_human |
| Health interrupted | No completion receipt | Recheck same containers/release and full readiness within budget; default no new writes |
| Health fails | Exact deployment may exist but is not accepted | needs_human; retain identity/evidence; no rollback/model fix |
| Health races with another release or manual mutation | Container/image/release identity changed | Fail closed; no stale success or automatic restoration |
| Lease lost / stale result returns | Old generation cannot persist | Retain possible action; reconciler observes, never substitutes a different release |
| Two workers claim | Unique reservation + row locks and host lock | One dispatch; loser no-op/skip, not new intent |
| Invalidated/superseded candidate | Relational gate fails | No new effects; if in flight, preserve unknown/observed result and hold reservation |
| Missing evidence, configuration or policy | No authoritative gate | needs_human/configuration unavailable; base ACT services stay healthy |

`needs_human` remains terminal for automatic execution. A separate fenced human
maintenance operation may record observations, prove all senders/jobs quiescent,
and clear/close the hold. It does not replay push/apply, return the release to an
active state, reset counters, replace C or grant new model work. Any further
external write requires explicit separate authorization and fresh admission under
its approved maintenance contract. Invalidated development authority requires a
new human-approved task before a new autonomous development release. No generic
resume/rollback engine is proposed. Read-only reconciliation of a nonterminal
release may persist proven facts, including completion, without a new external
write; this is distinct from resuming a terminal `needs_human` release.

## 12. Rollback policy

No automatic rollback in v1. Failed post-deploy health produces `needs_human`
with expected/observed release, immutable images, migration state and prior release
identity. Retain prior artifacts for human recovery. Neither restoring an old
image nor reverting Git guarantees a safe DB rollback, so the model cannot choose
either. Human recovery must identify environment, current release and intended
target explicitly; no generic “previous” tag or autonomous rollback endpoint.

## 13. Security and capability model

| Component | Minimal capability |
| --- | --- |
| Read-only Git inspection | Approved local objects and enrolled remote read; no credentials exposed to models |
| Independent CI | Read candidate source, isolated test/build resources and authenticated bounded evidence transport; no target push or production secrets |
| Merge dispatcher | One repo/remote/target write credential, strict B→C FF CAS; no deploy credential necessary |
| Build controller | Local isolated builder and image inspection; no runtime/personal/model secrets inside candidate execution |
| Compose deploy runner | Host-owned single project/Docker context, approved runtime secret references, read-only ledger inspection; no migration role; never inside app/worker |
| Implementer / Reviewer / ACT model | Existing role tools only; no CI receipt issuance, release writes, target push, Docker or deployment credentials |

Docker control is privileged; documenting one project scope does not make an
unrestricted daemon socket least-privilege. Keep it in the deterministic host
component. Prefer separate merge/deploy credentials and process environments;
never pass all runner credentials through candidate package scripts.

Production enrollment must also replace the local Compose shared database owner
with distinct runtime and control-plane roles. App/ACT worker get only required
ACT access, with no development-task creation, review/CI/release authority writes,
DDL, ownership, role switching or privileged helper-function escape. The release
role gets read access to immutable task/review evidence and narrow fenced release
transitions; human ingress alone creates approved tasks. The separately enrolled
maintenance migrator uses separate short-lived access and a pinned trusted
build/runtime chain outside candidate builds. Protect its program/history and
transitive runtime/import/package inputs; source-path protection alone cannot
make a C-built image safe for owner credentials. Ordinary releases never execute
that migrator. If C changes schema, migration history or this protected tooling,
autonomous v1 admission fails.
Apply grants through explicit reviewed deployment/bootstrap work and regression
test existing ACT behavior. A role name without denied grants is not a boundary.
These protections are approved requirements, not properties of current Compose.

Release principals may not issue successful CI receipts. The independent trusted
CI issuer owns validated receipt finalization; release gates only consume it.
Evidence locking and transitions use section 7's narrow routines; do not resolve
locking privileges with broad task/review UPDATE grants. Test denied direct
mutation, owner/role escalation, unsafe function parameters and search-path
abuse. The accepted exclusion of unrestricted trusted DB-owner forgery in
[the Phase 2B contract](phase-2-implementation-plan.md#phase-2b--independent-reviewer) remains intact. This adds concrete
enrollment grants within the same PostgreSQL deployment, not a new service or
a retrospective Phase 2B/2C acceptance requirement.

The installed release runner, policy, CI gate definition and effective deployment
recipe must be pinned outside the candidate checkout. An automatic task may not
modify the governing documents, gate/test thresholds, runner policy/entrypoints,
workflow trust, schema/migration history or deployment configuration. Validate cumulative
B..C changed paths against this protected inventory; a changed package script or
coverage include/exclude rule that weakens the gate must fail. The trusted CI gate
uses fixed commands and protected coverage configuration and verifies owned-source
inventory, not only a candidate-emitted JSON claiming 100%.

Reject candidate-controlled Compose mounts, env injection, build hooks, Git
config/hooks/replace refs, unsafe remote URLs/helpers and credential canaries.
Application runtime code necessarily executes with its approved runtime secrets;
review/CI and constrained task scope govern that intended boundary. This is not a
claim that arbitrary malicious production code is safe after deployment.

## 14. Acceptance-test matrix

Every row is a required future deterministic test, **not a pass claimed now**.
Use temporary local Git remotes, fake CI evidence, real PostgreSQL, disposable
Compose projects and fake canary secrets. Normal CI accesses no personal accounts,
model providers, public websites or production environments.

| ID | Required scenario / assertion |
| --- | --- |
| A01 | Only relational approved_candidate admission succeeds; every missing predicate fails without writes |
| A02 | Latest failed/active/succeeded later attempt rejects old approval; duplicate admission creates one release |
| A03 | Missing/moved candidate/retention ref, wrong review/attempt/task/base/context and equal-tree different-SHA candidates reject |
| A04 | Initial candidate and full three-fix lineage merge correctly from original task B; wrong parent/extra parent/unrelated history rejects |
| A05 | CI on wrong SHA, synthetic PR merge commit, stale policy, missing/skipped required gate, forged artifact/receipt or weakened coverage rejects |
| A06 | Exact CI includes lint/typecheck/unit/integration/E2E/build/migration/portability/scope checks and exactly 100/100/100/100 coverage |
| A07 | Target advances before push and between observation and receive-pack; CAS rejects even if new target is an ancestor of C |
| A08 | Two candidate push races produce at most one accepted B→C; no force rewrite, deletion, tag or second ref mutation |
| A09 | Push succeeds then acknowledgement/DB receipt lost; exact C reconciliation works; observed B never permits blind retry |
| A10 | DB unmerged/remote other and DB merged/remote missing-C cases escalate without fabricated success or repair |
| A11 | PostgreSQL lock wait past expiry, stale generation, duplicate receipt, late result and competing recovery all fail safely |
| A12 | Paused worker before/after dispatch, parent death with child/daemon still active, DB outage: no replacement external action or premature reservation release |
| A13 | Two workers/environment releases cannot overlap apply/health; needs_human with unknown effect holds exclusion |
| A14 | Mutable tag, false revision label, dirty build context, wrong app/worker image/platform/config/manifest, missing image and fake provenance reject; C-built artifacts never receive maintenance credentials |
| A15 | Repeated same apply request and acknowledgement loss reconcile without duplicate mutation; interrupted ledger reads grant no migration execution |
| A16 | Wrong/partial migration ledger, unexpected volume/database and candidate schema/migration/config changes reject; production apply excludes migrator/dependency rerun |
| A17 | Health failure, healthy wrong image, healthy wrong worker, container replacement mid-check, newer release race and lost health receipt never produce false deployed |
| A18 | Crash injection before/after each persisted intent, dispatch, receipt and finalization; reconstruct solely from DB/Git/host observations |
| A19 | All ceilings remain monotonic across retries/restarts; exhaustion escalates without another model call |
| A20 | Direct malformed release/CI/event DB transitions reject; successful state requires full durable receipts; events/identity cannot be rewritten |
| A21 | Canary credentials absent from build/test/model context, logs, events, manifests and candidate artifacts; sandbox has no production mounts/socket |
| A22 | Models cannot call merge/deploy/rollback/task-create; spoofed model complete/APPROVE cannot authorize release |
| A23 | Protected policy/CI/coverage/migration/deploy files and new Phase 3 behavior cannot pass autonomous gate; failures never create tasks or change specs |
| A24 | ACT and Phase 2A/B/C regressions, fresh-session reconstruction and exact coverage remain intact |
| A25 | One bounded end-to-end local fixture: approved candidate → durable exact CI → CAS merge → exact app/worker image build → read-only ledger check → Compose apply → ledger/health/revision proof |
| A26 | Actual production-equivalent role grants deny task creation and authority mutation from app/worker/release runtime; ownership, SET ROLE, DDL and privileged functions cannot bypass grants; ACT regression remains green |
| A27 | CI validation claim races, stale fences, publication/dispatch acknowledgement loss, duplicate requests, fixed retries and journal/receipt immutability work before any release exists |
| A28 | Candidate build modifies a migrator/loader inside its image: no privileged migration execution is available; separately pinned maintenance tooling remains outside candidate builds |
| A29 | Human invalidation remains possible after admission and stops later substeps; terminal hold-clear cannot resume, replay writes, replace candidate or reset budgets |

Before **each authorized implementation milestone**, run applicable lint,
typecheck, full tests, exact coverage, build, clean and existing-schema migration
checks, PostgreSQL races, Docker config/build/startup/health/restart, sandbox
security, amd64/arm64 validation and Git/secret/scope integrity checks. Report
commands, actual counts, skips, platforms and limitations. A mock deployment
alone cannot accept the concrete Compose adapter. No threshold exclusions/ignores.

## 15. CI evidence and acceptance authority

Current attempt evidence and current GitHub workflow are insufficient for a
pre-merge exact-candidate gate. Main-push CI occurs after the protected action;
pull-request checkout must not accidentally test a synthetic merge SHA.

The approved extension is the existing GitHub Actions quality path with
explicit checkout of immutable C, independent trusted workflow/check policy,
and an authenticated evidence importer. Candidate availability may require one
dedicated immutable candidate ref publication before CI; that is a **separate
bounded action**, not target merge. The GitHub Actions publication/trigger/import path is approved
for implementation; live activation remains blocked by section 17. Never invent CI PASS from local model tests.

One pre-admission `ci_validations` row owns CI preparation and observation. Its
immutable binding is task/attempt/review IDs, repository, B/C/ref, validationId,
authority/policy digest and required-check digest. A unique binding prevents
duplicate requests or a new row from evading an unresolved action. No release
row or production environment reservation is needed for this bounded CI work.

```text
CI-eligible approved candidate
→ validation: pending → running → succeeded (receipt frozen)
                            └──→ needs_human
```

A failed required CI quality assertion enters terminal `needs_human` with explicit
failure class `quality_gate_failed`; its journal records the failed check. There
is no separate `failed` validation lifecycle state and no automatic quality retry.

The deterministic CI coordinator claims/renews the validation row with owner,
generation and PostgreSQL expiry. Lock task → attempts → reviews → validation,
then read fresh DB time; this is a subset of section 7's order. Recheck current
authority before each new publication/trigger. Store fixed deadlines/counters
and a bounded typed append-only action journal on the validation row, enforced
by trusted persistence: action key, kind, `started` intent before dispatch and
normalized outcome/receipt afterward. Journal omission means `not_started`;
`started` without a conclusive result is reconciliation-required. Publication,
workflow trigger and observation are fixed substeps, not a generic workflow engine.

Only the trusted independent CI evidence issuer can transition to `succeeded`
after validating the exact external run/checkout/policy/gates. Its receipt and
journal then freeze. Claim/recovery writes are fenced; a lost lease permits
bounded read-only reconciliation, never an unproven repeated publication/trigger.
Unknown effects retain the same validation identity; automatic `needs_human` is
terminal. At most one infrastructure rerun is permitted after the old run is
conclusively terminal, with the same C/policy and monotonic counters; failed
quality checks cannot be relabeled infrastructure failures. A changed task,
candidate or authority cannot inherit this validation. Release admission still
revalidates every section 4 predicate against the frozen successful receipt.

Each CI validation binds repository ID, C, actual checkout/tree, workflow policy
revision, required-check matrix, run identity and attempt, structured gate results,
four numeric coverage totals/percentages, scope/migration/portability applicability
and receipt provenance. Required gate absent/skipped/cancelled is not PASS.
Applicability decisions are fixed before CI by deterministic policy, not by the
candidate. No full logs or secrets are persisted. Trusted transport, schema,
candidate identity and protected workflow definition must all validate before
an immutable successful record can be written.

The approved candidate-ref publication path uses create-only exact ref CAS,
`refs/heads/personal-agent-ci/<validation-id>` → C, with no update or
delete permission. Stable identity = repo + validationId + ref + C; persist intent
before publication. Existing same ref at C verifies desired state, different SHA
fails closed, and timeout with ref absent remains unknown until reconciliation.
This permission is distinct from main push. Avoid PR creation or remote account
mutation merely to get a check when a narrow trusted trigger is available.

For the approved trusted workflow trigger, treat dispatch itself as consequential:
persist validationId/C/policy intent, include that correlation identity, and
reconcile exact matching runs before any retry. An absent immediate run listing
does not prove dispatch failure. No new trigger on uncertain acknowledgement;
bound observations then escalate. Only one selected immutable successful receipt
for the exact validation identity may authorize admission. Infrastructure rerun
requires the preceding run to be conclusively terminal and consumes the fixed
CI retry allowance; candidate test failure is not an infrastructure retry.

## 16. Phase 3 boundary

2D accepts only an existing human-approved task and an immutable candidate already
reviewed under its original contract. It has no task ingress, specification
writer, acceptance editor, model planner, fix-loop call, policy updater or
rollback capability. Its DB role/API cannot insert development tasks/attempts
or rewrite review history. A release failure writes release evidence and
`needs_human` only. Automatic scope gate excludes policy/gate/runner updates and
Phase 3 additions; installing a newer trusted runner is separate human-authorized
maintenance. A candidate cannot gain authority by changing its own contract.

This claim depends on the enrolled runtime grant boundary in section 13, not just
on model tool lists. Current shared-owner Compose configuration does not prove
it. The contract prevents authoritative Phase 3 transitions through the available
roles and interfaces; it does not claim a semantic proof about every possible
behavior of arbitrary generated application code. Unapproved Phase 3 code is also
rejected through specification/scope review and the protected gate.

## 17. Approved choices and live-activation boundary

H1 (bounded v1 release contract) and H2 (GitHub Actions publication, trusted
trigger and authenticated exact-result import) are **APPROVED**. The strict
original-B fast-forward-only CAS, app/worker-only releases, read-only migration
ledger checks, no automatic rollback and fail-closed recovery are binding.
These release scope restrictions do not prohibit separately scoped human-directed
work implementing Phase 2D itself.

Live Git/CI/merge/deploy activation remains **NOT AUTHORIZED** until separately
confirmed and mechanically verified:

1. **H3: repository and branch.** Confirm the exact repository and sole target
   branch, expected to be discovered `github.com/davidleungch/personal-agent.git`
   and `refs/heads/main`. Local origin configuration is discovery, not enrollment.
   Verify remote state, allowed writers, safe FF/CAS compatibility, rejection of
   history rewrites/deletion, and credential scope.
2. **H4: one Linux Compose target.** Enroll one actual host/Docker context and
   daemon, exact Compose project identity, exact persistent data-volume identity
   and ownership, pinned PostgreSQL identity, and attested initial release/ledger.
3. **Target capabilities and credentials.** Verify trusted runner installation,
   effective Compose policy, runtime secret references, distinct production DB
   grants, independent CI issuer, merge/deploy capability separation, pinned
   maintenance tooling, readiness and maintenance ownership for that concrete
   target. Do not commit credentials or invent placeholder production credentials.

No host is selected by this approval. Actual credentials, volume identities and
server rules may remain unavailable during fixture implementation. Missing target
configuration does not degrade base app/worker/PostgreSQL health. The explicitly
authorized documentation branch push is not activation of the release pipeline.

Derived requirements need no additional human policy decision: separate durable
validation/release records, ordered locks, narrow trusted DB gates, monotonic
leases/generations and explicit bounded counters, persistent reservation and host
lock, immutable receipts/artifact provenance, human invalidation, terminal hold
resolution and protected source/import/CI/runner inventory. Their implementation
must satisfy sections 4–16 and the A01–A29 tests. A real architecture contradiction
still requires explicit human direction.

The operator must honor maintenance holds. Uncoordinated privileged intervention
is detected and escalated, not claimed to be fenced by PostgreSQL. Shared-owner
credentials cannot establish the required least-privilege boundary.

Deferred unless separately human-authorized: generic deployment orchestration or
plugins, multi-environment release management, unnecessary artifact-registry
abstraction/publication, automatic rollback/down-migration, arbitrary crash
continuation, multi-host takeover, generalized external-resource fencing,
Temporal-style orchestration, exactly-once external API claims, automatic
candidate regeneration/re-review after drift, unrestricted trusted-owner
attestation and all Phase 3 self-improvement. No new continuously running service.

## 18. Implementation planning and stop boundaries

The contract promotion closes H1/H2. After its commit, a separately scoped fresh
session may plan and implement against this approved contract. Scope each milestone
explicitly, validate it, and stop for review before advancing:

1. **Durable admission and exact CI evidence:** validation/release/reservation/
   audit state, relational gates, protected policy, independent CI issuance,
   narrow DB gates and deterministic fixtures. Live publication/triggering stays
   disabled pending H3 and capability preflight. No target merge/deploy.
2. **Exact remote FF merge:** single-ref CAS adapter, race/ambiguity/fencing tests
   and durable receipts with temporary remotes. Live activation requires H3;
   deployment stays disabled.
3. **Exact artifacts and bounded Compose:** C-bound app/worker images/manifest,
   unchanged ledger verification, restricted roles, apply/health identity and
   failure holds. Use disposable Compose and both architectures. No migration
   or dependency rerun, rollback or model repair. Live deployment requires H4
   and all production grant/maintenance/bootstrap checks.
4. **Phase 2D acceptance:** A01–A29 and applicable regression, security,
   portability and restart gates. Stop for separately authorized integrated
   Phase 2 acceptance. Completing Phase 2D never authorizes Phase 3.

This documentation promotion runs reference/SHA/link checks, `git diff --check`,
lint and any required lightweight authority-document checks. It claims no new
Phase 2C acceptance, Phase 2D implementation evidence or live release success.
