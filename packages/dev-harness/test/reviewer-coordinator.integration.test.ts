import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DevelopmentLeaseError,
  createDatabase,
  createDevelopmentRepositories,
  createReviewRepositories,
  migrateDatabase,
  type Database
} from "@personal-agent/db";
import { emptyDevelopmentUsage, type DevelopmentReviewResult } from "@personal-agent/shared";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DevelopmentEvent, DevelopmentHarness, DevelopmentHarnessInput } from "../src/contract";
import { TrustedGit } from "../src/git";
import type { ProcessResult } from "../src/process";
import { ReviewerContextCompiler } from "../src/reviewer-context-compiler";
import { ReviewerCoordinator, type ReviewerRunPolicy } from "../src/reviewer-coordinator";
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
  maxModelInvocations: 3,
  maxTokens: 10_000,
  maxToolCalls: 20,
  maxWallClockMs: 60_000,
  maxWorkspaceBytes: 100_000_000
};
const criteria = [{
  check: { arguments: ["-e", "process.exit(0)"], executable: "node" as const, timeoutMs: 1_000 },
  description: "Fixture check passes",
  id: "fixture"
}];
const policy: ReviewerRunPolicy = {
  budget,
  forbiddenPaths: [".git", ".pi"],
  leaseDurationMs: 30_000,
  modelProfile: "reasoning",
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
  const repository = await mkdtemp(join(tmpdir(), "personal-agent-reviewer-"));
  const workspaces = `${repository}-workspaces`;
  cleanup.push(repository, workspaces);
  await mkdir(join(repository, "docs/decisions"), { recursive: true });
  await mkdir(join(repository, "src"));
  await Promise.all([
    writeFile(join(repository, "AGENTS.md"), "trusted bounded policy\n"),
    writeFile(join(repository, "docs/design.md"), "# Design\n\n## Reviewer\nIndependent and read-only.\n"),
    writeFile(join(repository, "docs/decisions/0001-pi-development-harness.md"), "trusted harness boundary\n"),
    writeFile(join(repository, "docs/phase-2-implementation-plan.md"), "Phase 2B only; no merge or deploy.\n"),
    writeFile(join(repository, "src/value.txt"), "base\n")
  ]);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "base"], { cwd: repository });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  return { base, git: new TrustedGit(repository, workspaces, ["REVIEWER_CANARY"]), repository };
}

async function candidateReady(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  options: { testEvidence?: boolean; teardownEvidence?: boolean } = {}
) {
  const persistence = createDevelopmentRepositories(database, ["REVIEWER_CANARY"]);
  const now = new Date();
  const task = await persistence.createApprovedDevelopmentTask({
    acceptanceCriteria: criteria,
    approvedAt: now,
    approvedSpec: "Change src/value.txt from base to candidate and preserve the fixture check.",
    baseCommit: fixture.base,
    title: "Independent review fixture"
  });
  const claim = (await persistence.claimReadyDevelopmentTask({
    budget,
    leaseDurationMs: 60_000,
    modelProfile: "balanced",
    now,
    runnerId: `implementer-${task.id}`
  }))!;
  const fence = { attemptId: claim.attempt.id, leaseGeneration: 1, runnerId: `implementer-${task.id}` };
  await persistence.saveDevelopmentContext({
    ...fence,
    contextDigest: "a".repeat(64),
    contextManifest: { entries: [], totalBytes: 0 },
    now: new Date()
  });
  await persistence.transitionDevelopmentAttempt({ ...fence, attemptStatus: "implementing", now: new Date(), taskStatus: "implementing" });
  await persistence.transitionDevelopmentAttempt({ ...fence, attemptStatus: "testing", now: new Date(), taskStatus: "testing" });
  if (options.testEvidence !== false) {
    await persistence.appendDevelopmentAttemptEvent({
      ...fence,
      kind: "test",
      now: new Date(),
      safeMetadata: { criterion_id: "fixture", duration_ms: 5, exit_code: 0 },
      status: "success"
    });
  }
  await persistence.transitionDevelopmentAttempt({ ...fence, attemptStatus: "capturing_candidate", now: new Date(), taskStatus: "testing" });
  const workspace = await fixture.git.createWorktree(claim.attempt.id, fixture.base);
  await writeFile(join(workspace, "src/value.txt"), "candidate\n");
  const candidate = await fixture.git.captureCandidate({
    allowedPaths: ["src"],
    attemptId: claim.attempt.id,
    baseCommit: fixture.base,
    forbiddenPaths: [],
    maxDiffBytes: budget.maxDiffBytes,
    workspacePath: workspace
  });
  await persistence.recordDevelopmentCandidate({
    ...fence,
    candidateCommit: candidate.commit,
    candidateRef: candidate.ref,
    now: new Date(),
    safeSummary: "IMPLEMENTER_SELF_ASSESSMENT_MUST_NOT_REACH_REVIEWER"
  });
  await fixture.git.removeWorktree(workspace);
  if (options.teardownEvidence !== false) {
    await persistence.appendDevelopmentAttemptEvent({
      ...fence,
      kind: "teardown",
      now: new Date(),
      safeMetadata: { sandbox_id: claim.attempt.sandboxId },
      status: "success"
    });
  }
  return { attempt: claim.attempt, candidate, persistence, task };
}

class FakeSandboxManager implements SandboxManager {
  teardownFailures = 0;
  executeMutation = false;
  executions = 0;
  teardowns = 0;

  identify(input: { sandboxId: string; workspacePath: string }): SandboxWorkspace {
    return { containerName: `fake-${input.sandboxId}`, id: input.sandboxId, path: input.workspacePath };
  }

  async create(input: { sandboxId: string; workspacePath: string }): Promise<SandboxWorkspace> {
    return this.identify(input);
  }

  async execute(workspace: SandboxWorkspace): Promise<ProcessResult> {
    this.executions += 1;
    if (this.executeMutation) await writeFile(join(workspace.path, "src/value.txt"), "mutated by check\n");
    return { durationMs: 2, exitCode: 0, outputLimitExceeded: false, stderr: "", stdout: "check passed", timedOut: false };
  }

  async teardown(): Promise<void> {
    this.teardowns += 1;
    if (this.teardownFailures > 0) {
      this.teardownFailures -= 1;
      throw new Error("cleanup failed");
    }
  }
}

class FakeReviewerHarness implements DevelopmentHarness {
  executions: DevelopmentHarnessInput[] = [];
  aborts: string[] = [];

  constructor(
    private readonly result: DevelopmentReviewResult | "malformed" | "provider" | "timeout" = { decision: "APPROVE", findings: [] },
    private readonly inspect?: (input: DevelopmentHarnessInput) => Promise<void>
  ) {}

  async execute(input: DevelopmentHarnessInput) {
    this.executions.push(input);
    const result = this.result;
    const inspect = this.inspect;
    async function* stream(): AsyncGenerator<DevelopmentEvent> {
      yield { kind: "execution_started", safeMetadata: { fresh: true } };
      await inspect?.(input);
      if (result === "provider" || result === "timeout") {
        yield { failureClass: result, kind: "failed", safeMetadata: {} };
        return;
      }
      yield { delta: { ...emptyDevelopmentUsage(), inputTokens: 10, modelInvocations: 1, outputTokens: 5 }, kind: "usage", safeMetadata: {} };
      if (result === "malformed") {
        yield { kind: "completed", result: "completion_proposed", safeMetadata: {} };
      } else {
        yield { kind: "completed", result: "review_proposed", review: result, safeMetadata: {} };
      }
    }
    return { events: stream(), executionId: `fresh-review-${input.attemptId}-${this.executions.length}` };
  }

  async abort(executionId: string): Promise<void> {
    this.aborts.push(executionId);
  }
}

function finding() {
  return {
    acceptanceCriterionId: "fixture",
    architectureReference: "docs/design.md#reviewer",
    category: "correctness" as const,
    finding: "The candidate behavior is incomplete.",
    relevantPath: "src/value.txt",
    requiredCorrection: "Implement the complete approved behavior.",
    severity: "high" as const
  };
}

function setup(input: {
  fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  harness?: FakeReviewerHarness;
  manager?: FakeSandboxManager;
  repositoryHooks?: Parameters<typeof createReviewRepositories>[2];
  runnerId?: string;
}) {
  const manager = input.manager ?? new FakeSandboxManager();
  const harness = input.harness ?? new FakeReviewerHarness();
  const persistence = createReviewRepositories(
    database,
    ["REVIEWER_CANARY"],
    input.repositoryHooks
  );
  const developmentPersistence = createDevelopmentRepositories(database, ["REVIEWER_CANARY"]);
  const contextCompiler = new ReviewerContextCompiler(input.fixture.git);
  const coordinator = new ReviewerCoordinator({
    contextCompiler,
    developmentPersistence,
    git: input.fixture.git,
    harness,
    knownSecrets: ["REVIEWER_CANARY"],
    persistence,
    runnerId: input.runnerId ?? "reviewer-runner",
    sandboxManager: manager
  });
  return { contextCompiler, coordinator, developmentPersistence, harness, manager, persistence };
}

describe("Phase 2B independent Reviewer coordinator", () => {
  it("runs one fresh independent read-only Reviewer and finalizes exact-candidate APPROVE", async () => {
    const fixture = await repositoryFixture();
    const candidate = await candidateReady(fixture);
    const originalHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.repository, encoding: "utf8" }).trim();
    const harness = new FakeReviewerHarness({ decision: "APPROVE", findings: [] }, async (input) => {
      expect(input.role).toBe("reviewer");
      expect(input.context.candidateCommit).toBe(candidate.candidate.commit);
      expect(input.context.candidateDiff).toContain("candidate");
      expect(input.context.deterministicEvidence).toContain("fixture");
      expect(JSON.stringify(input.context)).not.toContain("IMPLEMENTER_SELF_ASSESSMENT");
      expect(input.tools.names).not.toContain("sandbox.write");
      expect(input.tools.names).not.toContain("sandbox.edit");
      expect(input.tools.names).not.toContain("sandbox.exec");
      await expect(input.tools.invoke("sandbox.write", { path: "src/value.txt", content: "bad" })).rejects.toThrow("not granted");
      await expect(input.tools.invoke("sandbox.exec", { executable: "node", arguments: [] })).rejects.toThrow("not granted");
      await input.tools.invoke("sandbox.read", { path: "src/value.txt" });
      await input.tools.invoke("review.run_check", { acceptanceCriterionId: "fixture" });
      await expect(input.tools.invoke("review.run_check", { acceptanceCriterionId: "not-approved" })).rejects.toThrow("unapproved");
    });
    const review = setup({ fixture, harness });
    const result = await review.coordinator.runOne(policy);
    expect(result).toMatchObject({ candidateCommit: candidate.candidate.commit, decision: "APPROVE", findings: [], status: "succeeded" });
    expect(harness.executions).toHaveLength(1);
    expect(harness.aborts).toHaveLength(1);
    expect(review.manager.executions).toBe(1);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.repository, encoding: "utf8" }).trim()).toBe(originalHead);
    expect(execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/personal-agent"], { cwd: fixture.repository, encoding: "utf8" })).toContain(candidate.candidate.ref);
    await expect(review.coordinator.runOne(policy)).resolves.toBeUndefined();
  });

  it("durably returns REQUEST_CHANGES without starting a fix, merge, or deployment", async () => {
    const fixture = await repositoryFixture();
    await candidateReady(fixture);
    const harness = new FakeReviewerHarness({ decision: "REQUEST_CHANGES", findings: [finding()] });
    const review = setup({ fixture, harness });
    const result = await review.coordinator.runOne(policy);
    expect(result).toMatchObject({ decision: "REQUEST_CHANGES", findings: [finding()], status: "succeeded" });
    expect(harness.executions).toHaveLength(1);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: fixture.repository, encoding: "utf8" }).trim()).toBe("master");
  });

  it("fails closed for malformed output, provider failure, budget exhaustion, and missing evidence", async () => {
    for (const behavior of ["malformed", "provider", "timeout"] as const) {
      const fixture = await repositoryFixture();
      await candidateReady(fixture);
      const review = setup({ fixture, harness: new FakeReviewerHarness(behavior), runnerId: `failure-${behavior}` });
      await expect(review.coordinator.runOne(policy)).rejects.toBeDefined();
      const rows = await database.query.developmentReviews.findMany();
      expect(rows.at(-1)?.status).toBe("failed");
    }

    const budgetFixture = await repositoryFixture();
    await candidateReady(budgetFixture);
    const budgetHarness = new FakeReviewerHarness({ decision: "APPROVE", findings: [] }, async (input) => {
      await input.tools.invoke("review.run_check", { acceptanceCriterionId: "fixture" });
    });
    const budgetReview = setup({ fixture: budgetFixture, harness: budgetHarness, runnerId: "budget-failure" });
    await expect(budgetReview.coordinator.runOne({ ...policy, budget: { ...budget, maxWallClockMs: 1 } })).rejects.toBeDefined();

    const missingTest = await repositoryFixture();
    await candidateReady(missingTest, { testEvidence: false });
    const missingTestReview = setup({ fixture: missingTest, runnerId: "missing-test" });
    await expect(missingTestReview.coordinator.runOne(policy)).rejects.toThrow(/missing/i);
    expect(missingTestReview.harness.executions).toHaveLength(0);

    const missingTeardown = await repositoryFixture();
    await candidateReady(missingTeardown, { teardownEvidence: false });
    const missingTeardownReview = setup({ fixture: missingTeardown, runnerId: "missing-teardown" });
    await expect(missingTeardownReview.coordinator.runOne(policy)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("detects approved-command candidate mutation and a changed trusted candidate ref", async () => {
    const absentRefFixture = await repositoryFixture();
    await candidateReady(absentRefFixture);
    const absentRef = setup({ fixture: absentRefFixture, runnerId: "absent-ref-reviewer" });
    vi.spyOn(absentRefFixture.git, "verifyCandidateRef").mockResolvedValueOnce(undefined);
    await expect(absentRef.coordinator.runOne(policy)).rejects.toThrow("integrity");

    const mutationFixture = await repositoryFixture();
    await candidateReady(mutationFixture);
    const manager = new FakeSandboxManager();
    manager.executeMutation = true;
    const mutationHarness = new FakeReviewerHarness({ decision: "APPROVE", findings: [] }, async (input) => {
      await input.tools.invoke("review.run_check", { acceptanceCriterionId: "fixture" });
    });
    const mutation = setup({ fixture: mutationFixture, harness: mutationHarness, manager, runnerId: "mutation-reviewer" });
    await expect(mutation.coordinator.runOne(policy)).rejects.toThrow("mutated");

    const refFixture = await repositoryFixture();
    const candidate = await candidateReady(refFixture);
    const refHarness = new FakeReviewerHarness({ decision: "APPROVE", findings: [] }, async () => {
      execFileSync("git", ["update-ref", candidate.candidate.ref, refFixture.base], { cwd: refFixture.repository });
    });
    const changed = setup({ fixture: refFixture, harness: refHarness, runnerId: "changed-ref-reviewer" });
    vi.spyOn(changed.developmentPersistence, "blockDevelopmentCandidateIntegrity").mockRejectedValueOnce(new Error("competing block"));
    await expect(changed.coordinator.runOne(policy)).rejects.toThrow("integrity");
    await expect(candidate.persistence.getDevelopmentTask(candidate.task.id)).resolves.toMatchObject({ status: "candidate_ready" });
  });

  it("retries cleanup after restart without resuming or invoking another Reviewer", async () => {
    const fixture = await repositoryFixture();
    const candidate = await candidateReady(fixture);
    const manager = new FakeSandboxManager();
    manager.teardownFailures = 1;
    const harness = new FakeReviewerHarness();
    const first = setup({ fixture, harness, manager, runnerId: "cleanup-first" });
    await expect(first.coordinator.runOne(policy)).rejects.toThrow("cleanup failed");
    expect(harness.executions).toHaveLength(1);
    const pending = await database.query.developmentReviews.findFirst({
      where: (reviews, { eq }) => eq(reviews.taskId, candidate.task.id)
    });
    expect(pending).toMatchObject({ cleanupStatus: "failed", decision: "APPROVE", status: "finalizing" });

    const recovered = setup({ fixture, harness, manager, runnerId: "cleanup-recovery" });
    const result = await recovered.coordinator.recoverOne(policy.leaseDurationMs);
    expect(result).toMatchObject({ cleanupStatus: "succeeded", decision: "APPROVE", status: "succeeded" });
    expect(harness.executions).toHaveLength(1);
    expect(manager.teardowns).toBe(2);
  });

  it("fails reconstructed recovery closed when the exact retained Git candidate is unavailable", async () => {
    const fixture = await repositoryFixture();
    const candidate = await candidateReady(fixture);
    const manager = new FakeSandboxManager();
    manager.teardownFailures = 1;
    const harness = new FakeReviewerHarness();
    const initial = setup({ fixture, harness, manager, runnerId: "lost-retention-initial" });
    await expect(initial.coordinator.runOne(policy)).rejects.toThrow("cleanup failed");
    const pending = (await database.query.developmentReviews.findFirst({
      where: (reviews, { eq }) => eq(reviews.taskId, candidate.task.id)
    }))!;
    await fixture.git.removeWorktree(fixture.git.workspacePath(pending.id));
    execFileSync("git", ["update-ref", "-d", pending.retentionRef], { cwd: fixture.repository });
    execFileSync("git", ["update-ref", "-d", candidate.candidate.ref], { cwd: fixture.repository });
    execFileSync("git", ["reflog", "expire", "--expire=now", "--all"], {
      cwd: fixture.repository
    });
    execFileSync("git", ["gc", "--prune=now"], { cwd: fixture.repository });

    const recovered = setup({ fixture, harness, manager, runnerId: "lost-retention-recovery" });
    await expect(recovered.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toMatchObject({
      failureClass: "candidate_unavailable",
      status: "failed"
    });
    expect(harness.executions).toHaveLength(1);
    await expect(
      recovered.persistence.getAuthoritativeReview(candidate.task.id, candidate.candidate.commit)
    ).resolves.toBeUndefined();

    const mismatchFixture = await repositoryFixture();
    const mismatchCandidate = await candidateReady(mismatchFixture);
    const mismatchManager = new FakeSandboxManager();
    mismatchManager.teardownFailures = 1;
    const mismatchInitial = setup({
      fixture: mismatchFixture,
      manager: mismatchManager,
      runnerId: "retention-mismatch-initial"
    });
    await expect(mismatchInitial.coordinator.runOne(policy)).rejects.toThrow("cleanup failed");
    const mismatchRecovery = setup({
      fixture: mismatchFixture,
      manager: mismatchManager,
      runnerId: "retention-mismatch-recovery"
    });
    vi.spyOn(mismatchFixture.git, "ensureReviewRetentionRef").mockResolvedValueOnce({
      commit: mismatchCandidate.candidate.commit,
      ref: "refs/personal-agent/reviews/wrong"
    });
    await expect(mismatchRecovery.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toMatchObject({
      failureClass: "candidate_unavailable",
      status: "failed"
    });
  });

  it("recovers invalidated reviews as failure-only cleanup and preserves queue progress", async () => {
    const fixture = await repositoryFixture();
    const first = await candidateReady(fixture);
    const second = await candidateReady(fixture);
    const reviews = createReviewRepositories(database);
    const claim = async (taskId: string, runnerId: string) => {
      const result = (await reviews.claimCandidateReadyReview({
        budget,
        contextPolicy: { forbiddenPaths: policy.forbiddenPaths, readablePaths: policy.readablePaths, relevantPaths: policy.relevantPaths },
        leaseDurationMs: policy.leaseDurationMs,
        modelProfile: policy.modelProfile,
        runnerId,
        taskId
      }))!;
      await fixture.git.createWorktree(result.review.id, result.review.candidateCommit);
      return result;
    };
    const reviewA = await claim(first.task.id, "invalidated-a");
    const reviewB = await claim(second.task.id, "recoverable-b");
    await first.persistence.blockDevelopmentCandidateIntegrity({ attemptId: first.attempt.id, now: new Date() });
    await pool.query("update development_reviews set lease_expires_at = clock_timestamp() - interval '2 seconds' where id = $1", [reviewA.review.id]);
    await pool.query("update development_reviews set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [reviewB.review.id]);

    const harness: DevelopmentHarness = { abort: vi.fn(async () => undefined), execute: vi.fn() };
    const recovery = setup({ fixture, harness, manager: new FakeSandboxManager(), runnerId: "recovery" });
    await expect(recovery.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toMatchObject({ status: "failed" });
    await expect(recovery.persistence.getReview(reviewA.review.id)).resolves.toMatchObject({
      failureClass: "authority_invalidated",
      status: "failed"
    });
    await expect(first.persistence.getDevelopmentTask(first.task.id)).resolves.toMatchObject({
      status: "blocked",
      authorityInvalidatedAt: expect.any(Date)
    });
    expect(harness.execute).not.toHaveBeenCalled();

    await expect(recovery.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toMatchObject({ status: "failed" });
    await expect(recovery.persistence.getReview(reviewB.review.id)).resolves.toMatchObject({ status: "failed" });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("invalidated finalizing proposals cannot become authoritative after recovery", async () => {
    const fixture = await repositoryFixture();
    const candidate = await candidateReady(fixture);
    const manager = new FakeSandboxManager();
    manager.teardownFailures = 1;
    const harness = new FakeReviewerHarness({ decision: "APPROVE", findings: [] });
    const initial = setup({ fixture, harness, manager, runnerId: "invalidated-finalizing" });
    await expect(initial.coordinator.runOne(policy)).rejects.toThrow("cleanup failed");
    const pending = (await initial.persistence.getReview(
      (await database.query.developmentReviews.findFirst({ where: (reviews, { eq }) => eq(reviews.taskId, candidate.task.id) }))!.id
    ))!;
    await candidate.persistence.blockDevelopmentCandidateIntegrity({ attemptId: candidate.attempt.id, now: new Date() });
    await pool.query("update development_reviews set cleanup_status = 'succeeded', lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [pending.id]);
    const recovery = setup({ fixture, harness, manager, runnerId: "invalidated-finalizing-recovery" });
    await expect(recovery.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toMatchObject({ status: "failed" });
    await expect(recovery.persistence.getReview(pending.id)).resolves.toMatchObject({
      decision: "APPROVE",
      failureClass: "authority_invalidated",
      status: "failed"
    });
    await expect(recovery.persistence.getAuthoritativeReview(candidate.task.id, candidate.candidate.commit)).resolves.toBeUndefined();
    expect(harness.executions).toHaveLength(1);
  });

  it("recovers a durably cleaned finalizing review exactly once without policy/session memory", async () => {
    const fixture = await repositoryFixture();
    const candidate = await candidateReady(fixture);
    const manager = new FakeSandboxManager();
    const harness = new FakeReviewerHarness();
    const crashed = setup({ fixture, harness, manager, runnerId: "post-cleanup-crash" });
    vi.spyOn(crashed.persistence, "finalizeReview").mockRejectedValueOnce(
      new DevelopmentLeaseError("simulated crash before finalization commit")
    );
    await expect(crashed.coordinator.runOne(policy)).rejects.toBeInstanceOf(DevelopmentLeaseError);
    const pending = await crashed.persistence.getReview(
      (await database.query.developmentReviews.findFirst({
        where: (reviews, { eq }) => eq(reviews.taskId, candidate.task.id)
      }))!.id
    );
    expect(pending).toMatchObject({
      cleanupStatus: "succeeded",
      decision: "APPROVE",
      status: "finalizing"
    });
    await pool.query("update development_reviews set lease_expires_at = now() - interval '1 second' where id = $1", [pending!.id]);

    const recoveredHarness = new FakeReviewerHarness();
    let enteredReclamation!: () => void;
    let releaseReclamation!: () => void;
    const reclamationEntered = new Promise<void>((resolve) => {
      enteredReclamation = resolve;
    });
    const reclamationRelease = new Promise<void>((resolve) => {
      releaseReclamation = resolve;
    });
    const recoveredA = setup({
      fixture,
      harness: recoveredHarness,
      manager,
      repositoryHooks: {
        afterReclaimLock: async () => {
          enteredReclamation();
          await reclamationRelease;
        }
      },
      runnerId: "post-cleanup-recovery-a"
    });
    const recoveredB = setup({
      fixture,
      harness: recoveredHarness,
      manager,
      runnerId: "post-cleanup-recovery-b"
    });
    const recoveringA = recoveredA.coordinator.recoverOne(policy.leaseDurationMs);
    await reclamationEntered;
    await expect(recoveredB.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toBeUndefined();
    releaseReclamation();
    await expect(recoveringA).resolves.toMatchObject({ status: "succeeded" });
    expect(manager.teardowns).toBe(1);
    expect(recoveredHarness.executions).toHaveLength(0);
    const events = await recoveredA.persistence.listReviewEvents(pending!.id);
    expect(events.filter((event) => event.kind === "finalization" && event.status === "success")).toHaveLength(1);
    await pool.query("update development_reviews set lease_expires_at = now() - interval '1 second' where id = $1", [pending!.id]);
    await expect(recoveredA.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toBeUndefined();
  });

  it("binds finalization to immutable candidate provenance without a mutable-ref TOCTOU", async () => {
    const fixture = await repositoryFixture();
    const candidate = await candidateReady(fixture);
    const review = setup({ fixture, runnerId: "final-ref-race" });
    const finalize = review.persistence.finalizeReview.bind(review.persistence);
    vi.spyOn(review.persistence, "finalizeReview").mockImplementationOnce(async (input) => {
      execFileSync("git", ["update-ref", "-d", candidate.candidate.ref], {
        cwd: fixture.repository
      });
      execFileSync("git", ["reflog", "expire", "--expire=now", "--all"], {
        cwd: fixture.repository
      });
      execFileSync("git", ["gc", "--prune=now"], { cwd: fixture.repository });
      return finalize(input);
    });
    const result = await review.coordinator.runOne(policy);
    expect(result).toMatchObject({
      candidateCommit: candidate.candidate.commit,
      retentionRef: `refs/personal-agent/reviews/${result!.id}`,
      status: "succeeded"
    });
    await expect(fixture.git.resolveCommit(candidate.candidate.commit)).resolves.toBe(
      candidate.candidate.commit
    );
    await expect(
      review.persistence.getAuthoritativeReview(candidate.task.id, candidate.candidate.commit)
    ).resolves.toMatchObject({ candidateCommit: candidate.candidate.commit, status: "succeeded" });
    await expect(
      review.persistence.getAuthoritativeReview(candidate.task.id, fixture.base)
    ).resolves.toBeUndefined();
    execFileSync("git", ["update-ref", result!.retentionRef, fixture.base], {
      cwd: fixture.repository
    });
    await expect(
      fixture.git.verifyReviewRetentionRef(result!.id, candidate.candidate.commit)
    ).rejects.toThrow("does not match");
    await expect(
      review.persistence.getAuthoritativeReview(candidate.task.id, fixture.base)
    ).resolves.toBeUndefined();
  });

  it("forces a finalizer and recoverer to contend at the authoritative review-row lock", async () => {
    const fixture = await repositoryFixture();
    const candidate = await candidateReady(fixture);
    let enteredFinalization!: () => void;
    let releaseFinalization!: () => void;
    const finalizationEntered = new Promise<void>((resolve) => {
      enteredFinalization = resolve;
    });
    const finalizationRelease = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    const finalizer = setup({
      fixture,
      repositoryHooks: {
        afterFinalizeLock: async () => {
          enteredFinalization();
          await finalizationRelease;
        }
      },
      runnerId: "locking-finalizer"
    });
    const shortLeasePolicy = { ...policy, leaseDurationMs: 500 };
    const finalizing = finalizer.coordinator.runOne(shortLeasePolicy);
    await finalizationEntered;
    await new Promise((resolve) => setTimeout(resolve, 600));

    const recovery = setup({ fixture, runnerId: "locked-row-recoverer" });
    await expect(recovery.coordinator.recoverOne(shortLeasePolicy.leaseDurationMs)).resolves.toBeUndefined();
    releaseFinalization();
    await expect(finalizing).resolves.toMatchObject({
      candidateCommit: candidate.candidate.commit,
      status: "succeeded"
    });
    const row = (await database.query.developmentReviews.findFirst({
      where: (reviews, { eq }) => eq(reviews.taskId, candidate.task.id)
    }))!;
    const events = await recovery.persistence.listReviewEvents(row.id);
    expect(events.filter((event) => event.kind === "finalization" && event.status === "success")).toHaveLength(1);
  });

  it("covers heartbeat fencing, duplicate/no-result output, tool audit, and context binding changes", async () => {
    const heartbeatFixture = await repositoryFixture();
    await candidateReady(heartbeatFixture);
    const heartbeatHarness = new FakeReviewerHarness({ decision: "APPROVE", findings: [] }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const heartbeat = setup({ fixture: heartbeatFixture, harness: heartbeatHarness, runnerId: "heartbeat-reviewer" });
    vi.spyOn(heartbeat.persistence, "renewReviewLease").mockRejectedValue(new DevelopmentLeaseError("heartbeat lost"));
    await expect(heartbeat.coordinator.runOne({ ...policy, leaseDurationMs: 900 })).rejects.toBeInstanceOf(DevelopmentLeaseError);
    expect(heartbeatHarness.executions).toHaveLength(1);

    for (const kind of ["none", "duplicate", "malformed"] as const) {
      const fixture = await repositoryFixture();
      await candidateReady(fixture);
      const harness: DevelopmentHarness = {
        abort: vi.fn(async () => undefined),
        execute: async (input) => ({
          executionId: `${kind}-${input.attemptId}`,
          events: (async function* (): AsyncGenerator<DevelopmentEvent> {
            yield { kind: "tool", safeMetadata: {}, status: "success", tool: "git.status" };
            if (kind === "duplicate") {
              yield { kind: "completed", result: "review_proposed", review: { decision: "APPROVE", findings: [] }, safeMetadata: {} };
              yield { kind: "completed", result: "review_proposed", review: { decision: "APPROVE", findings: [] }, safeMetadata: {} };
            } else if (kind === "malformed") {
              yield {
                kind: "completed",
                result: "review_proposed",
                review: { decision: "REQUEST_CHANGES", findings: [] } as never,
                safeMetadata: {}
              };
            }
          })()
        })
      };
      const persistence = createReviewRepositories(database);
      const coordinator = new ReviewerCoordinator({
        contextCompiler: new ReviewerContextCompiler(fixture.git),
        developmentPersistence: createDevelopmentRepositories(database),
        git: fixture.git,
        harness,
        persistence,
        runnerId: `output-${kind}`,
        sandboxManager: new FakeSandboxManager()
      });
      await expect(coordinator.runOne(policy)).rejects.toBeDefined();
    }

    const earlyRetentionFixture = await repositoryFixture();
    const earlyRetentionCandidate = await candidateReady(earlyRetentionFixture);
    const earlyRetention = setup({ fixture: earlyRetentionFixture, runnerId: "early-retention-mismatch" });
    vi.spyOn(earlyRetentionFixture.git, "ensureReviewRetentionRef").mockResolvedValueOnce({
      commit: earlyRetentionCandidate.candidate.commit,
      ref: "refs/personal-agent/reviews/wrong"
    });
    await expect(earlyRetention.coordinator.runOne(policy)).rejects.toThrow("retention identity");

    const lateRetentionFixture = await repositoryFixture();
    const lateRetentionCandidate = await candidateReady(lateRetentionFixture);
    const lateRetention = setup({ fixture: lateRetentionFixture, runnerId: "late-retention-mismatch" });
    const ensureRetention = lateRetentionFixture.git.ensureReviewRetentionRef.bind(
      lateRetentionFixture.git
    );
    let retentionCalls = 0;
    vi.spyOn(lateRetentionFixture.git, "ensureReviewRetentionRef").mockImplementation(
      async (reviewId, candidateCommit) => {
        retentionCalls += 1;
        return retentionCalls === 2
          ? {
              commit: lateRetentionCandidate.candidate.commit,
              ref: "refs/personal-agent/reviews/wrong"
            }
          : ensureRetention(reviewId, candidateCommit);
      }
    );
    await expect(lateRetention.coordinator.runOne(policy)).rejects.toThrow("retention identity");

    const missingContextFixture = await repositoryFixture();
    await candidateReady(missingContextFixture);
    const missingContext = setup({ fixture: missingContextFixture, runnerId: "missing-durable-context" });
    vi.spyOn(missingContext.persistence, "getReviewContextInput").mockResolvedValueOnce(undefined);
    await expect(missingContext.coordinator.runOne(policy)).rejects.toThrow("context input disappeared");

    const workspaceFixture = await repositoryFixture();
    await candidateReady(workspaceFixture);
    const workspace = setup({ fixture: workspaceFixture, runnerId: "workspace-identity" });
    vi.spyOn(workspaceFixture.git, "createWorktree").mockResolvedValueOnce("/tmp/wrong-review-workspace");
    await expect(workspace.coordinator.runOne(policy)).rejects.toThrow("identity changed");

    const contextFixture = await repositoryFixture();
    await candidateReady(contextFixture);
    const context = setup({ fixture: contextFixture, runnerId: "context-change" });
    const originalCompile = context.contextCompiler.compile.bind(context.contextCompiler);
    let compilations = 0;
    vi.spyOn(context.contextCompiler, "compile").mockImplementation(async (input) => {
      const compiled = await originalCompile(input);
      compilations += 1;
      return compilations === 2 ? { ...compiled, digest: "0".repeat(64) } : compiled;
    });
    await expect(context.coordinator.runOne(policy)).rejects.toThrow("context authority changed");

    const finalContextFixture = await repositoryFixture();
    await candidateReady(finalContextFixture);
    const finalContext = setup({ fixture: finalContextFixture, runnerId: "pure-durable-finalization" });
    const finalOriginalCompile = finalContext.contextCompiler.compile.bind(finalContext.contextCompiler);
    const compileSpy = vi.spyOn(finalContext.contextCompiler, "compile").mockImplementation(
      async (input) => finalOriginalCompile(input)
    );
    await expect(finalContext.coordinator.runOne(policy)).resolves.toMatchObject({
      status: "succeeded"
    });
    expect(compileSpy).toHaveBeenCalledTimes(2);
  });

  it("recovers durable proposals after cleanup without session, CLI, or external context work", async () => {
    for (const unavailable of ["context_input", "compiler"] as const) {
      const fixture = await repositoryFixture();
      await candidateReady(fixture);
      const manager = new FakeSandboxManager();
      manager.teardownFailures = 1;
      const initial = setup({ fixture, manager, runnerId: `recovery-${unavailable}-initial` });
      await expect(initial.coordinator.runOne(policy)).rejects.toThrow("cleanup failed");
      const target = (await database.query.developmentReviews.findFirst({
        orderBy: (reviews, { desc }) => [desc(reviews.createdAt)]
      }))!;
      await pool.query(
        "update development_reviews set lease_expires_at = clock_timestamp() - interval '100 years' where id = $1",
        [target.id]
      );
      const recovery = setup({ fixture, manager, runnerId: `recovery-${unavailable}` });
      if (unavailable === "context_input") {
        vi.spyOn(recovery.persistence, "getReviewContextInput").mockRejectedValue(
          new Error("must not reload context during finalization")
        );
      } else {
        vi.spyOn(recovery.contextCompiler, "compile").mockRejectedValue(
          new Error("must not compile external context during finalization")
        );
      }
      const recovered = await recovery.coordinator.recoverOne(policy.leaseDurationMs);
      expect(recovered?.status, unavailable).toBe("succeeded");
    }
  });

  it("fails closed when proposal persistence, audit, abort, failure recording, or finalization fails", async () => {
    for (const failure of ["proposal", "audit", "record_failure", "stale_failure", "finalization", "stale_finalization", "cleanup_audit"] as const) {
      const fixture = await repositoryFixture();
      const candidate = await candidateReady(fixture);
      const manager = new FakeSandboxManager();
      if (failure === "cleanup_audit") manager.teardownFailures = 1;
      const review = setup({ fixture, manager, runnerId: `persistence-${failure}` });
      if (failure === "proposal") {
        vi.spyOn(review.persistence, "persistReviewProposal").mockRejectedValueOnce(new Error("proposal persistence failed"));
      } else if (failure === "audit") {
        vi.spyOn(review.persistence, "appendReviewEvent").mockRejectedValueOnce(new Error("audit persistence failed"));
      } else if (failure === "record_failure" || failure === "stale_failure") {
        vi.spyOn(review.persistence, "appendReviewEvent").mockRejectedValueOnce(new Error("trigger failure handling"));
        vi.spyOn(review.persistence, "recordReviewFailure").mockRejectedValueOnce(
          failure === "stale_failure"
            ? new DevelopmentLeaseError("stale failure recording")
            : new Error("failure audit failed")
        );
      } else if (failure === "finalization") {
        vi.spyOn(review.persistence, "finalizeReview").mockRejectedValueOnce(new Error("finalization persistence failed"));
      } else if (failure === "stale_finalization") {
        vi.spyOn(review.persistence, "finalizeReview").mockRejectedValueOnce(new DevelopmentLeaseError("stale finalization"));
      } else {
        vi.spyOn(review.persistence, "recordReviewCleanup").mockRejectedValue(new Error("cleanup audit failed"));
      }
      await expect(review.coordinator.runOne(policy)).rejects.toBeDefined();
      const row = await database.query.developmentReviews.findFirst({
        where: (reviews, { eq }) => eq(reviews.taskId, candidate.task.id)
      });
      expect(row?.status).not.toBe("succeeded");
    }

    const abortFixture = await repositoryFixture();
    await candidateReady(abortFixture);
    const abortHarness = new FakeReviewerHarness("provider");
    vi.spyOn(abortHarness, "abort").mockRejectedValueOnce(new Error("abort failed"));
    const abortReview = setup({ fixture: abortFixture, harness: abortHarness, runnerId: "abort-failure" });
    await expect(abortReview.coordinator.runOne(policy)).rejects.toBeDefined();
  });

  it("takes deterministic recovery decisions without invoking a harness", async () => {
    const baseReview = {
      baseCommit: "a".repeat(40),
      candidateCommit: "b".repeat(40),
      candidateRef: "refs/personal-agent/development-attempts/00000000-0000-4000-8000-000000000001",
      cleanupStatus: "failed",
      contextDigest: "c".repeat(64),
      decision: null,
      failureClass: "lease_expired",
      id: "00000000-0000-4000-8000-000000000002",
      implementerAttemptId: "00000000-0000-4000-8000-000000000001",
      leaseGeneration: 2,
      retentionRef: "refs/personal-agent/reviews/00000000-0000-4000-8000-000000000002",
      sandboxId: "review-sandbox",
      status: "interrupted"
    };
    const durable = {
      attempt: { id: baseReview.implementerAttemptId },
      attemptEvents: [
        { id: "00000000-0000-4000-8000-000000000003", kind: "test", safeMetadata: { criterion_id: "fixture", duration_ms: 1 }, status: "success" },
        { id: "00000000-0000-4000-8000-000000000004", kind: "teardown", safeMetadata: {}, status: "success" }
      ],
      review: { ...baseReview, budget, usage: emptyDevelopmentUsage() },
      task: { acceptanceCriteria: criteria, approvedSpec: "spec", baseCommit: baseReview.baseCommit, title: "task" }
    };
    function mocked(reclaimed: unknown, durableResult: unknown = durable, digest = baseReview.contextDigest, attemptResult?: unknown) {
      const persistence = {
        completeReviewFailure: vi.fn(async () => ({ status: "failed" })),
        getReview: vi.fn(async () => reclaimed),
        getReviewContextInput: vi.fn(async () => durableResult),
        reclaimReview: vi.fn(async () => reclaimed),
        recordReviewCleanup: vi.fn(async () => undefined),
        recordReviewFailure: vi.fn(async () => undefined),
        finalizeReview: vi.fn(async () => ({ status: "succeeded" }))
      };
      const harness = { abort: vi.fn(), execute: vi.fn() };
      const coordinator = new ReviewerCoordinator({
        contextCompiler: {
          compile: vi.fn(async () => ({ digest })),
          validateFindings: vi.fn(async () => undefined)
        },
        developmentPersistence: attemptResult === undefined
          ? {}
          : { getDevelopmentAttempt: vi.fn(async () => attemptResult) },
        git: {
          ensureReviewRetentionRef: vi.fn(async () => ({
            commit: baseReview.candidateCommit,
            ref: baseReview.retentionRef
          })),
          removeWorktree: vi.fn(async () => undefined),
          workspacePath: vi.fn(() => "/tmp/recovery")
        },
        harness,
        persistence,
        runnerId: "mock-recovery",
        sandboxManager: {
          identify: vi.fn(() => ({ containerName: "mock", id: "review-sandbox", path: "/tmp/recovery" })),
          teardown: vi.fn(async () => undefined)
        }
      } as never);
      return { coordinator, harness, persistence };
    }

    const none = mocked(undefined);
    await expect(none.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toBeUndefined();
    expect(none.harness.execute).not.toHaveBeenCalled();

    const interrupted = mocked(baseReview);
    await expect(interrupted.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toEqual({ status: "failed" });
    const interruptedClean = mocked({ ...baseReview, cleanupStatus: "succeeded" });
    await expect(interruptedClean.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toEqual({ status: "failed" });
    const invalidatedFix = mocked(
      { ...baseReview, authorityInvalidated: true },
      durable,
      baseReview.contextDigest,
      { fixIteration: 1 }
    );
    await expect(invalidatedFix.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toEqual({ status: "failed" });
    expect(interrupted.persistence.completeReviewFailure).toHaveBeenCalled();

    const finalizing = { ...baseReview, decision: "APPROVE", failureClass: null, status: "finalizing" };
    const durableFinalization = mocked(finalizing);
    await expect(durableFinalization.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toEqual({
      status: "succeeded"
    });
    expect(durableFinalization.persistence.finalizeReview).toHaveBeenCalledWith(
      expect.objectContaining({ contextDigest: baseReview.contextDigest })
    );
    expect(durableFinalization.harness.execute).not.toHaveBeenCalled();

    const missingDigest = mocked({ ...finalizing, contextDigest: null });
    await expect(missingDigest.coordinator.recoverOne(policy.leaseDurationMs)).resolves.toEqual({
      status: "failed"
    });
  });
});
