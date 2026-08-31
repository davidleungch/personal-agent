import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DevelopmentLeaseError,
  DevelopmentTransitionError,
  createDatabase,
  createDevelopmentRepositories,
  createReviewRepositories,
  migrateDatabase,
  type Database
} from "../src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

let database: Database;
let pool: Pool;
let closeDatabase: () => Promise<void>;
let fixtureCounter = 0;

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

async function candidateReady(now = new Date()) {
  fixtureCounter += 1;
  const baseCommit = fixtureCounter.toString(16).padStart(40, "1").slice(-40);
  const candidateCommit = fixtureCounter.toString(16).padStart(40, "2").slice(-40);
  const development = createDevelopmentRepositories(database);
  const task = await development.createApprovedDevelopmentTask({
    acceptanceCriteria: criteria,
    approvedAt: now,
    approvedSpec: "Review the exact bounded fixture",
    baseCommit,
    title: `Review fixture ${fixtureCounter}`
  });
  const claim = (await development.claimReadyDevelopmentTask({
    budget,
    leaseDurationMs: 60_000,
    modelProfile: "balanced",
    now,
    runnerId: `implementer-${fixtureCounter}`
  }))!;
  const fence = {
    attemptId: claim.attempt.id,
    leaseGeneration: 1,
    runnerId: `implementer-${fixtureCounter}`
  };
  await development.saveDevelopmentContext({
    ...fence,
    contextDigest: "d".repeat(64),
    contextManifest: { entries: manifest.entries, totalBytes: manifest.totalBytes },
    now: new Date(now.getTime() + 1)
  });
  await development.transitionDevelopmentAttempt({
    ...fence,
    attemptStatus: "implementing",
    now: new Date(now.getTime() + 2),
    taskStatus: "implementing"
  });
  await development.transitionDevelopmentAttempt({
    ...fence,
    attemptStatus: "testing",
    now: new Date(now.getTime() + 3),
    taskStatus: "testing"
  });
  await development.appendDevelopmentAttemptEvent({
    ...fence,
    kind: "test",
    now: new Date(now.getTime() + 4),
    safeMetadata: { criterion_id: "fixture", duration_ms: 5, exit_code: 0 },
    status: "success"
  });
  await development.transitionDevelopmentAttempt({
    ...fence,
    attemptStatus: "capturing_candidate",
    now: new Date(now.getTime() + 5),
    taskStatus: "testing"
  });
  await development.recordDevelopmentCandidate({
    ...fence,
    candidateCommit,
    candidateRef: `refs/personal-agent/development-attempts/${claim.attempt.id}`,
    now: new Date(now.getTime() + 6),
    safeSummary: "candidate"
  });
  await development.appendDevelopmentAttemptEvent({
    ...fence,
    kind: "teardown",
    now: new Date(now.getTime() + 7),
    safeMetadata: { sandbox_id: claim.attempt.sandboxId },
    status: "success"
  });
  return { attempt: claim.attempt, baseCommit, candidateCommit, task };
}

function emptyUsage() {
  return {
    commandMs: 0,
    commandOutputBytes: 0,
    costUsdMicros: 0,
    inputTokens: 0,
    modelInvocations: 0,
    outputTokens: 0,
    toolCalls: 0
  };
}

function finding() {
  return {
    acceptanceCriterionId: "fixture",
    architectureReference: "docs/design.md#reviewer",
    category: "correctness" as const,
    finding: "The exact candidate violates the approved behavior.",
    relevantPath: "src/value.txt",
    requiredCorrection: "Correct the bounded behavior and retain the acceptance check.",
    severity: "high" as const
  };
}

describe("Phase 2B review persistence", () => {
  it("durably finalizes strict APPROVE and never validates another candidate", async () => {
    const fixture = await candidateReady();
    const reviews = createReviewRepositories(database);
    const claimed = (await reviews.claimCandidateReadyReview({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "reasoning",
      runnerId: "reviewer-approve"
    }))!;
    expect(claimed.review).toMatchObject({
      candidateCommit: fixture.candidateCommit,
      role: "reviewer",
      status: "preparing"
    });
    const fence = { leaseGeneration: 1, reviewId: claimed.review.id, runnerId: "reviewer-approve" };
    await reviews.saveReviewContext({ ...fence, contextDigest: "e".repeat(64), contextManifest: manifest, now: new Date() });
    await reviews.startReviewExecution({ ...fence, now: new Date() });
    await reviews.recordReviewUsage({
      ...fence,
      delta: { commandMs: 1, commandOutputBytes: 0, costUsdMicros: 2, inputTokens: 3, modelInvocations: 1, outputTokens: 4, toolCalls: 1 },
      now: new Date()
    });
    const proposed = await reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "APPROVE", findings: [] }
    });
    await expect(reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "APPROVE", findings: [] }
    })).resolves.toMatchObject({ id: proposed.id, status: "finalizing" });
    await reviews.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" });
    const finalized = await reviews.finalizeReview({
      ...fence,
      contextDigest: "e".repeat(64),
      now: new Date()
    });
    expect(finalized).toMatchObject({ cleanupStatus: "succeeded", decision: "APPROVE", findings: [], status: "succeeded" });
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toMatchObject({ id: finalized.id });
    await expect(reviews.getAuthoritativeReview(fixture.task.id, "f".repeat(40))).resolves.toBeUndefined();
    const events = await reviews.listReviewEvents(finalized.id);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
  });

  it("makes candidate provenance and task/candidate authority invalidation irreversible", async () => {
    const fixture = await candidateReady();
    const reviews = createReviewRepositories(database);
    const runnerId = "reviewer-binding-regression";
    const claimed = (await reviews.claimCandidateReadyReview({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "reasoning",
      runnerId
    }))!;
    const fence = { leaseGeneration: 1, reviewId: claimed.review.id, runnerId };
    await reviews.saveReviewContext({ ...fence, contextDigest: "7".repeat(64), contextManifest: manifest, now: new Date() });
    await reviews.startReviewExecution({ ...fence, now: new Date() });
    await reviews.persistReviewProposal({ ...fence, now: new Date(), result: { decision: "APPROVE", findings: [] } });
    await reviews.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" });
    await reviews.finalizeReview({ ...fence, contextDigest: "7".repeat(64), now: new Date() });
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toMatchObject({ status: "succeeded" });

    await expect(pool.query(
      "update development_attempts set candidate_commit = $1 where id = $2",
      ["c".repeat(40), fixture.attempt.id]
    )).rejects.toBeDefined();
    const alternateTask = await createDevelopmentRepositories(database).createApprovedDevelopmentTask({
      acceptanceCriteria: criteria,
      approvedAt: new Date(),
      approvedSpec: "Alternate same-base task must not capture this candidate",
      baseCommit: fixture.baseCommit,
      title: "Alternate candidate binding"
    });
    await pool.query("update development_tasks set status = 'blocked' where id = $1", [alternateTask.id]);
    await expect(pool.query(
      "update development_attempts set task_id = $1 where id = $2",
      [alternateTask.id, fixture.attempt.id]
    )).rejects.toBeDefined();
    await expect(pool.query(
      "update development_reviews set candidate_commit = $1 where id = $2",
      ["c".repeat(40), claimed.review.id]
    )).rejects.toBeDefined();

    await pool.query("update development_tasks set status = 'blocked' where id = $1", [fixture.task.id]);
    const invalidatedTask = await createDevelopmentRepositories(database).getDevelopmentTask(fixture.task.id);
    expect(invalidatedTask?.authorityInvalidatedAt).toBeInstanceOf(Date);
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toBeUndefined();
    await pool.query("update development_tasks set status = 'candidate_ready' where id = $1", [fixture.task.id]);
    await expect(createDevelopmentRepositories(database).getDevelopmentTask(fixture.task.id)).resolves.toMatchObject({
      authorityInvalidatedAt: invalidatedTask!.authorityInvalidatedAt,
      status: "candidate_ready"
    });
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toBeUndefined();
    await expect(pool.query(
      "update development_tasks set authority_invalidated_at = null where id = $1",
      [fixture.task.id]
    )).rejects.toBeDefined();
    await expect(pool.query(
      "update development_tasks set authority_invalidated_at = authority_invalidated_at + interval '1 second' where id = $1",
      [fixture.task.id]
    )).rejects.toBeDefined();

    await createDevelopmentRepositories(database).blockDevelopmentCandidateIntegrity({
      attemptId: fixture.attempt.id,
      now: new Date()
    });
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toBeUndefined();
    await pool.query("update development_tasks set status = 'candidate_ready' where id = $1", [fixture.task.id]);
    await expect(pool.query(
      "update development_attempts set failure_class = null where id = $1",
      [fixture.attempt.id]
    )).rejects.toBeDefined();
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toBeUndefined();
    await expect(reviews.getAuthoritativeReview(fixture.task.id, "c".repeat(40))).resolves.toBeUndefined();
  });

  it("persists REQUEST_CHANGES with mandatory traceability and rejects malformed findings", async () => {
    await candidateReady();
    const reviews = createReviewRepositories(database);
    const claimed = (await reviews.claimCandidateReadyReview({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "balanced", runnerId: "reviewer-changes" }))!;
    const fence = { leaseGeneration: 1, reviewId: claimed.review.id, runnerId: "reviewer-changes" };
    await reviews.saveReviewContext({ ...fence, contextDigest: "f".repeat(64), contextManifest: manifest, now: new Date() });
    await reviews.startReviewExecution({ ...fence, now: new Date() });
    await expect(reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "REQUEST_CHANGES", findings: [{ ...finding(), acceptanceCriterionId: "unknown" }] }
    })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "APPROVE", findings: [finding()] } as never
    })).rejects.toBeDefined();
    await expect(reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "REQUEST_CHANGES", findings: [{ ...finding(), architectureReference: "n/a" }] }
    })).rejects.toBeDefined();
    await expect(reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "REQUEST_CHANGES", findings: [{ ...finding(), relevantPath: "src/missing.txt" }] }
    })).rejects.toBeDefined();
    const result = await reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "REQUEST_CHANGES", findings: [finding()] }
    });
    expect(result).toMatchObject({ decision: "REQUEST_CHANGES", findings: [finding()] });
  });

  it("claims once, fences stale owners, and keeps cleanup failure reclaimable", async () => {
    await candidateReady();
    const first = createReviewRepositories(database);
    const second = createReviewRepositories(database);
    const [a, b] = await Promise.all([
      first.claimCandidateReadyReview({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "fast", runnerId: "claim-a" }),
      second.claimCandidateReadyReview({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "fast", runnerId: "claim-b" })
    ]);
    const claimed = a ?? b!;
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const owner = a ? "claim-a" : "claim-b";
    await pool.query(
      "update development_reviews set lease_expires_at = current_timestamp - interval '1 second' where id = $1",
      [claimed.review.id]
    );
    const reclaimed = (await first.reclaimReview({ leaseDurationMs: 60_000, runnerId: "recovery-a" }))!;
    expect(reclaimed).toMatchObject({ leaseGeneration: 2, status: "interrupted" });
    await expect(first.appendReviewEvent({
      kind: "tool", leaseGeneration: 1, now: new Date(), reviewId: claimed.review.id, runnerId: owner, status: "success"
    })).rejects.toBeInstanceOf(DevelopmentLeaseError);
    await first.recordReviewCleanup({
      leaseGeneration: 2, now: new Date(), reviewId: claimed.review.id, runnerId: "recovery-a", status: "failed"
    });
    const reclaimedAgain = (await first.reclaimReview({
      leaseDurationMs: 60_000, runnerId: "recovery-b"
    }))!;
    expect(reclaimedAgain.leaseGeneration).toBe(3);
    await first.recordReviewCleanup({
      leaseGeneration: 3, now: new Date(), reviewId: claimed.review.id, runnerId: "recovery-b", status: "succeeded"
    });
    await pool.query("update development_reviews set failure_class = null where id = $1", [claimed.review.id]);
    await expect(first.completeReviewFailure({
      leaseGeneration: 3, now: new Date(), reviewId: claimed.review.id, runnerId: "recovery-b", safeSummary: "recovered without session"
    })).resolves.toMatchObject({ status: "failed" });
  });

  it("uses PostgreSQL time exclusively for Reviewer lease creation, renewal, and reclamation", async () => {
    await candidateReady();
    const reviews = createReviewRepositories(database);
    const claim = (await reviews.claimCandidateReadyReview({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "fast",
      runnerId: "database-clock-owner"
    }))!;
    const databaseClock = await pool.query<{ now: Date }>("select current_timestamp as now");
    expect(claim.review.leaseExpiresAt.getTime()).toBeGreaterThan(databaseClock.rows[0]!.now.getTime());

    await expect(reviews.reclaimReview({
      leaseDurationMs: 60_000,
      now: new Date("2100-01-01T00:00:00Z"),
      runnerId: "future-clock"
    } as never)).rejects.toBeDefined();
    await expect(reviews.getReview(claim.review.id)).resolves.toMatchObject({
      leaseGeneration: 1,
      leaseOwner: "database-clock-owner"
    });

    const renewed = await reviews.renewReviewLease({
      leaseDurationMs: 60_000,
      leaseGeneration: 1,
      reviewId: claim.review.id,
      runnerId: "database-clock-owner"
    });
    const afterRenewal = await pool.query<{ now: Date }>("select current_timestamp as now");
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(afterRenewal.rows[0]!.now.getTime());
    await expect(reviews.renewReviewLease({
      leaseDurationMs: 60_000,
      leaseGeneration: 1,
      now: new Date("1990-01-01T00:00:00Z"),
      reviewId: claim.review.id,
      runnerId: "database-clock-owner"
    } as never)).rejects.toBeDefined();

    await pool.query(
      "update development_reviews set lease_expires_at = current_timestamp - interval '1 second' where id = $1",
      [claim.review.id]
    );
    await expect(reviews.renewReviewLease({
      leaseDurationMs: 60_000,
      leaseGeneration: 1,
      reviewId: claim.review.id,
      runnerId: "database-clock-owner"
    })).rejects.toBeInstanceOf(DevelopmentLeaseError);
    const reclaimed = await reviews.reclaimReview({
      leaseDurationMs: 60_000,
      runnerId: "database-clock-recoverer"
    });
    expect(reclaimed).toMatchObject({ leaseGeneration: 2, leaseOwner: "database-clock-recoverer" });
    await expect(reviews.appendReviewEvent({
      kind: "tool",
      leaseGeneration: 1,
      now: new Date(),
      reviewId: claim.review.id,
      runnerId: "database-clock-owner",
      status: "success"
    })).rejects.toBeInstanceOf(DevelopmentLeaseError);
    await expect(reviews.finalizeReview({
      contextDigest: "a".repeat(64),
      leaseGeneration: 1,
      now: new Date(),
      reviewId: claim.review.id,
      runnerId: "database-clock-owner"
    })).rejects.toBeInstanceOf(DevelopmentLeaseError);
  });

  it("rejects a renewal that waits past expiry and derives reclaimed expiry after its lock", async () => {
    await candidateReady();
    const reviews = createReviewRepositories(database);
    const claim = (await reviews.claimCandidateReadyReview({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "fast",
      runnerId: "blocked-renewal-owner"
    }))!;
    await pool.query(
      "update development_reviews set lease_expires_at = clock_timestamp() + interval '500 milliseconds' where id = $1",
      [claim.review.id]
    );
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query("select id from development_reviews where id = $1 for update", [claim.review.id]);
    let renewalSettled = false;
    const renewal = reviews.renewReviewLease({
      leaseDurationMs: 60_000,
      leaseGeneration: 1,
      reviewId: claim.review.id,
      runnerId: "blocked-renewal-owner"
    }).finally(() => {
      renewalSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(renewalSettled).toBe(false);
    const expired = await pool.query<{ expired: boolean }>(
      "select lease_expires_at <= clock_timestamp() as expired from development_reviews where id = $1",
      [claim.review.id]
    );
    expect(expired.rows[0]?.expired).toBe(true);
    await blocker.query("commit");
    blocker.release();
    await expect(renewal).rejects.toBeInstanceOf(DevelopmentLeaseError);
    await expect(pool.query(
      "update development_reviews set lease_expires_at = clock_timestamp() + interval '1 minute' where id = $1",
      [claim.review.id]
    )).rejects.toBeDefined();

    let reclaimLocked!: () => void;
    let releaseReclaim!: () => void;
    const reclaimLock = new Promise<void>((resolve) => {
      reclaimLocked = resolve;
    });
    const reclaimRelease = new Promise<void>((resolve) => {
      releaseReclaim = resolve;
    });
    const delayed = createReviewRepositories(database, [], {
      afterReclaimLock: async () => {
        reclaimLocked();
        await reclaimRelease;
      }
    });
    const reclaiming = delayed.reclaimReview({
      leaseDurationMs: 3_000,
      runnerId: "post-lock-reclaimer"
    });
    await reclaimLock;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const releaseClock = await pool.query<{ now: Date }>("select clock_timestamp() as now");
    releaseReclaim();
    const reclaimed = (await reclaiming)!;
    expect(reclaimed.leaseGeneration).toBe(2);
    expect(reclaimed.leaseExpiresAt.getTime() - releaseClock.rows[0]!.now.getTime()).toBeGreaterThan(2_500);
    await expect(reviews.appendReviewEvent({
      kind: "tool",
      leaseGeneration: 1,
      now: new Date(),
      reviewId: claim.review.id,
      runnerId: "blocked-renewal-owner",
      status: "success"
    })).rejects.toBeInstanceOf(DevelopmentLeaseError);
  });

  it("finalizes exactly once when two finalizers contend on the PostgreSQL row lock", async () => {
    const fixture = await candidateReady();
    const owner = "competing-finalizer-owner";
    let enteredLock!: () => void;
    let releaseLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      enteredLock = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const first = createReviewRepositories(database, [], {
      afterFinalizeLock: async () => {
        enteredLock();
        await lockRelease;
      }
    });
    const second = createReviewRepositories(database);
    const claim = (await first.claimCandidateReadyReview({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "reasoning",
      runnerId: owner
    }))!;
    const fence = { leaseGeneration: 1, reviewId: claim.review.id, runnerId: owner };
    await first.saveReviewContext({
      ...fence,
      contextDigest: "9".repeat(64),
      contextManifest: manifest,
      now: new Date()
    });
    await first.startReviewExecution({ ...fence, now: new Date() });
    await first.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "APPROVE", findings: [] }
    });
    await first.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" });

    const firstFinalization = first.finalizeReview({
      ...fence,
      contextDigest: "9".repeat(64),
      now: new Date()
    });
    await lockEntered;
    const secondFinalization = second.finalizeReview({
      ...fence,
      contextDigest: "9".repeat(64),
      now: new Date()
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLock();
    const results = await Promise.allSettled([firstFinalization, secondFinalization]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(first.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toMatchObject({
      candidateCommit: fixture.candidateCommit,
      status: "succeeded"
    });
    const events = await first.listReviewEvents(claim.review.id);
    expect(events.filter((event) => event.kind === "finalization" && event.status === "success")).toHaveLength(1);
  });

  it("fails every invalid lifecycle, budget, lease, context, and finalization boundary", async () => {
    await candidateReady();
    const reviews = createReviewRepositories(database, ["REVIEW_DB_CANARY"]);
    const claim = (await reviews.claimCandidateReadyReview({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "fast", runnerId: "boundary-reviewer" }))!;
    const fence = { leaseGeneration: 1, reviewId: claim.review.id, runnerId: "boundary-reviewer" };
    await expect(reviews.getReviewContextInput(randomUUID())).resolves.toBeUndefined();
    await expect(reviews.completeReviewFailure({ ...fence, now: new Date(), safeSummary: "too early" })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(reviews.persistReviewProposal({ ...fence, now: new Date(), result: { decision: "APPROVE", findings: [] } })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(reviews.startReviewExecution({ ...fence, now: new Date() })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await reviews.saveReviewContext({ ...fence, contextDigest: "1".repeat(64), contextManifest: manifest, now: new Date() });
    await expect(reviews.saveReviewContext({ ...fence, contextDigest: "2".repeat(64), contextManifest: manifest, now: new Date() })).rejects.toThrow("immutable");
    await reviews.startReviewExecution({ ...fence, now: new Date() });
    await expect(reviews.startReviewExecution({ ...fence, now: new Date() })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(reviews.finalizeReview({ ...fence, contextDigest: "1".repeat(64), now: new Date() })).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(reviews.recordReviewUsage({
      ...fence,
      delta: { ...claim.review.usage, modelInvocations: budget.maxModelInvocations + 1 },
      now: new Date()
    })).rejects.toThrow("budget exhausted");
    await expect(reviews.appendReviewEvent({
      ...fence, kind: "tool", now: new Date(), safeMetadata: { unsafe: "REVIEW_DB_CANARY" }, status: "failed"
    })).rejects.toThrow("Secret material");
    await expect(reviews.renewReviewLease({ ...fence, leaseDurationMs: 1_000, runnerId: "wrong" })).rejects.toBeInstanceOf(DevelopmentLeaseError);
    await expect(reviews.renewReviewLease({ ...fence, leaseDurationMs: 60_000 })).resolves.toMatchObject({ id: claim.review.id });
    await reviews.persistReviewProposal({ ...fence, now: new Date(), result: { decision: "APPROVE", findings: [] } });
    await expect(reviews.persistReviewProposal({
      ...fence, now: new Date(), result: { decision: "REQUEST_CHANGES", findings: [finding()] }
    })).rejects.toThrow("different Reviewer proposal");
    await reviews.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" });
    await expect(reviews.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" })).resolves.toMatchObject({ cleanupStatus: "succeeded" });
    await reviews.recordReviewFailure({ ...fence, failureClass: "forced_failure", now: new Date() });
    const failed = await reviews.completeReviewFailure({ ...fence, now: new Date(), safeSummary: "safe REVIEW_DB_CANARY" });
    expect(failed).toMatchObject({ safeSummary: "safe [REDACTED]", status: "failed" });
    await expect(reviews.recordReviewFailure({ ...fence, failureClass: "again", now: new Date() })).rejects.toBeInstanceOf(DevelopmentTransitionError);

    const changed = await candidateReady();
    const changedClaim = (await reviews.claimCandidateReadyReview({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "fast", runnerId: "binding-reviewer" }))!;
    const changedFence = { leaseGeneration: 1, reviewId: changedClaim.review.id, runnerId: "binding-reviewer" };
    await reviews.saveReviewContext({ ...changedFence, contextDigest: "3".repeat(64), contextManifest: manifest, now: new Date() });
    await reviews.startReviewExecution({ ...changedFence, now: new Date() });
    await reviews.persistReviewProposal({ ...changedFence, now: new Date(), result: { decision: "APPROVE", findings: [] } });
    await reviews.recordReviewCleanup({ ...changedFence, now: new Date(), status: "succeeded" });
    await createDevelopmentRepositories(database).blockDevelopmentCandidateIntegrity({ attemptId: changed.attempt.id, now: new Date() });
    await expect(reviews.finalizeReview({ ...changedFence, contextDigest: "3".repeat(64), now: new Date() })).rejects.toThrow("binding changed");

    const missing = await candidateReady();
    await pool.query("update development_attempts set context_manifest = null, context_digest = null where id = $1", [missing.attempt.id]);
    await expect(reviews.claimCandidateReadyReview({ budget, contextPolicy, leaseDurationMs: 1_000, modelProfile: "fast", runnerId: "missing-context" })).rejects.toThrow("missing required");
    await createDevelopmentRepositories(database).blockDevelopmentCandidateIntegrity({ attemptId: missing.attempt.id, now: new Date() });
    await expect(reviews.reclaimReview({ leaseDurationMs: 1_000, runnerId: "none" })).resolves.toBeUndefined();
  });

  it("rejects fabricated authoritative terminal transitions directly in PostgreSQL", async () => {
    const fixture = await candidateReady();
    const reviews = createReviewRepositories(database);
    const claim = (await reviews.claimCandidateReadyReview({
      budget,
      contextPolicy,
      leaseDurationMs: 60_000,
      modelProfile: "reasoning",
      runnerId: "direct-terminal-reviewer"
    }))!;
    const terminalUpdate = `update development_reviews set
      decision = 'APPROVE', findings = '[]'::jsonb, status = 'succeeded',
      cleanup_status = 'succeeded', safe_summary = 'fabricated approval',
      completed_at = clock_timestamp(), finalized_at = clock_timestamp()
      where id = $1`;
    await expect(pool.query(terminalUpdate, [claim.review.id])).rejects.toBeDefined();
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toBeUndefined();

    const fence = {
      leaseGeneration: claim.review.leaseGeneration,
      reviewId: claim.review.id,
      runnerId: "direct-terminal-reviewer"
    };
    await reviews.saveReviewContext({
      ...fence,
      contextDigest: "8".repeat(64),
      contextManifest: manifest,
      now: new Date()
    });
    await expect(pool.query(terminalUpdate, [claim.review.id])).rejects.toBeDefined();
    await reviews.startReviewExecution({ ...fence, now: new Date() });
    await reviews.persistReviewProposal({
      ...fence,
      now: new Date(),
      result: { decision: "APPROVE", findings: [] }
    });
    await expect(pool.query(
      `update development_reviews set status = 'succeeded', safe_summary = 'incomplete cleanup',
       completed_at = clock_timestamp(), finalized_at = clock_timestamp() where id = $1`,
      [claim.review.id]
    )).rejects.toBeDefined();
    await expect(reviews.getAuthoritativeReview(fixture.task.id, fixture.candidateCommit)).resolves.toBeUndefined();
    await reviews.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" });
    await expect(reviews.finalizeReview({
      ...fence,
      contextDigest: "8".repeat(64),
      now: new Date()
    })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("rejects malformed pending Reviewer context policies directly in PostgreSQL", async () => {
    const malformedPolicies = [
      { ...contextPolicy, extra: true },
      { ...contextPolicy, readablePaths: [] },
      { ...contextPolicy, relevantPaths: ["."] },
      { ...contextPolicy, relevantPaths: [" src/value.txt"] },
      { ...contextPolicy, forbiddenPaths: ["../escape"] },
      { ...contextPolicy, readablePaths: Array.from({ length: 65 }, () => "src") }
    ];
    for (const malformedPolicy of malformedPolicies) {
      const fixture = await candidateReady();
      const reviewId = randomUUID();
      await expect(pool.query(
        `insert into development_reviews (
          id, task_id, implementer_attempt_id, status, harness_adapter, model_profile,
          base_commit, candidate_commit, candidate_ref, retention_ref, sandbox_id,
          context_policy, budget, usage, lease_owner, lease_expires_at, started_at
        ) values (
          $1, $2, $3, 'preparing', 'pi', 'reasoning', $4, $5, $6, $7, $8,
          $9::jsonb, $10::jsonb, $11::jsonb, 'direct-policy-test',
          current_timestamp + interval '1 minute', current_timestamp
        )`,
        [
          reviewId,
          fixture.task.id,
          fixture.attempt.id,
          fixture.baseCommit,
          fixture.candidateCommit,
          `refs/personal-agent/development-attempts/${fixture.attempt.id}`,
          `refs/personal-agent/reviews/${reviewId}`,
          `development-review-${reviewId}`,
          JSON.stringify(malformedPolicy),
          JSON.stringify(budget),
          JSON.stringify({ commandMs: 0, commandOutputBytes: 0, costUsdMicros: 0, inputTokens: 0, modelInvocations: 0, outputTokens: 0, toolCalls: 0 })
        ]
      )).rejects.toBeDefined();
    }
  });

  it("rejects malformed Reviewer budget and usage JSON directly in PostgreSQL", async () => {
    const malformedPairs = [
      [{ ...budget, unsupported: true }, emptyUsage()],
      [{ ...budget, maxModelInvocations: 0 }, emptyUsage()],
      [{ ...budget, maxCommandMs: 1.5 }, emptyUsage()],
      [budget, { ...emptyUsage(), unsupported: 1 }],
      [budget, { ...emptyUsage(), toolCalls: -1 }],
      [budget, { ...emptyUsage(), modelInvocations: budget.maxModelInvocations + 1 }]
    ];
    for (const [malformedBudget, malformedUsage] of malformedPairs) {
      const fixture = await candidateReady();
      const reviewId = randomUUID();
      await expect(pool.query(
        `insert into development_reviews (
          id, task_id, implementer_attempt_id, status, harness_adapter, model_profile,
          base_commit, candidate_commit, candidate_ref, retention_ref, sandbox_id,
          context_policy, budget, usage, lease_owner, lease_expires_at, started_at
        ) values (
          $1, $2, $3, 'preparing', 'pi', 'reasoning', $4, $5, $6, $7, $8,
          $9::jsonb, $10::jsonb, $11::jsonb, 'direct-json-test',
          clock_timestamp() + interval '1 minute', clock_timestamp()
        )`,
        [
          reviewId,
          fixture.task.id,
          fixture.attempt.id,
          fixture.baseCommit,
          fixture.candidateCommit,
          `refs/personal-agent/development-attempts/${fixture.attempt.id}`,
          `refs/personal-agent/reviews/${reviewId}`,
          `development-review-${reviewId}`,
          JSON.stringify(contextPolicy),
          JSON.stringify(malformedBudget),
          JSON.stringify(malformedUsage)
        ]
      )).rejects.toBeDefined();
    }
  });

  it("enforces immutable exact binding and append-only review history in PostgreSQL", async () => {
    await candidateReady();
    const reviews = createReviewRepositories(database);
    const claim = (await reviews.claimCandidateReadyReview({ budget, contextPolicy, leaseDurationMs: 60_000, modelProfile: "fast", runnerId: "constraint-reviewer" }))!;
    const fence = {
      leaseGeneration: claim.review.leaseGeneration,
      reviewId: claim.review.id,
      runnerId: "constraint-reviewer"
    };
    await expect(pool.query("update development_reviews set candidate_commit = $1 where id = $2", ["9".repeat(40), claim.review.id])).rejects.toBeDefined();
    await expect(pool.query("update development_reviews set retention_ref = $1 where id = $2", ["refs/personal-agent/reviews/corrupt", claim.review.id])).rejects.toBeDefined();
    await expect(pool.query("update development_reviews set context_policy = $1 where id = $2", [JSON.stringify({ ...contextPolicy, readablePaths: ["."] }), claim.review.id])).rejects.toBeDefined();
    await expect(pool.query(
      "update development_reviews set findings = $1 where id = $2",
      [JSON.stringify([{ junk: true }]), claim.review.id]
    )).rejects.toBeDefined();
    await expect(pool.query(
      "update development_reviews set findings = $1 where id = $2",
      [JSON.stringify([finding()]), claim.review.id]
    )).rejects.toBeDefined();
    for (const malformedManifest of [
      { entries: [], totalBytes: 0 },
      { ...manifest, extra: true },
      { ...manifest, authorityReferences: ["/absolute.md#reviewer"] },
      { ...manifest, entries: [{ ...manifest.entries[0], path: " docs/design.md" }], totalBytes: 1 },
      { ...manifest, entries: [{ ...manifest.entries[0], bytes: -1 }], totalBytes: -1 }
    ]) {
      await expect(pool.query(
        "update development_reviews set context_manifest = $1, context_digest = $2 where id = $3",
        [JSON.stringify(malformedManifest), "a".repeat(64), claim.review.id]
      )).rejects.toBeDefined();
    }
    await reviews.saveReviewContext({
      ...fence,
      contextDigest: "a".repeat(64),
      contextManifest: manifest,
      now: new Date()
    });
    await reviews.startReviewExecution({ ...fence, now: new Date() });
    const malformedFindings = [
      { ...finding(), severity: "invalid" },
      { ...finding(), extra: "not-strict" },
      { ...finding(), finding: "" },
      { ...finding(), requiredCorrection: "x".repeat(4_001) },
      { ...finding(), acceptanceCriterionId: "unknown" },
      { ...finding(), architectureReference: "docs/design.md#not-approved" },
      { ...finding(), relevantPath: "src/missing.txt" }
    ];
    for (const malformed of malformedFindings) {
      await expect(pool.query(
        "update development_reviews set decision = 'REQUEST_CHANGES', findings = $1, status = 'finalizing' where id = $2",
        [JSON.stringify([malformed]), claim.review.id]
      )).rejects.toBeDefined();
    }
    await expect(pool.query(
      "update development_reviews set decision = 'REQUEST_CHANGES', findings = $1, status = 'finalizing' where id = $2",
      [JSON.stringify(Array.from({ length: 65 }, () => finding())), claim.review.id]
    )).rejects.toBeDefined();
    const [event] = await reviews.listReviewEvents(claim.review.id);
    await expect(pool.query("update development_review_events set status = 'failed' where id = $1", [event!.id])).rejects.toBeDefined();
    await expect(pool.query("delete from development_review_events where id = $1", [event!.id])).rejects.toBeDefined();
    await expect(pool.query("delete from development_reviews where id = $1", [claim.review.id])).rejects.toBeDefined();
    await expect(reviews.getReview(randomUUID())).resolves.toBeUndefined();
  });
});
