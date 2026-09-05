import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  createDevelopmentRepositories,
  createFixLoopRepositories,
  createReviewRepositories,
  migrateDatabase,
  type Database
} from "@personal-agent/db";
import { emptyDevelopmentUsage, type DevelopmentReviewResult } from "@personal-agent/shared";
import { Pool } from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DevelopmentEvent, DevelopmentHarness, DevelopmentHarnessInput } from "../src/contract";
import { DevelopmentContextCompiler } from "../src/context-compiler";
import { DevelopmentCoordinator } from "../src/coordinator";
import { FixLoopCoordinator, runBoundedFixLoop } from "../src/fix-loop-coordinator";
import { TrustedGit } from "../src/git";
import type { ProcessResult } from "../src/process";
import { ReviewerContextCompiler } from "../src/reviewer-context-compiler";
import { ReviewerCoordinator } from "../src/reviewer-coordinator";
import type { SandboxManager, SandboxWorkspace } from "../src/sandbox";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

let database: Database;
let pool: Pool;
let closeDatabase: () => Promise<void>;
const cleanup: string[] = [];

const budget = {
  maxCommandMs: 5_000,
  maxCommandOutputBytes: 20_000,
  maxContextBytes: 300_000,
  maxCostUsdMicros: 1_000_000,
  maxDiffBytes: 100_000,
  maxModelInvocations: 4,
  maxTokens: 10_000,
  maxToolCalls: 30,
  maxWallClockMs: 60_000,
  maxWorkspaceBytes: 100_000_000
};
const criteria = [{
  check: { arguments: ["-e", "process.exit(0)"], executable: "node" as const, timeoutMs: 1_000 },
  description: "Fixture check passes",
  id: "fixture"
}];
const implementationPolicy = {
  allowedPaths: ["src"],
  budget,
  forbiddenPaths: [".git", ".pi", "docs"],
  leaseDurationMs: 30_000,
  modelProfile: "balanced" as const,
  relevantPaths: ["src/value.txt"]
};
const reviewPolicy = {
  budget,
  forbiddenPaths: [".git", ".pi"],
  leaseDurationMs: 30_000,
  modelProfile: "reasoning" as const,
  readablePaths: ["AGENTS.md", "docs", "src"],
  relevantPaths: ["src/value.txt"]
};

beforeAll(async () => {
  const reset = new Pool({ connectionString: databaseUrl });
  await reset.query("drop schema public cascade");
  await reset.query("drop schema if exists drizzle cascade");
  await reset.query("create schema public");
  await reset.end();
  await migrateDatabase(databaseUrl, new URL("../../db/migrations", import.meta.url).pathname);
  const connection = createDatabase(databaseUrl);
  database = connection.database;
  pool = connection.pool;
  closeDatabase = connection.close;
});

afterAll(async () => {
  await closeDatabase();
  await Promise.all(cleanup.map((path) => rm(path, { force: true, recursive: true })));
});

async function repositoryFixture() {
  const repository = await mkdtemp(join(tmpdir(), "personal-agent-fix-loop-"));
  const workspaces = `${repository}-workspaces`;
  cleanup.push(repository, workspaces);
  await mkdir(join(repository, "docs/decisions"), { recursive: true });
  await mkdir(join(repository, "src"));
  await Promise.all([
    writeFile(join(repository, "AGENTS.md"), "# Agent rules\n\nDo not merge or deploy.\n"),
    writeFile(join(repository, "docs/design.md"), "# Design\n\n## Reviewer\nIndependent review.\n"),
    writeFile(join(repository, "docs/decisions/0001-pi-development-harness.md"), "# Harness\n\nIsolated.\n"),
    writeFile(join(repository, "docs/phase-2-implementation-plan.md"), "# Phase 2\n\n## Phase 2C\nBounded fixes only.\n"),
    writeFile(join(repository, "src/value.txt"), "base\n")
  ]);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "base"], { cwd: repository });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  return { base, git: new TrustedGit(repository, workspaces), repository };
}

class FakeSandboxManager implements SandboxManager {
  createFailures = 0;
  teardownFailures = 0;
  checkResult: ProcessResult = {
    durationMs: 1,
    exitCode: 0,
    outputLimitExceeded: false,
    stderr: "",
    stdout: "pass",
    timedOut: false
  };

  identify(input: { sandboxId: string; workspacePath: string }): SandboxWorkspace {
    return { containerName: `fake-${input.sandboxId}`, id: input.sandboxId, path: input.workspacePath };
  }

  async create(input: { sandboxId: string; workspacePath: string }): Promise<SandboxWorkspace> {
    if (this.createFailures > 0) {
      this.createFailures -= 1;
      throw new Error("sandbox failed");
    }
    return this.identify(input);
  }

  async execute(): Promise<ProcessResult> {
    return this.checkResult;
  }

  async teardown(): Promise<void> {
    if (this.teardownFailures > 0) {
      this.teardownFailures -= 1;
      throw new Error("teardown failed");
    }
  }
}

function finding() {
  return {
    acceptanceCriterionId: "fixture",
    architectureReference: "docs/design.md#reviewer",
    category: "correctness" as const,
    finding: "The first candidate is incomplete.",
    relevantPath: "src/value.txt",
    requiredCorrection: "Apply the bounded correction.",
    severity: "high" as const
  };
}

class ScriptedHarness implements DevelopmentHarness {
  abortFails = false;
  inputs: DevelopmentHarnessInput[] = [];
  private failedFixOnce = false;
  failFirstFix = true;
  fixNeedsHumanReason: "architecture_conflict" | undefined;
  reviewInfrastructureFailures = 0;
  skipFixWrite = false;
  reviewResults: DevelopmentReviewResult[] = [
    { decision: "REQUEST_CHANGES", findings: [finding()] },
    { decision: "APPROVE", findings: [] }
  ];

  async execute(input: DevelopmentHarnessInput) {
    this.inputs.push(input);
    const failReview = input.role === "reviewer" && this.reviewInfrastructureFailures > 0;
    if (failReview) this.reviewInfrastructureFailures -= 1;
    const review = input.role === "reviewer" && !failReview
      ? this.reviewResults.shift()
      : undefined;
    const failFix = Boolean(input.context.fix) && this.failFirstFix && !this.failedFixOnce;
    if (failFix) this.failedFixOnce = true;
    const needsHumanReason = input.context.fix ? this.fixNeedsHumanReason : undefined;
    const skipFixWrite = this.skipFixWrite;
    async function* events(): AsyncGenerator<DevelopmentEvent> {
      yield { kind: "execution_started", safeMetadata: { fresh: true } };
      if (failFix || failReview) {
        yield { failureClass: "provider", kind: "failed", safeMetadata: {} };
        return;
      }
      if (needsHumanReason) {
        yield {
          kind: "completed",
          reason: needsHumanReason,
          result: "needs_human_proposed",
          safeMetadata: {}
        };
        return;
      }
      if (input.role === "implementer" && !(input.context.fix && skipFixWrite)) {
        await input.tools.invoke("sandbox.write", {
          content: input.context.fix ? "fixed\n" : "candidate\n",
          path: "src/value.txt"
        });
      }
      yield {
        delta: { ...emptyDevelopmentUsage(), inputTokens: 2, modelInvocations: 1, outputTokens: 1 },
        kind: "usage",
        safeMetadata: {}
      };
      if (review) {
        yield { kind: "completed", result: "review_proposed", review, safeMetadata: {} };
      } else {
        yield { kind: "completed", result: "completion_proposed", safeMetadata: {} };
      }
    }
    return { events: events(), executionId: `fresh-${input.attemptId}-${this.inputs.length}` };
  }

  async abort(): Promise<void> {
    if (this.abortFails) throw new Error("abort failed");
  }
}

function setup(fixture: Awaited<ReturnType<typeof repositoryFixture>>, harness: ScriptedHarness, manager = new FakeSandboxManager()) {
  const developmentPersistence = createDevelopmentRepositories(database);
  const reviews = createReviewRepositories(database);
  const developmentCompiler = new DevelopmentContextCompiler(fixture.git);
  const development = new DevelopmentCoordinator({
    contextCompiler: developmentCompiler,
    git: fixture.git,
    harness,
    persistence: developmentPersistence,
    runnerId: "phase-2c-implementer",
    sandboxManager: manager
  });
  const reviewerCompiler = new ReviewerContextCompiler(fixture.git);
  const reviewer = new ReviewerCoordinator({
    contextCompiler: reviewerCompiler,
    developmentPersistence,
    git: fixture.git,
    harness,
    persistence: reviews,
    runnerId: "phase-2c-reviewer",
    sandboxManager: manager
  });
  const fixPersistence = createFixLoopRepositories(database);
  const fix = new FixLoopCoordinator({
    developmentPersistence,
    git: fixture.git,
    persistence: fixPersistence
  });
  return {
    development,
    developmentCompiler,
    developmentPersistence,
    fix,
    fixPersistence,
    reviewer,
    reviewerCompiler,
    reviews
  };
}

describe("Phase 2C bounded coordinator", () => {
  it("repairs one rejected candidate with fresh retries and role-pure review reconciliation", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Change src/value.txt within the immutable approved contract.",
      baseReference: fixture.base,
      title: "Bounded fix"
    });
    const initial = await system.development.runOne(implementationPolicy);
    const firstCandidate = initial!.attempt.candidateCommit!;
    const rejected = await system.reviewer.runOne(reviewPolicy, { taskId: task.id }) as { id: string };
    expect((await system.developmentPersistence.getDevelopmentTask(task.id))?.status).toBe("candidate_ready");
    await expect(system.reviews.getCurrentAuthoritativeReview(task.id, firstCandidate)).resolves.toMatchObject({ id: rejected.id });

    await expect(system.fix.reconcileOne()).resolves.toMatchObject({ task: { status: "fix_required" } });
    const fixed = await system.development.runOne(implementationPolicy, { fixOnly: true, taskId: task.id });
    expect(fixed).toMatchObject({ attempt: { fixIteration: 1, infrastructureRetryCount: 1 }, task: { status: "candidate_ready" } });
    expect(fixed!.attempt.baseCommit).toBe(firstCandidate);
    expect(execFileSync("git", ["rev-parse", `${fixed!.attempt.candidateCommit}^`], { cwd: fixture.repository, encoding: "utf8" }).trim()).toBe(firstCandidate);
    await expect(system.fixPersistence.getConsumedSourceReview(rejected.id)).resolves.toMatchObject({
      attempt: { id: fixed!.attempt.id },
      review: { id: rejected.id }
    });
    await expect(system.reviews.getCurrentAuthoritativeReview(task.id, firstCandidate)).resolves.toBeUndefined();

    harness.reviewInfrastructureFailures = 2;
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await expect(system.fix.reconcileOne()).resolves.toMatchObject({ task: { status: "approved_candidate" } });
    await expect(system.fix.reconcileOne()).resolves.toBeUndefined();
    const implementerInputs = harness.inputs.filter((input) => input.role === "implementer");
    const reviewerInputs = harness.inputs.filter((input) => input.role === "reviewer");
    expect(implementerInputs).toHaveLength(3);
    expect(implementerInputs[1]?.context.fix).toMatchObject({ sourceReviewId: rejected.id });
    expect(implementerInputs[2]?.context.fix).toMatchObject({ sourceReviewId: rejected.id });
    expect(implementerInputs[1]?.attemptId).toBe(implementerInputs[2]?.attemptId);
    expect(reviewerInputs).toHaveLength(4);
    expect(new Set(reviewerInputs.map((input) => input.attemptId)).size).toBe(2);
    expect(reviewerInputs.slice(1).every(
      (input) => input.attemptId === reviewerInputs[1]?.attemptId
    )).toBe(true);
  });

  it("fails reconciliation closed for unavailable Git authority and detects equivalent trees", async () => {
    const current = {
      attempt: {
        baseCommit: "a".repeat(40),
        candidateCommit: "b".repeat(40),
        id: "00000000-0000-4000-8000-000000000001"
      },
      review: {
        candidateCommit: "b".repeat(40),
        candidateRef: "refs/personal-agent/development-attempts/00000000-0000-4000-8000-000000000001",
        id: "00000000-0000-4000-8000-000000000002"
      },
      task: { id: "00000000-0000-4000-8000-000000000003" }
    };
    for (const unavailable of ["candidate", "retention", "mismatch"] as const) {
      const developmentPersistence = {
        blockDevelopmentCandidateIntegrity: vi.fn(async () => undefined),
        listDevelopmentAttempts: vi.fn(async () => [])
      };
      const git = {
        verifyCandidateRef: vi.fn(async () => unavailable === "candidate" ? undefined : {
          commit: current.attempt.candidateCommit,
          ref: unavailable === "mismatch" ? "refs/wrong" : current.review.candidateRef
        }),
        verifyReviewRetentionRef: vi.fn(async () => unavailable === "retention" ? undefined : {
          commit: current.review.candidateCommit,
          ref: `refs/personal-agent/reviews/${current.review.id}`
        })
      };
      const coordinator = new FixLoopCoordinator({
        developmentPersistence,
        git,
        persistence: {
          findCurrentReviewForReconciliation: vi.fn(async () => current)
        }
      } as never);
      await expect(coordinator.reconcileOne()).rejects.toThrow("Git authority");
      expect(developmentPersistence.blockDevelopmentCandidateIntegrity).toHaveBeenCalledOnce();
    }

    const reconcileCurrentReview = vi.fn(async (input) => input);
    const equivalent = new FixLoopCoordinator({
      developmentPersistence: {
        blockDevelopmentCandidateIntegrity: vi.fn(),
        listDevelopmentAttempts: vi.fn(async () => [
          current.attempt,
          { candidateCommit: "c".repeat(40), id: "older" }
        ])
      },
      git: {
        treeId: vi.fn(async () => "d".repeat(40)),
        verifyCandidateRef: vi.fn(async () => ({
          commit: current.attempt.candidateCommit,
          ref: current.review.candidateRef
        })),
        verifyReviewRetentionRef: vi.fn(async () => ({
          commit: current.review.candidateCommit,
          ref: `refs/personal-agent/reviews/${current.review.id}`
        }))
      },
      persistence: {
        findCurrentReviewForReconciliation: vi.fn(async () => current),
        reconcileCurrentReview
      }
    } as never);
    await equivalent.reconcileOne();
    expect(reconcileCurrentReview).toHaveBeenCalledWith({
      equivalentCandidate: true,
      reviewId: current.review.id
    });
  });

  it("alternates role-pure coordinators without owning durable state", async () => {
    const states = ["fix_required", "approved_candidate"];
    const fixes: string[] = [];
    const reviews: string[] = [];
    await expect(runBoundedFixLoop({
      reconcile: async () => ({ task: { id: "task", status: states.shift()! } }),
      runFix: async (taskId) => { fixes.push(taskId); },
      runReview: async (taskId) => { reviews.push(taskId); }
    })).resolves.toMatchObject({ task: { status: "approved_candidate" } });
    expect(fixes).toEqual(["task"]);
    expect(reviews).toEqual(["task"]);

    await expect(runBoundedFixLoop({
      reconcile: async () => undefined,
      runFix: async () => undefined,
      runReview: async () => undefined
    })).resolves.toBeUndefined();
    await expect(runBoundedFixLoop({
      reconcile: async () => ({ task: { id: "task", status: "candidate_ready" } }),
      runFix: async () => undefined,
      runReview: async () => undefined
    })).rejects.toThrow("invalid next state");
    await expect(runBoundedFixLoop({
      reconcile: async () => ({ task: { id: "task", status: "fix_required" } }),
      runFix: async () => undefined,
      runReview: async () => undefined
    })).rejects.toThrow("loop bound");
  });

  it("escalates a non-infrastructure fixed-candidate Reviewer failure", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Fail closed when Reviewer context is unavailable.",
      baseReference: fixture.base,
      title: "Reviewer context failure"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    await system.development.runOne(implementationPolicy, { fixOnly: true, taskId: task.id });
    vi.spyOn(system.reviewerCompiler, "compile").mockRejectedValueOnce(
      new Error("context unavailable")
    );
    await expect(system.reviewer.runOne(reviewPolicy, { taskId: task.id })).rejects.toThrow(
      "context unavailable"
    );
    await expect(system.developmentPersistence.getDevelopmentTask(task.id)).resolves.toMatchObject({
      needsHumanReason: "reviewer_failure",
      status: "needs_human"
    });
  });

  it("escalates after two failed fresh Reviewer infrastructure retries", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const manager = new FakeSandboxManager();
    const system = setup(fixture, harness, manager);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Bound Reviewer retries.",
      baseReference: fixture.base,
      title: "Reviewer retry exhaustion"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    await system.development.runOne(implementationPolicy, { fixOnly: true, taskId: task.id });
    manager.createFailures = 3;
    await expect(system.reviewer.runOne(reviewPolicy, { taskId: task.id })).rejects.toThrow(
      "Reviewer infrastructure failed"
    );
    await expect(system.developmentPersistence.getDevelopmentTask(task.id)).resolves.toMatchObject({
      needsHumanReason: "infrastructure_retry_exhausted",
      status: "needs_human"
    });
    const review = (await database.query.developmentReviews.findMany({
      where: (reviews, { eq }) => eq(reviews.taskId, task.id),
      orderBy: (reviews, { desc }) => [desc(reviews.createdAt)]
    }))[0]!;
    expect(review).toMatchObject({ infrastructureRetryCount: 2, status: "failed" });
    await expect(system.fixPersistence.getReconciledReview(task.id)).resolves.toBeUndefined();
  });

  it("fails recovered fixed-candidate review closed after two prior retries", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Exhaust recovered Reviewer retries.",
      baseReference: fixture.base,
      title: "Recovered Reviewer exhaustion"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    await system.development.runOne(implementationPolicy, { fixOnly: true, taskId: task.id });
    const review = (await system.reviews.claimCandidateReadyReview({
      budget,
      contextPolicy: {
        forbiddenPaths: reviewPolicy.forbiddenPaths,
        readablePaths: reviewPolicy.readablePaths,
        relevantPaths: reviewPolicy.relevantPaths
      },
      leaseDurationMs: 30_000,
      modelProfile: "reasoning",
      runnerId: "phase-2c-reviewer",
      taskId: task.id
    }))!.review;
    let fence = {
      leaseGeneration: review.leaseGeneration,
      reviewId: review.id,
      runnerId: "phase-2c-reviewer"
    };
    await system.reviews.saveReviewContext({
      ...fence,
      contextDigest: "7".repeat(64),
      contextManifest: {
        authorityReferences: ["docs/design.md#reviewer"],
        entries: [
          { blobId: fixture.base, bytes: 1, path: "docs/design.md", source: "authority" },
          { blobId: review.candidateCommit, bytes: 1, path: "src/value.txt", source: "repository" }
        ],
        totalBytes: 2
      },
      now: new Date()
    });
    for (let retry = 0; retry < 2; retry += 1) {
      await system.reviews.startReviewExecution({ ...fence, now: new Date() });
      await system.reviews.recordReviewFailure({ ...fence, failureClass: "provider", now: new Date() });
      await system.reviews.recordReviewCleanup({ ...fence, now: new Date(), status: "succeeded" });
      const prepared = await system.reviews.prepareReviewInfrastructureRetry({
        ...fence,
        failureClass: "provider",
        leaseDurationMs: 30_000
      });
      fence = { ...fence, leaseGeneration: prepared.leaseGeneration };
    }
    await pool.query(
      "update development_reviews set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [review.id]
    );
    await expect(system.reviewer.recoverOne(30_000)).resolves.toMatchObject({ status: "failed" });
    await expect(system.developmentPersistence.getDevelopmentTask(task.id)).resolves.toMatchObject({
      needsHumanReason: "infrastructure_retry_exhausted",
      status: "needs_human"
    });
  });

  it("reconstructs an expired fixed-candidate review with a fresh independent session", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Review a recovered correction.",
      baseReference: fixture.base,
      title: "Recovered review"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    await system.development.runOne(implementationPolicy, { fixOnly: true, taskId: task.id });
    const review = (await system.reviews.claimCandidateReadyReview({
      budget,
      contextPolicy: {
        forbiddenPaths: reviewPolicy.forbiddenPaths,
        readablePaths: reviewPolicy.readablePaths,
        relevantPaths: reviewPolicy.relevantPaths
      },
      leaseDurationMs: 30_000,
      modelProfile: "reasoning",
      runnerId: "phase-2c-reviewer",
      taskId: task.id
    }))!.review;
    await pool.query(
      "update development_reviews set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [review.id]
    );
    await expect(system.reviewer.recoverOne(30_000)).resolves.toMatchObject({
      decision: "APPROVE",
      infrastructureRetryCount: 1,
      status: "succeeded"
    });
    const recoveredInputs = harness.inputs.filter(
      (input) => input.role === "reviewer" && input.attemptId === review.id
    );
    expect(recoveredInputs).toHaveLength(1);
    await expect(system.fix.reconcileOne()).resolves.toMatchObject({
      task: { status: "approved_candidate" }
    });
  });

  it("reconstructs an expired fix attempt without Pi session state", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Recover one bounded correction.",
      baseReference: fixture.base,
      title: "Recovered fix"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    const claimed = (await system.developmentPersistence.claimFixRequiredDevelopmentTask({
      budget,
      contextPolicy: {
        allowedPaths: implementationPolicy.allowedPaths,
        forbiddenPaths: implementationPolicy.forbiddenPaths,
        relevantPaths: implementationPolicy.relevantPaths
      },
      leaseDurationMs: 30_000,
      modelProfile: "balanced",
      runnerId: "phase-2c-implementer",
      taskId: task.id
    }))!;
    await pool.query(
      "update development_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [claimed.attempt.id]
    );
    await expect(system.development.recoverOne(30_000)).resolves.toMatchObject({
      attempt: { candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/), fixIteration: 1 },
      task: { status: "candidate_ready" }
    });
    expect(harness.inputs.at(-1)?.context.fix).toMatchObject({
      sourceReviewId: claimed.sourceReview.id
    });
  });

  it("bounds an unknown trusted Git capture infrastructure failure", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Capture one exact correction.",
      baseReference: fixture.base,
      title: "Git capture failure"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    vi.spyOn(fixture.git, "captureCandidate")
      .mockRejectedValueOnce(new Error("Git unavailable"))
      .mockRejectedValue("Git unavailable");
    await expect(system.development.runOne(
      implementationPolicy,
      { fixOnly: true, taskId: task.id }
    )).resolves.toMatchObject({
      attempt: { infrastructureRetryCount: 2, status: "failed" },
      task: { needsHumanReason: "infrastructure_retry_exhausted", status: "needs_human" }
    });
  });

  it("escalates a no-delta fix as deterministic non-convergence", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const { relevantPath: omittedPath, ...pathlessFinding } = finding();
    expect(omittedPath).toBe("src/value.txt");
    harness.reviewResults[0] = {
      decision: "REQUEST_CHANGES",
      findings: [pathlessFinding]
    };
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Require a meaningful correction.",
      baseReference: fixture.base,
      title: "No delta"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    harness.skipFixWrite = true;
    await expect(system.development.runOne(
      implementationPolicy,
      { fixOnly: true, taskId: task.id }
    )).resolves.toMatchObject({
      attempt: { fixIteration: 1, status: "failed" },
      task: { needsHumanReason: "non_convergence", status: "needs_human" }
    });
  });

  it("escalates fix context and per-execution budget failures without another attempt", async () => {
    for (const mode of ["context", "budget"] as const) {
      const fixture = await repositoryFixture();
      const harness = new ScriptedHarness();
      harness.failFirstFix = false;
      const system = setup(fixture, harness);
      const task = await system.development.createApprovedTask({
        acceptanceCriteria: criteria,
        approvedSpec: `Bound ${mode} failure.`,
        baseReference: fixture.base,
        title: `Fix ${mode}`
      });
      await system.development.runOne(implementationPolicy, { taskId: task.id });
      await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
      await system.fix.reconcileOne();
      if (mode === "context") {
        const compile = system.developmentCompiler.compile.bind(system.developmentCompiler);
        vi.spyOn(system.developmentCompiler, "compile").mockImplementation(async (input) => {
          if (input.fix) throw new z.ZodError([]);
          return compile(input);
        });
      } else {
        const execute = harness.execute.bind(harness);
        harness.execute = async (input) => input.context.fix
          ? {
              executionId: `budget-${input.attemptId}`,
              events: (async function* (): AsyncGenerator<DevelopmentEvent> {
                yield {
                  delta: {
                    ...emptyDevelopmentUsage(),
                    modelInvocations: budget.maxModelInvocations + 1
                  },
                  kind: "usage",
                  safeMetadata: {}
                };
              })()
            }
          : execute(input);
      }
      await expect(system.development.runOne(
        implementationPolicy,
        { fixOnly: true, taskId: task.id }
      )).resolves.toMatchObject({
        attempt: { fixIteration: 1, status: "failed" },
        task: {
          needsHumanReason: mode === "context"
            ? "context_unavailable"
            : "execution_budget_exhausted",
          status: "needs_human"
        }
      });
    }
  });

  it("does not retry into a workspace whose cleanup failed", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    harness.failFirstFix = false;
    const manager = new FakeSandboxManager();
    const system = setup(fixture, harness, manager);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Require clean infrastructure retry state.",
      baseReference: fixture.base,
      title: "Cleanup failure"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    manager.createFailures = 1;
    manager.teardownFailures = 1;
    await expect(system.development.runOne(
      implementationPolicy,
      { fixOnly: true, taskId: task.id }
    )).resolves.toMatchObject({
      attempt: { infrastructureRetryCount: 0, status: "failed" },
      task: { needsHumanReason: "durable_integrity_failure", status: "needs_human" }
    });
  });

  it("escalates after two failed fresh Implementer infrastructure retries", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    const originalExecute = harness.execute.bind(harness);
    let fixFailures = 3;
    harness.execute = async (input) => {
      if (input.context.fix && fixFailures-- > 0) {
        const malformed = fixFailures === 2;
        return {
          executionId: `failed-${input.attemptId}-${fixFailures}`,
          events: (async function* (): AsyncGenerator<DevelopmentEvent> {
            if (malformed) {
              yield {
                kind: "completed",
                result: "review_proposed",
                review: { decision: "APPROVE", findings: [] },
                safeMetadata: {}
              };
            } else {
              yield { failureClass: "provider", kind: "failed", safeMetadata: {} };
            }
          })()
        };
      }
      return originalExecute(input);
    };
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Bound Implementer retries.",
      baseReference: fixture.base,
      title: "Implementer retry exhaustion"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    harness.abortFails = true;
    await expect(system.development.runOne(
      implementationPolicy,
      { fixOnly: true }
    )).resolves.toMatchObject({
      attempt: { infrastructureRetryCount: 2, status: "failed" },
      task: { needsHumanReason: "infrastructure_retry_exhausted", status: "needs_human" }
    });
  });

  it("fails expired fix recovery closed when durable context or retry authority is exhausted", async () => {
    for (const mode of ["context", "retries"] as const) {
      const fixture = await repositoryFixture();
      const harness = new ScriptedHarness();
      harness.failFirstFix = false;
      const system = setup(fixture, harness);
      const task = await system.development.createApprovedTask({
        acceptanceCriteria: criteria,
        approvedSpec: `Fail closed for ${mode}.`,
        baseReference: fixture.base,
        title: `Recovery ${mode}`
      });
      await system.development.runOne(implementationPolicy, { taskId: task.id });
      await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
      await system.fix.reconcileOne();
      let attempt = (await system.developmentPersistence.claimFixRequiredDevelopmentTask({
        budget,
        contextPolicy: {
          allowedPaths: implementationPolicy.allowedPaths,
          forbiddenPaths: implementationPolicy.forbiddenPaths,
          relevantPaths: implementationPolicy.relevantPaths
        },
        leaseDurationMs: 30_000,
        modelProfile: "balanced",
        runnerId: "phase-2c-implementer",
        taskId: task.id
      }))!.attempt;
      if (mode === "context") {
        vi.spyOn(system.developmentPersistence, "getConsumedFixAttemptInput").mockResolvedValueOnce(
          undefined
        );
      } else {
        for (let retry = 0; retry < 2; retry += 1) {
          const updated = await system.developmentPersistence.prepareDevelopmentInfrastructureRetry({
            attemptId: attempt.id,
            failureClass: "provider",
            leaseDurationMs: 30_000,
            leaseGeneration: attempt.leaseGeneration,
            runnerId: "phase-2c-implementer"
          });
          attempt = updated.attempt;
        }
      }
      await pool.query(
        "update development_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
        [attempt.id]
      );
      await expect(system.development.recoverOne(30_000)).resolves.toMatchObject({
        task: {
          needsHumanReason: mode === "context"
            ? "context_unavailable"
            : "infrastructure_retry_exhausted",
          status: "needs_human"
        }
      });
    }
  });

  it("accepts only a stop-only semantic authority-conflict proposal", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    const system = setup(fixture, harness);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Apply one bounded correction.",
      baseReference: fixture.base,
      title: "Authority conflict"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    harness.fixNeedsHumanReason = "architecture_conflict";
    await expect(system.development.runOne(
      implementationPolicy,
      { fixOnly: true, taskId: task.id }
    )).resolves.toMatchObject({
      attempt: { fixIteration: 1, status: "failed" },
      task: { needsHumanReason: "architecture_conflict", status: "needs_human" }
    });
  });

  it("escalates a final deterministic fix check failure without another semantic attempt", async () => {
    const fixture = await repositoryFixture();
    const harness = new ScriptedHarness();
    const manager = new FakeSandboxManager();
    const system = setup(fixture, harness, manager);
    const task = await system.development.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Apply one bounded correction.",
      baseReference: fixture.base,
      title: "Deterministic failure"
    });
    await system.development.runOne(implementationPolicy, { taskId: task.id });
    await system.reviewer.runOne(reviewPolicy, { taskId: task.id });
    await system.fix.reconcileOne();
    manager.createFailures = 1;
    manager.checkResult = { ...manager.checkResult, exitCode: 1, stderr: "failed" };
    const result = await system.development.runOne(implementationPolicy, { fixOnly: true, taskId: task.id });
    expect(result).toMatchObject({
      attempt: { fixIteration: 1, status: "failed" },
      task: { needsHumanReason: "deterministic_test_failure", status: "needs_human" }
    });
    expect((await system.developmentPersistence.listDevelopmentAttempts(task.id)).filter((attempt) => attempt.fixIteration)).toHaveLength(1);
  });
});
