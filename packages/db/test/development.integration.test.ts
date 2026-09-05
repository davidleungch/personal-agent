import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DevelopmentBudgetError,
  DevelopmentLeaseError,
  DevelopmentTransitionError,
  createDatabase,
  createDevelopmentRepositories,
  migrateDatabase,
  type Database
} from "../src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

let database: Database;
let pool: Pool;
let closeDatabase: () => Promise<void>;

const commit = "1".repeat(40);
const candidate = "2".repeat(40);
const digest = "3".repeat(64);
const budget = {
  maxCommandMs: 10_000,
  maxCommandOutputBytes: 10_000,
  maxContextBytes: 10_000,
  maxCostUsdMicros: 1_000_000,
  maxDiffBytes: 10_000,
  maxModelInvocations: 2,
  maxTokens: 1_000,
  maxToolCalls: 3,
  maxWallClockMs: 60_000,
  maxWorkspaceBytes: 100_000
};
const acceptanceCriteria = [
  {
    check: { arguments: ["test"], executable: "pnpm" as const, timeoutMs: 5_000 },
    description: "Tests pass",
    id: "tests"
  }
];
const manifest = {
  entries: [{ blobId: commit, bytes: 5, path: "AGENTS.md", source: "authority" as const }],
  totalBytes: 5
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

describe("Phase 2A development persistence", () => {
  const canary = "DEVELOPMENT_DATABASE_CANARY";

  it("runs the ordinary fenced task and attempt state path to candidate_ready", async () => {
    const repositories = createDevelopmentRepositories(database, [canary]);
    const approvedAt = new Date("2026-08-27T00:00:00.000Z");
    const task = await repositories.createApprovedDevelopmentTask({
      acceptanceCriteria,
      approvedAt,
      approvedSpec: "Change one bounded fixture",
      baseCommit: commit,
      title: "Bounded fixture"
    });
    expect(task).toMatchObject({ status: "ready" });
    expect(task).not.toHaveProperty("maxAttempts");
    await expect(repositories.getDevelopmentTask(task.id)).resolves.toEqual(task);
    await expect(repositories.getDevelopmentTask(randomUUID())).resolves.toBeUndefined();

    const claim = await repositories.claimReadyDevelopmentTask({
      budget,
      leaseDurationMs: 10_000,
      modelProfile: "balanced",
      now: approvedAt,
      runnerId: "runner-a"
    });
    expect(claim?.attempt).toMatchObject({
      attemptNumber: 1,
      baseCommit: commit,
      leaseGeneration: 1,
      role: "implementer",
      status: "preparing"
    });
    expect(claim?.task.status).toBe("preparing");
    const attempt = claim!.attempt;
    await expect(repositories.getDevelopmentAttempt(attempt.id)).resolves.toEqual(attempt);
    await expect(repositories.getDevelopmentAttempt(randomUUID())).resolves.toBeUndefined();
    await expect(
      repositories.claimReadyDevelopmentTask({
        budget,
        leaseDurationMs: 10_000,
        modelProfile: "fast",
        now: approvedAt,
        runnerId: "runner-b"
      })
    ).resolves.toBeUndefined();

    const fence = {
      attemptId: attempt.id,
      leaseGeneration: 1,
      runnerId: "runner-a"
    };
    await repositories.saveDevelopmentContext({
      ...fence,
      contextDigest: digest,
      contextManifest: manifest,
      now: new Date("2026-08-27T00:00:01.000Z")
    });
    await repositories.saveDevelopmentContext({
      ...fence,
      contextDigest: digest,
      contextManifest: manifest,
      now: new Date("2026-08-27T00:00:02.000Z")
    });
    await expect(
      repositories.saveDevelopmentContext({
        ...fence,
        contextDigest: "4".repeat(64),
        contextManifest: manifest,
        now: new Date("2026-08-27T00:00:03.000Z")
      })
    ).rejects.toThrow("immutable");

    await repositories.transitionDevelopmentAttempt({
      ...fence,
      attemptStatus: "implementing",
      now: new Date("2026-08-27T00:00:04.000Z"),
      taskStatus: "implementing"
    });
    await repositories.recordDevelopmentUsage({
      ...fence,
      delta: {
        commandMs: 5,
        commandOutputBytes: 4,
        costUsdMicros: 2,
        inputTokens: 3,
        modelInvocations: 1,
        outputTokens: 2,
        toolCalls: 1
      },
      now: new Date("2026-08-27T00:00:05.000Z")
    });
    await repositories.appendDevelopmentAttemptEvent({
      ...fence,
      kind: "tool",
      now: new Date("2026-08-27T00:00:06.000Z"),
      safeMetadata: { duration_ms: 5, tool: "sandbox.read" },
      status: "success"
    });
    await repositories.transitionDevelopmentAttempt({
      ...fence,
      attemptStatus: "testing",
      now: new Date("2026-08-27T00:00:07.000Z"),
      safeMetadata: { gate: "tests" },
      taskStatus: "testing"
    });
    await expect(
      repositories.recordDevelopmentCandidate({
        ...fence,
        candidateCommit: candidate,
        candidateRef: "refs/not-trusted",
        now: new Date("2026-08-27T00:00:08.000Z"),
        safeSummary: canary
      })
    ).rejects.toThrow("trusted attempt ref");
    await expect(
      repositories.recordDevelopmentCandidate({
        ...fence,
        candidateCommit: candidate,
        candidateRef: `refs/personal-agent/development-attempts/${attempt.id}`,
        now: new Date("2026-08-27T00:00:08.000Z"),
        safeSummary: "too early"
      })
    ).rejects.toThrow("current state");
    await repositories.transitionDevelopmentAttempt({
      ...fence,
      attemptStatus: "capturing_candidate",
      now: new Date("2026-08-27T00:00:08.000Z"),
      taskStatus: "testing"
    });
    await expect(
      repositories.captureDevelopmentCandidate({
        ...fence,
        capture: async () => ({ candidateCommit: candidate, candidateRef: "refs/wrong" }),
        now: new Date("2026-08-27T00:00:08.500Z"),
        safeSummary: "wrong ref"
      })
    ).rejects.toThrow("trusted attempt ref");
    const result = await repositories.recordDevelopmentCandidate({
      ...fence,
      candidateCommit: candidate,
      candidateRef: `refs/personal-agent/development-attempts/${attempt.id}`,
      now: new Date("2026-08-27T00:00:09.000Z"),
      safeSummary: `safe ${canary}`
    });
    expect(result.task.status).toBe("candidate_ready");
    expect(result.attempt).toMatchObject({
      candidateCommit: candidate,
      safeSummary: "safe [REDACTED]",
      status: "succeeded"
    });
    const events = await repositories.listDevelopmentAttemptEvents(attempt.id);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
  });

  it("rejects unsafe ingress, invalid transitions, stale leases, and exhausted budgets", async () => {
    const repositories = createDevelopmentRepositories(database, [canary]);
    await expect(
      repositories.createApprovedDevelopmentTask({
        acceptanceCriteria,
        approvedAt: new Date(),
        approvedSpec: `contains ${canary}`,
        baseCommit: commit,
        title: "unsafe"
      })
    ).rejects.toThrow("Secret material");
    await expect(
      repositories.createApprovedDevelopmentTask({
        acceptanceCriteria: [
          {
            ...acceptanceCriteria[0]!,
            description: "unsafe",
            check: { ...acceptanceCriteria[0]!.check, arguments: [canary] }
          }
        ],
        approvedAt: new Date(),
        approvedSpec: "safe",
        baseCommit: commit,
        title: "unsafe criteria"
      })
    ).rejects.toThrow("unsafe durable data");

    const now = new Date("2026-08-27T01:00:00.000Z");
    const task = await repositories.createApprovedDevelopmentTask({
      acceptanceCriteria,
      approvedAt: now,
      approvedSpec: "Exercise failure handling",
      baseCommit: commit,
      title: "Failure handling"
    });
    const claim = (await repositories.claimReadyDevelopmentTask({
      budget,
      leaseDurationMs: 1_000,
      modelProfile: "fast",
      now,
      runnerId: "runner-old"
    }))!;
    const fence = {
      attemptId: claim.attempt.id,
      leaseGeneration: 1,
      runnerId: "runner-old"
    };
    await expect(
      repositories.blockDevelopmentCandidateIntegrity({
        attemptId: claim.attempt.id,
        now: new Date("2026-08-27T01:00:00.025Z")
      })
    ).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(
      repositories.blockDevelopmentCandidateIntegrity({
        attemptId: randomUUID(),
        now: new Date("2026-08-27T01:00:00.030Z")
      })
    ).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(
      repositories.reconcileDevelopmentCandidate({
        ...fence,
        candidateCommit: candidate,
        candidateRef: `refs/personal-agent/development-attempts/${claim.attempt.id}`,
        now: new Date("2026-08-27T01:00:00.050Z"),
        safeSummary: "not interrupted"
      })
    ).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(
      repositories.transitionDevelopmentAttempt({
        ...fence,
        attemptStatus: "implementing",
        now: new Date("2026-08-27T01:00:00.075Z"),
        taskStatus: "testing"
      })
    ).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(
      repositories.transitionDevelopmentAttempt({
        ...fence,
        attemptStatus: "testing",
        now: new Date("2026-08-27T01:00:00.100Z"),
        taskStatus: "testing"
      })
    ).rejects.toBeInstanceOf(DevelopmentTransitionError);
    await expect(
      repositories.renewDevelopmentLease({
        ...fence,
        leaseDurationMs: 1_000,
        now: new Date("2026-08-27T01:00:00.100Z"),
        runnerId: "wrong-runner"
      })
    ).rejects.toBeInstanceOf(DevelopmentLeaseError);
    await repositories.renewDevelopmentLease({
      ...fence,
      leaseDurationMs: 1_000,
      now: new Date("2026-08-27T01:00:00.100Z")
    });
    await expect(
      repositories.recordDevelopmentUsage({
        ...fence,
        delta: { ...claim.attempt.usage, modelInvocations: 3 },
        now: new Date("2026-08-27T01:00:00.200Z")
      })
    ).rejects.toBeInstanceOf(DevelopmentBudgetError);
    await expect(
      repositories.appendDevelopmentAttemptEvent({
        ...fence,
        kind: "harness",
        now: new Date("2026-08-27T01:00:00.300Z"),
        safeMetadata: { selected: "gpt-5.6-provider" },
        status: "failed"
      })
    ).rejects.toThrow("Unsafe durable metadata");

    await pool.query(
      "update development_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [claim.attempt.id]
    );
    const reclaimed = await repositories.reclaimExpiredDevelopmentAttempt({
      leaseDurationMs: 1_000,
      now: new Date("2026-08-27T01:00:02.000Z"),
      runnerId: "runner-new"
    });
    expect(reclaimed).toMatchObject({ leaseGeneration: 2, status: "interrupted" });
    await expect(
      repositories.appendDevelopmentAttemptEvent({
        ...fence,
        kind: "tool",
        now: new Date("2026-08-27T01:00:02.100Z"),
        status: "success"
      })
    ).rejects.toBeInstanceOf(DevelopmentLeaseError);
    await expect(
      repositories.reconcileDevelopmentCandidate({
        attemptId: claim.attempt.id,
        candidateCommit: candidate,
        candidateRef: "refs/wrong",
        leaseGeneration: 2,
        now: new Date("2026-08-27T01:00:02.100Z"),
        runnerId: "runner-new",
        safeSummary: "recovered"
      })
    ).rejects.toThrow("trusted attempt ref");
    const reconciled = await repositories.reconcileDevelopmentCandidate({
      attemptId: claim.attempt.id,
      candidateCommit: candidate,
      candidateRef: `refs/personal-agent/development-attempts/${claim.attempt.id}`,
      leaseGeneration: 2,
      now: new Date("2026-08-27T01:00:02.100Z"),
      runnerId: "runner-new",
      safeSummary: `recovered ${canary}`
    });
    expect(reconciled.task).toMatchObject({ id: task.id, status: "candidate_ready" });
    expect(reconciled.attempt.safeSummary).toBe("recovered [REDACTED]");
    await expect(
      repositories.reclaimExpiredDevelopmentAttempt({
        leaseDurationMs: 1_000,
        now: new Date("2026-08-27T02:00:00.000Z"),
        runnerId: "none"
      })
    ).resolves.toBeUndefined();
  });

  it("skips a locked task during attempt recovery and reclaims a later attempt", async () => {
    const repositories = createDevelopmentRepositories(database);
    const firstTask = await repositories.createApprovedDevelopmentTask({
      acceptanceCriteria, approvedAt: new Date("2026-08-27T02:30:00.000Z"), approvedSpec: "First", baseCommit: commit, title: "First recovery"
    });
    const secondTask = await repositories.createApprovedDevelopmentTask({
      acceptanceCriteria, approvedAt: new Date("2026-08-27T02:30:01.000Z"), approvedSpec: "Second", baseCommit: commit, title: "Second recovery"
    });
    const firstClaim = (await repositories.claimReadyDevelopmentTask({
      budget, leaseDurationMs: 60_000, modelProfile: "fast", now: new Date(), runnerId: "attempt-a"
    }))!;
    const secondClaim = (await repositories.claimReadyDevelopmentTask({
      budget, leaseDurationMs: 60_000, modelProfile: "fast", now: new Date(), runnerId: "attempt-b"
    }))!;
    await pool.query("update development_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id in ($1, $2)", [firstClaim.attempt.id, secondClaim.attempt.id]);

    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query("select id from development_tasks where id = $1 for update", [firstTask.id]);
    try {
      const reclaimed = await repositories.reclaimExpiredDevelopmentAttempt({ leaseDurationMs: 60_000, now: new Date(), runnerId: "recover-b" });
      expect(reclaimed).toMatchObject({ id: secondClaim.attempt.id, leaseGeneration: 2, status: "interrupted" });
    } finally {
      await blocker.query("commit");
      blocker.release();
    }
    const attemptBlocker = await pool.connect();
    await attemptBlocker.query("begin");
    await attemptBlocker.query("select id from development_attempts where id = $1 for update", [firstClaim.attempt.id]);
    await expect(repositories.reclaimExpiredDevelopmentAttempt({
      leaseDurationMs: 60_000, now: new Date(), runnerId: "attempt-skip"
    })).resolves.toBeUndefined();
    await attemptBlocker.query("commit");
    attemptBlocker.release();

    await expect(repositories.reclaimExpiredDevelopmentAttempt({
      leaseDurationMs: 60_000, now: new Date(), runnerId: "recover-a"
    })).resolves.toMatchObject({ id: firstClaim.attempt.id, leaseGeneration: 2 });
    expect(secondTask.id).not.toBe(firstTask.id);
  });

  it("propagates unexpected recovery errors instead of treating them as contention", async () => {
    const repositories = createDevelopmentRepositories(database);
    const task = await repositories.createApprovedDevelopmentTask({
      acceptanceCriteria, approvedAt: new Date(), approvedSpec: "Unexpected error", baseCommit: commit, title: "Recovery error"
    });
    const claim = (await repositories.claimReadyDevelopmentTask({
      budget, leaseDurationMs: 60_000, modelProfile: "fast", now: new Date(), runnerId: "error-owner"
    }))!;
    await pool.query("update development_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [claim.attempt.id]);
    const failing = createDevelopmentRepositories(database, [], {
      afterReclaimLock: async () => { throw new Error("unexpected recovery failure"); }
    });
    await expect(failing.reclaimExpiredDevelopmentAttempt({
      leaseDurationMs: 60_000, now: new Date(), runnerId: "error-recoverer"
    })).rejects.toThrow("unexpected recovery failure");
    await expect(createDevelopmentRepositories(database).reclaimExpiredDevelopmentAttempt({
      leaseDurationMs: 60_000, now: new Date(), runnerId: "cleanup-recoverer"
    })).resolves.toMatchObject({ id: claim.attempt.id });
    expect(task.id).toBe(claim.task.id);
  });

  it("enforces immutable contracts, exact base binding, restrictive history, and append-only events", async () => {
    const repositories = createDevelopmentRepositories(database);
    const now = new Date("2026-08-27T03:00:00.000Z");
    const task = await repositories.createApprovedDevelopmentTask({
      acceptanceCriteria,
      approvedAt: now,
      approvedSpec: "Constraint test",
      baseCommit: commit,
      title: "Constraints"
    });
    const claim = (await repositories.claimReadyDevelopmentTask({
      budget,
      leaseDurationMs: 10_000,
      modelProfile: "reasoning",
      now,
      runnerId: "constraint-runner"
    }))!;
    await expect(
      pool.query("update development_tasks set approved_spec = $1 where id = $2", ["changed", task.id])
    ).rejects.toBeDefined();
    await expect(
      pool.query(
        "insert into development_attempts (id, task_id, attempt_number, role, status, harness_adapter, model_profile, base_commit, sandbox_id, budget, usage, lease_generation, started_at) values ($1,$2,1,'implementer','preparing','pi','fast',$3,'bad', $4::jsonb, $5::jsonb, 1, $6)",
        [randomUUID(), task.id, "9".repeat(40), JSON.stringify(budget), JSON.stringify(claim.attempt.usage), now]
      )
    ).rejects.toBeDefined();
    const [event] = await repositories.listDevelopmentAttemptEvents(claim.attempt.id);
    await expect(
      pool.query("update development_attempt_events set status = 'failed' where id = $1", [event!.id])
    ).rejects.toBeDefined();
    await expect(
      pool.query("delete from development_attempt_events where id = $1", [event!.id])
    ).rejects.toBeDefined();
    await expect(pool.query("delete from development_tasks where id = $1", [task.id])).rejects.toBeDefined();
  });

  it("holds the database ownership fence across trusted candidate capture", async () => {
    const repositories = createDevelopmentRepositories(database);
    const now = new Date("2026-08-27T04:00:00.000Z");
    const task = await repositories.createApprovedDevelopmentTask({
      acceptanceCriteria,
      approvedAt: now,
      approvedSpec: "Fence candidate capture",
      baseCommit: commit,
      title: "Candidate fence"
    });
    const claim = (await repositories.claimReadyDevelopmentTask({
      budget,
      leaseDurationMs: 1_000,
      modelProfile: "balanced",
      now,
      runnerId: "capture-runner"
    }))!;
    const fence = {
      attemptId: claim.attempt.id,
      leaseGeneration: 1,
      runnerId: "capture-runner"
    };
    await repositories.transitionDevelopmentAttempt({
      ...fence,
      attemptStatus: "implementing",
      now: new Date("2026-08-27T04:00:00.100Z"),
      taskStatus: "implementing"
    });
    await repositories.transitionDevelopmentAttempt({
      ...fence,
      attemptStatus: "testing",
      now: new Date("2026-08-27T04:00:00.200Z"),
      taskStatus: "testing"
    });
    await repositories.transitionDevelopmentAttempt({
      ...fence,
      attemptStatus: "capturing_candidate",
      now: new Date("2026-08-27T04:00:00.300Z"),
      taskStatus: "testing"
    });
    let enteredCapture!: () => void;
    let releaseCapture!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredCapture = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const capture = repositories.captureDevelopmentCandidate({
      ...fence,
      capture: async () => {
        enteredCapture();
        await release;
        return {
          candidateCommit: candidate,
          candidateRef: `refs/personal-agent/development-attempts/${claim.attempt.id}`
        };
      },
      now: new Date("2026-08-27T04:00:00.400Z"),
      safeSummary: "captured under lock"
    });
    await entered;
    try {
      const reclaimed = await repositories.reclaimExpiredDevelopmentAttempt({
        leaseDurationMs: 1_000,
        now: new Date("2026-08-27T04:00:02.000Z"),
        runnerId: "reclaimer"
      });
      expect(reclaimed?.id).not.toBe(claim.attempt.id);
    } finally {
      releaseCapture();
    }
    await expect(capture).resolves.toMatchObject({
      attempt: { status: "succeeded" },
      task: { id: task.id, status: "candidate_ready" }
    });
  });
});
