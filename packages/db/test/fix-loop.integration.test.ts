import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DevelopmentTransitionError,
  createDatabase,
  createDevelopmentRepositories,
  createFixLoopRepositories,
  createReviewRepositories,
  migrateDatabase,
  type Database
} from "../src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

let database: Database;
let pool: Pool;
let closeDatabase: () => Promise<void>;
let sequence = 0;

const budget = {
  maxCommandMs: 10_000,
  maxCommandOutputBytes: 10_000,
  maxContextBytes: 100_000,
  maxCostUsdMicros: 1_000_000,
  maxDiffBytes: 100_000,
  maxModelInvocations: 3,
  maxTokens: 10_000,
  maxToolCalls: 20,
  maxWallClockMs: 60_000,
  maxWorkspaceBytes: 1_000_000
};
const criteria = [{
  check: { arguments: ["-e", "process.exit(0)"], executable: "node" as const, timeoutMs: 1_000 },
  description: "Fixture passes",
  id: "fixture"
}];
const contextPolicy = {
  allowedPaths: ["src"],
  forbiddenPaths: [".git"],
  relevantPaths: ["src/value.txt"]
};
const reviewPolicy = {
  forbiddenPaths: [".git"],
  readablePaths: ["AGENTS.md", "docs", "src"],
  relevantPaths: ["src/value.txt"]
};
const manifest = {
  authorityReferences: ["docs/design.md#reviewer"],
  entries: [
    { blobId: "a".repeat(40), bytes: 1, path: "docs/design.md", source: "authority" as const },
    { blobId: "b".repeat(40), bytes: 1, path: "src/value.txt", source: "repository" as const }
  ],
  totalBytes: 2
};

beforeAll(async () => {
  const reset = new Pool({ connectionString: databaseUrl });
  await reset.query("drop schema public cascade");
  await reset.query("drop schema if exists drizzle cascade");
  await reset.query("create schema public");
  await reset.end();
  await migrateDatabase(databaseUrl, new URL("../migrations", import.meta.url).pathname);
  const connection = createDatabase(databaseUrl);
  database = connection.database;
  pool = connection.pool;
  closeDatabase = connection.close;
});

afterAll(async () => closeDatabase());

function commit(marker: string): string {
  sequence += 1;
  return `${marker}${sequence.toString(16).padStart(39, marker)}`.slice(-40);
}

function finding(input: { severity?: "high" | "low"; text?: string } = {}) {
  return {
    acceptanceCriterionId: "fixture",
    architectureReference: "docs/design.md#reviewer",
    category: "correctness" as const,
    finding: input.text ?? "The candidate is incomplete.",
    relevantPath: "src/value.txt",
    requiredCorrection: "Complete the approved behavior.",
    severity: input.severity ?? "high" as const
  };
}

async function initialCandidate() {
  const development = createDevelopmentRepositories(database);
  const baseCommit = commit("1");
  const task = await development.createApprovedDevelopmentTask({
    acceptanceCriteria: criteria,
    approvedAt: new Date(),
    approvedSpec: "Implement the exact fixture without changing authority.",
    baseCommit,
    title: `Phase 2C fixture ${sequence}`
  });
  const claim = (await development.claimReadyDevelopmentTask({
    budget,
    leaseDurationMs: 60_000,
    modelProfile: "balanced",
    now: new Date(),
    runnerId: `initial-${task.id}`
  }))!;
  const fence = {
    attemptId: claim.attempt.id,
    leaseGeneration: claim.attempt.leaseGeneration,
    runnerId: `initial-${task.id}`
  };
  await development.saveDevelopmentContext({
    ...fence,
    contextDigest: "c".repeat(64),
    contextManifest: { entries: [], totalBytes: 0 },
    now: new Date()
  });
  await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "implementing", now: new Date(), taskStatus: "implementing" });
  await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "testing", now: new Date(), taskStatus: "testing" });
  await development.appendDevelopmentAttemptEvent({
    ...fence,
    kind: "test",
    now: new Date(),
    safeMetadata: { criterion_id: "fixture", duration_ms: 1, exit_code: 0 },
    status: "success"
  });
  await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "capturing_candidate", now: new Date(), taskStatus: "testing" });
  const candidateCommit = commit("2");
  const captured = await development.recordDevelopmentCandidate({
    ...fence,
    candidateCommit,
    candidateRef: `refs/personal-agent/development-attempts/${claim.attempt.id}`,
    now: new Date(),
    safeSummary: "candidate"
  });
  await development.appendDevelopmentAttemptEvent({ ...fence, kind: "teardown", now: new Date(), status: "success" });
  return { ...captured, baseCommit, candidateCommit, development, task: captured.task };
}

async function reviewCandidate(
  taskId: string,
  decision: "APPROVE" | "REQUEST_CHANGES",
  findings = decision === "APPROVE" ? [] : [finding()]
) {
  const reviews = createReviewRepositories(database);
  const runnerId = `review-${randomUUID()}`;
  const claim = (await reviews.claimCandidateReadyReview({
    budget,
    contextPolicy: reviewPolicy,
    leaseDurationMs: 60_000,
    modelProfile: "reasoning",
    runnerId,
    taskId
  }))!;
  const fence = { leaseGeneration: claim.review.leaseGeneration, reviewId: claim.review.id, runnerId };
  await reviews.saveReviewContext({ ...fence, contextDigest: commit("d").padEnd(64, "d"), contextManifest: manifest, now: new Date() });
  await reviews.startReviewExecution({ ...fence, now: new Date() });
  await reviews.persistReviewProposal({ ...fence, now: new Date(), result: { decision, findings } as never });
  await reviews.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" });
  return reviews.finalizeReview({ ...fence, contextDigest: (await reviews.getReview(claim.review.id))!.contextDigest!, now: new Date() });
}

async function captureFix(taskId: string, runnerId: string) {
  const development = createDevelopmentRepositories(database);
  const claim = (await development.claimFixRequiredDevelopmentTask({
    budget,
    contextPolicy,
    leaseDurationMs: 60_000,
    modelProfile: "balanced",
    runnerId,
    taskId
  }))!;
  const fence = { attemptId: claim.attempt.id, leaseGeneration: 1, runnerId };
  await development.saveDevelopmentContext({ ...fence, contextDigest: commit("e").padEnd(64, "e"), contextManifest: { entries: [], totalBytes: 0 }, now: new Date() });
  await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "implementing", now: new Date(), taskStatus: "implementing" });
  await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "testing", now: new Date(), taskStatus: "testing" });
  await development.appendDevelopmentAttemptEvent({ ...fence, kind: "test", now: new Date(), safeMetadata: { criterion_id: "fixture", duration_ms: 1, exit_code: 0 }, status: "success" });
  await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "capturing_candidate", now: new Date(), taskStatus: "testing" });
  const candidateCommit = commit(String(claim.attempt.fixIteration! + 2));
  const result = await development.recordDevelopmentCandidate({
    ...fence,
    candidateCommit,
    candidateRef: `refs/personal-agent/development-attempts/${claim.attempt.id}`,
    now: new Date(),
    safeSummary: "fix candidate"
  });
  await development.appendDevelopmentAttemptEvent({ ...fence, kind: "teardown", now: new Date(), status: "success" });
  return { ...result, sourceReview: claim.sourceReview };
}

describe("Phase 2C durable fix-loop authority", () => {
  it("rejects direct authority fabrication from every non-candidate source", async () => {
    const development = createDevelopmentRepositories(database);
    const task = await development.createApprovedDevelopmentTask({
      acceptanceCriteria: criteria,
      approvedAt: new Date(),
      approvedSpec: "No execution has started.",
      baseCommit: commit("a"),
      title: "Authority guard fixture"
    });
    for (const status of ["approved_candidate", "fix_required"]) {
      await expect(pool.query("update development_tasks set status = $1 where id = $2", [status, task.id])).rejects.toBeDefined();
    }
    const executed = await initialCandidate();
    await expect(pool.query("update development_tasks set status = 'ready' where id = $1", [executed.task.id])).rejects.toBeDefined();
    await expect(pool.query("update development_tasks set status = 'approved_candidate' where id = $1", [executed.task.id])).rejects.toBeDefined();
    await expect(pool.query(
      `insert into development_tasks (id, title, approved_spec, acceptance_criteria, status, base_commit, approved_at)
       values ($1, 'invalid', 'invalid', $2::jsonb, 'approved_candidate', $3, clock_timestamp())`,
      [randomUUID(), JSON.stringify(criteria), commit("b")]
    )).rejects.toBeDefined();
    const reviews = createReviewRepositories(database);
    await expect(reviews.appendReviewEvent({
      kind: "tool",
      leaseGeneration: 1,
      now: new Date(),
      reviewId: randomUUID(),
      runnerId: "missing-review",
      status: "failed"
    })).rejects.toBeDefined();
    await development.createApprovedDevelopmentTask({
      acceptanceCriteria: criteria,
      approvedAt: new Date(),
      approvedSpec: "Initial attempt cannot require a fix-loop escalation.",
      baseCommit: commit("c"),
      title: "Initial attempt fixture"
    });
    const plainClaim = (await development.claimReadyDevelopmentTask({
      budget,
      leaseDurationMs: 60_000,
      modelProfile: "fast",
      now: new Date(),
      runnerId: "plain-attempt"
    }))!;
    await expect(development.markDevelopmentNeedsHuman({
      attemptId: plainClaim.attempt.id,
      failureClass: "test",
      leaseGeneration: 1,
      reason: "context_unavailable",
      runnerId: "plain-attempt"
    })).rejects.toBeDefined();
    await expect(development.markDevelopmentNeedsHuman({
      attemptId: plainClaim.attempt.id,
      failureClass: "test",
      leaseGeneration: 1,
      reason: "context_unavailable",
      runnerId: "wrong-owner"
    })).rejects.toBeDefined();
  });

  it("keeps Reviewer finalization pure and preserves reconciled review evidence", async () => {
    const fixture = await initialCandidate();
    const review = await reviewCandidate(fixture.task.id, "APPROVE");
    expect((await fixture.development.getDevelopmentTask(fixture.task.id))?.status).toBe("candidate_ready");
    const reviews = createReviewRepositories(database);
    await expect(
      reviews.getCurrentAuthoritativeReview(fixture.task.id, fixture.candidateCommit)
    ).resolves.toMatchObject({ id: review.id });

    const fix = createFixLoopRepositories(database);
    const reconciled = await fix.reconcileCurrentReview({ reviewId: review.id });
    expect(reconciled.task.status).toBe("approved_candidate");
    await expect(
      reviews.getCurrentAuthoritativeReview(fixture.task.id, fixture.candidateCommit)
    ).resolves.toBeUndefined();
    await expect(fix.getReconciledReview(fixture.task.id)).resolves.toMatchObject({
      review: { id: review.id },
      task: { status: "approved_candidate" }
    });
  });

  it("keeps current, reconciled, and consumed review lookups semantically separate", async () => {
    const fixture = await initialCandidate();
    const fix = createFixLoopRepositories(database);
    await expect(fix.getConsumedSourceReview(randomUUID())).resolves.toBeUndefined();
    await expect(fix.getReconciledReview(randomUUID())).resolves.toBeUndefined();
    await expect(fix.getReconciledReview(fixture.task.id)).resolves.toBeUndefined();
    const noAttempt = await fixture.development.createApprovedDevelopmentTask({
      acceptanceCriteria: criteria,
      approvedAt: new Date(),
      approvedSpec: "No execution context exists.",
      baseCommit: commit("9"),
      title: "No attempt"
    });
    await pool.query(
      "update development_tasks set status = 'needs_human', needs_human_reason = 'context_unavailable' where id = $1",
      [noAttempt.id]
    );
    await expect(fix.getReconciledReview(noAttempt.id)).resolves.toBeUndefined();
    await expect(fix.reconcileCurrentReview({ reviewId: randomUUID() })).rejects.toBeInstanceOf(
      DevelopmentTransitionError
    );
  });

  it("consumes one rejection exactly once and keeps it as immutable source provenance", async () => {
    const fixture = await initialCandidate();
    const review = await reviewCandidate(fixture.task.id, "REQUEST_CHANGES");
    const fix = createFixLoopRepositories(database);
    await expect(fix.reconcileCurrentReview({ reviewId: review.id })).resolves.toMatchObject({
      task: { status: "fix_required" }
    });
    const development = createDevelopmentRepositories(database);
    const claims = await Promise.all([
      development.claimFixRequiredDevelopmentTask({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "balanced", runnerId: "fix-a" }),
      development.claimFixRequiredDevelopmentTask({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "balanced", runnerId: "fix-b", taskId: fixture.task.id })
    ]);
    const claim = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claim.attempt).toMatchObject({
      attemptNumber: 2,
      baseCommit: fixture.candidateCommit,
      fixIteration: 1,
      parentCandidateCommit: fixture.candidateCommit,
      sourceReviewId: review.id
    });
    await expect(fix.getConsumedSourceReview(review.id)).resolves.toMatchObject({
      attempt: { id: claim.attempt.id },
      review: { id: review.id }
    });
    await expect(pool.query(
      "update development_reviews set findings = '[]'::jsonb where id = $1",
      [review.id]
    )).rejects.toBeDefined();
    const claimFence = {
      attemptId: claim.attempt.id,
      leaseGeneration: 1,
      runnerId: claim.attempt.leaseOwner!
    };
    await development.transitionDevelopmentAttempt({
      ...claimFence,
      attemptStatus: "implementing",
      now: new Date(),
      taskStatus: "implementing"
    });
    await development.transitionDevelopmentAttempt({
      ...claimFence,
      attemptStatus: "testing",
      now: new Date(),
      taskStatus: "testing"
    });
    await development.transitionDevelopmentAttempt({
      ...claimFence,
      attemptStatus: "capturing_candidate",
      now: new Date(),
      taskStatus: "testing"
    });
    await pool.query(
      "update development_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [claim.attempt.id]
    );
    const reclaimed = (await development.reclaimExpiredDevelopmentAttempt({
      leaseDurationMs: 60_000,
      now: new Date(),
      runnerId: "fix-reconciler"
    }))!;
    await expect(development.reconcileDevelopmentCandidate({
      attemptId: claim.attempt.id,
      candidateCommit: commit("f"),
      candidateRef: `refs/personal-agent/development-attempts/${claim.attempt.id}`,
      leaseGeneration: reclaimed.leaseGeneration,
      now: new Date(),
      runnerId: "fix-reconciler",
      safeSummary: "reconciled fix candidate"
    })).resolves.toMatchObject({
      attempt: { fixIteration: 1, status: "succeeded" },
      task: { status: "candidate_ready" }
    });
    await expect(pool.query(
      `insert into development_attempts (
        id, task_id, attempt_number, role, status, harness_adapter, model_profile,
        base_commit, parent_candidate_commit, source_review_id, fix_iteration,
        sandbox_id, context_policy, budget, usage, lease_owner, lease_expires_at,
        started_at
      ) select $1, task_id, 2, 'implementer', 'preparing', 'pi', 'fast',
        base_commit, parent_candidate_commit, source_review_id, 1, 'duplicate',
        context_policy, budget, usage, 'duplicate', clock_timestamp() + interval '1 minute',
        clock_timestamp() from development_attempts where id = $2`,
      [randomUUID(), claim.attempt.id]
    )).rejects.toBeDefined();
  });

  it("bounds three candidate-specific semantic rounds and never revives an old review", async () => {
    const fixture = await initialCandidate();
    let review = await reviewCandidate(fixture.task.id, "REQUEST_CHANGES", [finding({ text: "round zero" })]);
    const fix = createFixLoopRepositories(database);
    for (let iteration = 1; iteration <= 3; iteration += 1) {
      await fix.reconcileCurrentReview({ reviewId: review.id });
      const candidate = await captureFix(fixture.task.id, `fix-round-${iteration}`);
      expect(candidate.attempt.fixIteration).toBe(iteration);
      const oldCurrent = await createReviewRepositories(database).getCurrentAuthoritativeReview(
        fixture.task.id,
        review.candidateCommit
      );
      expect(oldCurrent).toBeUndefined();
      review = await reviewCandidate(
        fixture.task.id,
        "REQUEST_CHANGES",
        [finding({ text: `round ${iteration}` })]
      );
    }
    await expect(fix.reconcileCurrentReview({ reviewId: review.id })).resolves.toMatchObject({
      task: { needsHumanReason: "fix_iteration_exhausted", status: "needs_human" }
    });
    await expect(createDevelopmentRepositories(database).claimFixRequiredDevelopmentTask({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "balanced",
      runnerId: "forbidden-fourth",
      taskId: fixture.task.id
    })).resolves.toBeUndefined();
  });

  it("detects repeated, increasing, reappearing, and equivalent candidates conservatively", async () => {
    const repeated = await initialCandidate();
    let review = await reviewCandidate(repeated.task.id, "REQUEST_CHANGES", [finding({ text: "same" })]);
    let fix = createFixLoopRepositories(database);
    await fix.reconcileCurrentReview({ reviewId: review.id });
    await captureFix(repeated.task.id, "repeat-fix");
    review = await reviewCandidate(repeated.task.id, "REQUEST_CHANGES", [finding({ text: "same" })]);
    await expect(fix.reconcileCurrentReview({ reviewId: review.id })).resolves.toMatchObject({
      task: { needsHumanReason: "non_convergence", status: "needs_human" }
    });

    const increasing = await initialCandidate();
    review = await reviewCandidate(increasing.task.id, "REQUEST_CHANGES", [finding({ text: "one" })]);
    fix = createFixLoopRepositories(database);
    await fix.reconcileCurrentReview({ reviewId: review.id });
    await captureFix(increasing.task.id, "increase-fix");
    review = await reviewCandidate(increasing.task.id, "REQUEST_CHANGES", [
      finding({ text: "two-a" }),
      finding({ text: "two-a" }),
      finding({ text: "two-b" })
    ]);
    await expect(fix.reconcileCurrentReview({ reviewId: review.id })).resolves.toMatchObject({
      task: { needsHumanReason: "non_convergence" }
    });

    const reappearing = await initialCandidate();
    review = await reviewCandidate(reappearing.task.id, "REQUEST_CHANGES", [finding({ text: "returns" })]);
    fix = createFixLoopRepositories(database);
    await fix.reconcileCurrentReview({ reviewId: review.id });
    await captureFix(reappearing.task.id, "reappear-fix-1");
    review = await reviewCandidate(reappearing.task.id, "REQUEST_CHANGES", [finding({ text: "different" })]);
    await fix.reconcileCurrentReview({ reviewId: review.id });
    await captureFix(reappearing.task.id, "reappear-fix-2");
    review = await reviewCandidate(reappearing.task.id, "REQUEST_CHANGES", [finding({ text: "returns" })]);
    await expect(fix.reconcileCurrentReview({ reviewId: review.id })).resolves.toMatchObject({
      task: { needsHumanReason: "non_convergence" }
    });

    const equivalent = await initialCandidate();
    review = await reviewCandidate(equivalent.task.id, "REQUEST_CHANGES", [finding({ text: "equivalent" })]);
    await expect(createFixLoopRepositories(database).reconcileCurrentReview({
      equivalentCandidate: true,
      reviewId: review.id
    })).resolves.toMatchObject({ task: { needsHumanReason: "non_convergence" } });
  });

  it("escalates minor-only, repeated findings, invalidation, tests, and bounded infrastructure", async () => {
    const minor = await initialCandidate();
    const minorReview = await reviewCandidate(minor.task.id, "REQUEST_CHANGES", [finding({ severity: "low" })]);
    await expect(createFixLoopRepositories(database).reconcileCurrentReview({ reviewId: minorReview.id })).resolves.toMatchObject({
      task: { needsHumanReason: "minor_only_rejection", status: "needs_human" }
    });

    const invalid = await initialCandidate();
    const invalidReview = await reviewCandidate(invalid.task.id, "REQUEST_CHANGES");
    await invalid.development.blockDevelopmentCandidateIntegrity({ attemptId: invalid.attempt.id, now: new Date() });
    await expect(createFixLoopRepositories(database).reconcileCurrentReview({ reviewId: invalidReview.id })).rejects.toBeInstanceOf(DevelopmentTransitionError);

    const invalidClaim = await initialCandidate();
    const invalidClaimReview = await reviewCandidate(
      invalidClaim.task.id,
      "REQUEST_CHANGES",
      [finding({ text: "invalid claim" })]
    );
    await createFixLoopRepositories(database).reconcileCurrentReview({
      reviewId: invalidClaimReview.id
    });
    await pool.query(
      "update development_tasks set authority_invalidated_at = clock_timestamp() where id = $1",
      [invalidClaim.task.id]
    );
    await expect(createDevelopmentRepositories(database).claimFixRequiredDevelopmentTask({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "balanced",
      runnerId: "invalidated-fix",
      taskId: invalidClaim.task.id
    })).rejects.toBeInstanceOf(DevelopmentTransitionError);

    const invalidProvenance = await initialCandidate();
    const invalidProvenanceReview = await reviewCandidate(
      invalidProvenance.task.id,
      "REQUEST_CHANGES",
      [finding({ text: "invalid provenance" })]
    );
    await createFixLoopRepositories(database).reconcileCurrentReview({
      reviewId: invalidProvenanceReview.id
    });
    await pool.query(
      "update development_attempts set failure_class = 'candidate_integrity' where id = $1",
      [invalidProvenance.attempt.id]
    );
    await expect(createDevelopmentRepositories(database).claimFixRequiredDevelopmentTask({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "balanced",
      runnerId: "invalid-provenance-fix",
      taskId: invalidProvenance.task.id
    })).rejects.toBeInstanceOf(DevelopmentTransitionError);

    await expect(invalidProvenance.development.markDevelopmentNeedsHuman({
      attemptId: invalidProvenance.attempt.id,
      failureClass: "invalid",
      leaseGeneration: 1,
      reason: "context_unavailable",
      runnerId: `initial-${invalidProvenance.task.id}`
    })).rejects.toBeDefined();

    const deterministic = await initialCandidate();
    const deterministicReview = await reviewCandidate(deterministic.task.id, "REQUEST_CHANGES", [finding({ text: "deterministic" })]);
    const fix = createFixLoopRepositories(database);
    await fix.reconcileCurrentReview({ reviewId: deterministicReview.id });
    const development = createDevelopmentRepositories(database);
    const attempt = (await development.claimFixRequiredDevelopmentTask({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "balanced", runnerId: "semantic-failure", taskId: deterministic.task.id }))!.attempt;
    await expect(development.markDevelopmentNeedsHuman({ attemptId: attempt.id, failureClass: "test", leaseGeneration: 1, reason: "deterministic_test_failure", runnerId: "semantic-failure" })).resolves.toMatchObject({
      task: { needsHumanReason: "deterministic_test_failure", status: "needs_human" }
    });

    const nonFixReview = await initialCandidate();
    const reviews = createReviewRepositories(database);
    const nonFixRunner = "non-fix-review-failure";
    const nonFixClaim = (await reviews.claimCandidateReadyReview({
      budget,
      contextPolicy: reviewPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "reasoning",
      runnerId: nonFixRunner,
      taskId: nonFixReview.task.id
    }))!;
    const nonFixFence = {
      leaseGeneration: 1,
      reviewId: nonFixClaim.review.id,
      runnerId: nonFixRunner
    };
    await reviews.saveReviewContext({
      ...nonFixFence,
      contextDigest: "f".repeat(64),
      contextManifest: manifest,
      now: new Date()
    });
    await reviews.startReviewExecution({ ...nonFixFence, now: new Date() });
    await reviews.recordReviewFailure({
      ...nonFixFence,
      failureClass: "provider",
      now: new Date()
    });
    await reviews.recordReviewCleanup({ ...nonFixFence, now: new Date(), status: "succeeded" });
    await expect(reviews.prepareReviewInfrastructureRetry({
      ...nonFixFence,
      failureClass: "provider",
      leaseDurationMs: 60_000
    })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(reviews.completeReviewFailure({
      ...nonFixFence,
      needsHumanReason: "reviewer_failure",
      now: new Date(),
      safeSummary: "must remain Phase 2B-pure"
    })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await reviews.completeReviewFailure({
      ...nonFixFence,
      now: new Date(),
      safeSummary: "Phase 2B review failed without Phase 2C task transition"
    });

    const infrastructure = await initialCandidate();
    const infrastructureReview = await reviewCandidate(infrastructure.task.id, "REQUEST_CHANGES", [finding({ text: "infrastructure" })]);
    await fix.reconcileCurrentReview({ reviewId: infrastructureReview.id });
    const infrastructureAttempt = (await development.claimFixRequiredDevelopmentTask({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "balanced", runnerId: "infra", taskId: infrastructure.task.id }))!.attempt;
    let generation = infrastructureAttempt.leaseGeneration;
    for (let retry = 1; retry <= 2; retry += 1) {
      const result = await development.prepareDevelopmentInfrastructureRetry({ attemptId: infrastructureAttempt.id, failureClass: "provider", leaseDurationMs: 60_000, leaseGeneration: generation, runnerId: "infra" });
      generation = result.attempt.leaseGeneration;
      expect(result.attempt.infrastructureRetryCount).toBe(retry);
    }
    await expect(development.prepareDevelopmentInfrastructureRetry({ attemptId: infrastructureAttempt.id, failureClass: "provider", leaseDurationMs: 60_000, leaseGeneration: generation, runnerId: "infra" })).rejects.toBeInstanceOf(DevelopmentTransitionError);

    const reviewRetry = await initialCandidate();
    const reviewRetrySource = await reviewCandidate(
      reviewRetry.task.id,
      "REQUEST_CHANGES",
      [finding({ text: "review retry" })]
    );
    await createFixLoopRepositories(database).reconcileCurrentReview({
      reviewId: reviewRetrySource.id
    });
    await captureFix(reviewRetry.task.id, "review-retry-fix");
    const reviewRunner = "review-retry-owner";
    const reviewRepositories = createReviewRepositories(database);
    const reviewClaim = (await reviewRepositories.claimCandidateReadyReview({
      budget,
      contextPolicy: reviewPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "reasoning",
      runnerId: reviewRunner,
      taskId: reviewRetry.task.id
    }))!;
    const reviewFence = {
      leaseGeneration: 1,
      reviewId: reviewClaim.review.id,
      runnerId: reviewRunner
    };
    await reviewRepositories.saveReviewContext({
      ...reviewFence,
      contextDigest: "8".repeat(64),
      contextManifest: manifest,
      now: new Date()
    });
    await reviewRepositories.startReviewExecution({ ...reviewFence, now: new Date() });
    await reviewRepositories.recordReviewFailure({
      ...reviewFence,
      failureClass: "provider",
      now: new Date()
    });
    await reviewRepositories.recordReviewCleanup({
      ...reviewFence,
      now: new Date(),
      status: "succeeded"
    });
    const prepared = await reviewRepositories.prepareReviewInfrastructureRetry({
      ...reviewFence,
      failureClass: "provider",
      leaseDurationMs: 50
    });
    const delayedClaim = createReviewRepositories(database, [], {
      afterClaimExistingLock: async () => {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    });
    await expect(delayedClaim.claimCandidateReadyReview({
      budget,
      contextPolicy: reviewPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "reasoning",
      runnerId: reviewRunner,
      taskId: reviewRetry.task.id
    })).resolves.toBeUndefined();
    expect(prepared.infrastructureRetryCount).toBe(1);
  });
});
