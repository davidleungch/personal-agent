import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDevelopmentRepositories,
  createFixLoopRepositories,
  createReviewRepositories,
  type Database
} from "@personal-agent/db";
import { emptyDevelopmentUsage } from "@personal-agent/shared";
import { DevelopmentContextCompiler } from "../src/context-compiler";
import { TrustedGit } from "../src/git";
import { phase2dReviewerAuthorityPaths, ReviewerContextCompiler } from "../src/reviewer-context-compiler";

export const phase2dFixtureBudget = {
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
  description: "The bounded fixture check succeeds",
  id: "fixture"
}];

// This fixture creates real Git objects and uses the accepted implementation and
// review persistence APIs. It does not create CI evidence or release authority.
export async function createPhase2DCandidateFixture(database: Database) {
  const root = await mkdtemp(join(tmpdir(), "personal-agent-phase2d-"));
  const repository = join(root, "repository");
  const workspaces = join(root, "workspaces");
  const remote = join(root, "remote.git");
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await mkdir(join(repository, "docs/decisions"), { recursive: true });
    await mkdir(join(repository, "src"));
    const authorityFiles = {
      "AGENTS.md": "# Fixture policy\nDeterministic code owns authority.\n",
      "docs/design.md": "# Design\n## Reviewer\nIndependent exact-candidate review.\n",
      "docs/decisions/0001-pi-development-harness.md": "# Harness\nModels have no release authority.\n",
      "docs/decisions/0002-phase-2d-v1-merge-deploy.md": "# Exact release\nNo live activation in fixtures.\n",
      "docs/phase-2-implementation-plan.md": "# Phase 2\nStop after milestone 1 for review.\n",
      "docs/phase-2d-merge-deploy.md": "# Phase 2D\nExact candidate and independent CI required.\n"
    };
    await Promise.all(Object.entries(authorityFiles).map(([path, content]) =>
      writeFile(join(repository, path), content)
    ));
    await writeFile(join(repository, "src/value.txt"), "base\n");
    const gitCommand = (...args: string[]) => execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        PATH: process.env.PATH
      }
    }).trim();
    gitCommand("init", "-q", "--initial-branch=main");
    gitCommand("add", ".");
    gitCommand("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-q", "-m", "fixture base");
    const baseCommit = gitCommand("rev-parse", "HEAD");
    gitCommand("clone", "--bare", "--quiet", repository, remote);
    const git = new TrustedGit(repository, workspaces);
    const development = createDevelopmentRepositories(database);
    const reviews = createReviewRepositories(database);
    const task = await development.createApprovedDevelopmentTask({
      acceptanceCriteria: criteria,
      approvedAt: new Date(),
      approvedSpec: "Change only src/value.txt from base to candidate.",
      baseCommit,
      title: "Phase 2D exact candidate fixture"
    });
    const runnerId = `implementer-${task.id}`;
    const claim = await development.claimReadyDevelopmentTask({
      budget: phase2dFixtureBudget,
      leaseDurationMs: 60_000,
      modelProfile: "balanced",
      now: new Date(),
      runnerId
    });
    if (!claim || claim.task.id !== task.id) throw new Error("Fixture task was not claimed");
    const fence = { attemptId: claim.attempt.id, leaseGeneration: claim.attempt.leaseGeneration, runnerId };
    const context = await new DevelopmentContextCompiler(git).compile({
      acceptanceCriteria: criteria,
      allowedPaths: ["src"],
      baseCommit,
      budget: phase2dFixtureBudget,
      forbiddenPaths: [".git"],
      relevantPaths: ["src/value.txt"],
      specification: task.approvedSpec,
      taskTitle: task.title,
      usage: emptyDevelopmentUsage()
    });
    await development.saveDevelopmentContext({ ...fence, contextDigest: context.digest, contextManifest: context.manifest, now: new Date() });
    await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "implementing", now: new Date(), taskStatus: "implementing" });
    const workspace = await git.createWorktree(claim.attempt.id, baseCommit);
    await writeFile(join(workspace, "src/value.txt"), "candidate\n");
    await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "testing", now: new Date(), taskStatus: "testing" });
    execFileSync(process.execPath, criteria[0]!.check.arguments, { cwd: workspace });
    const evidence = await development.appendDevelopmentAttemptEvent({
      ...fence,
      kind: "test",
      now: new Date(),
      safeMetadata: { criterion_id: "fixture", duration_ms: 0, exit_code: 0 },
      status: "success"
    });
    await development.transitionDevelopmentAttempt({ ...fence, attemptStatus: "capturing_candidate", now: new Date(), taskStatus: "testing" });
    const candidate = await git.captureCandidate({
      allowedPaths: ["src"],
      attemptId: claim.attempt.id,
      baseCommit,
      forbiddenPaths: [".git"],
      maxDiffBytes: phase2dFixtureBudget.maxDiffBytes,
      workspacePath: workspace
    });
    await development.recordDevelopmentCandidate({ ...fence, candidateCommit: candidate.commit, candidateRef: candidate.ref, now: new Date(), safeSummary: "Exact fixture candidate captured" });
    await git.removeWorktree(workspace);
    await development.appendDevelopmentAttemptEvent({ ...fence, kind: "teardown", now: new Date(), safeMetadata: { sandbox_id: claim.attempt.sandboxId }, status: "success" });

    return {
      authorityPaths: Object.keys(authorityFiles).sort(),
      attemptId: claim.attempt.id,
      baseCommit,
      candidate,
      cleanup,
      git,
      gitCommand,
      remote,
      repository,
      task,
      async approve(compiler = new ReviewerContextCompiler(git)) {
        const reviewerId = `reviewer-${task.id}`;
        const contextPolicy = { forbiddenPaths: [".git"], readablePaths: ["AGENTS.md", "docs", "src"], relevantPaths: ["src/value.txt"] };
        const reviewClaim = await reviews.claimCandidateReadyReview({
          budget: phase2dFixtureBudget,
          contextPolicy,
          leaseDurationMs: 60_000,
          modelProfile: "reasoning",
          runnerId: reviewerId,
          taskId: task.id
        });
        if (!reviewClaim) throw new Error("Fixture review was not claimed");
        const reviewFence = { leaseGeneration: reviewClaim.review.leaseGeneration, reviewId: reviewClaim.review.id, runnerId: reviewerId };
        await git.ensureReviewRetentionRef(reviewClaim.review.id, candidate.commit);
        const reviewContext = await compiler.compile({
          acceptanceCriteria: criteria,
          authorityPaths: phase2dReviewerAuthorityPaths,
          baseCommit,
          budget: phase2dFixtureBudget,
          candidateCommit: candidate.commit,
          contextPolicy,
          modelProfile: "reasoning",
          specification: task.approvedSpec,
          taskTitle: task.title,
          testEvidence: [{ criterionId: "fixture", durationMs: 0, eventId: evidence.id, status: "success" }],
          usage: emptyDevelopmentUsage()
        });
        await reviews.saveReviewContext({ ...reviewFence, contextDigest: reviewContext.digest, contextManifest: reviewContext.manifest, now: new Date() });
        await reviews.startReviewExecution({ ...reviewFence, now: new Date() });
        await reviews.recordReviewUsage({ ...reviewFence, delta: { ...emptyDevelopmentUsage(), inputTokens: 1, modelInvocations: 1, outputTokens: 1 }, now: new Date() });
        await reviews.persistReviewProposal({ ...reviewFence, now: new Date(), result: { decision: "APPROVE", findings: [] } });
        await reviews.recordReviewCleanup({ ...reviewFence, now: new Date(), status: "succeeded" });
        const review = await reviews.finalizeReview({ ...reviewFence, contextDigest: reviewContext.digest, now: new Date() });
        const reconciled = await createFixLoopRepositories(database).reconcileCurrentReview({ reviewId: review.id });
        return { context: reviewContext, review, task: reconciled.task };
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
