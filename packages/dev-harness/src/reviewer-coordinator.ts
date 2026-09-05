import {
  DevelopmentBudgetError,
  DevelopmentLeaseError,
  createDevelopmentRepositories,
  createReviewRepositories
} from "@personal-agent/db";
import {
  developmentAcceptanceCriteriaSchema,
  developmentBudgetSchema,
  developmentReviewerContextPolicySchema,
  developmentReviewResultSchema,
  modelProfileSchema,
  type DevelopmentBudget,
  type DevelopmentReviewResult,
  type JsonObject,
  type ModelProfile
} from "@personal-agent/shared";
import { z } from "zod";
import type { DevelopmentHarness } from "./contract.js";
import { TrustedGit } from "./git.js";
import { ReviewerContextCompiler, type ReviewerTestEvidence } from "./reviewer-context-compiler.js";
import { SandboxGateway, type SandboxManager, type SandboxWorkspace } from "./sandbox.js";

type ReviewPersistence = ReturnType<typeof createReviewRepositories>;
type DevelopmentPersistence = ReturnType<typeof createDevelopmentRepositories>;

class ReviewerInfrastructureError extends Error {
  constructor(readonly failureClass: string) {
    super(`Reviewer infrastructure failed: ${failureClass}`);
  }
}

export type ReviewerRunPolicy = {
  budget: DevelopmentBudget;
  forbiddenPaths: readonly string[];
  leaseDurationMs: number;
  modelProfile: ModelProfile;
  readablePaths: readonly string[];
  relevantPaths: readonly string[];
};

function testEvidence(
  criteria: ReturnType<typeof developmentAcceptanceCriteriaSchema.parse>,
  events: ReadonlyArray<{ id: string; kind: string; safeMetadata: JsonObject; status: string }>
): ReviewerTestEvidence {
  return criteria.map((criterion) => {
    const event = events.find(
      (candidate) =>
        candidate.kind === "test" &&
        candidate.status === "success" &&
        candidate.safeMetadata.criterion_id === criterion.id
    );
    if (!event) throw new Error(`Missing deterministic evidence for ${criterion.id}`);
    const durationMs = z.number().int().nonnegative().parse(event.safeMetadata.duration_ms);
    return { criterionId: criterion.id, durationMs, eventId: event.id, status: "success" as const };
  });
}

export class ReviewerCoordinator {
  constructor(
    private readonly dependencies: {
      contextCompiler: ReviewerContextCompiler;
      developmentPersistence: DevelopmentPersistence;
      git: TrustedGit;
      harness: DevelopmentHarness;
      knownSecrets?: readonly string[];
      persistence: ReviewPersistence;
      runnerId: string;
      sandboxManager: SandboxManager;
    }
  ) {}

  private async verifyCandidateBinding(input: {
    attemptId: string;
    baseCommit: string;
    candidateCommit: string;
    candidateRef: string;
  }): Promise<void> {
    try {
      const candidate = await this.dependencies.git.verifyCandidateRef(
        input.attemptId,
        input.baseCommit,
        input.candidateCommit
      );
      if (candidate?.ref === input.candidateRef) return;
    } catch {
      // The deterministic integrity transition below owns the safe response.
    }
    try {
      await this.dependencies.developmentPersistence.blockDevelopmentCandidateIntegrity({
        attemptId: input.attemptId,
        now: new Date()
      });
    } catch {
      // A competing integrity transition cannot make this review valid.
    }
    throw new Error("Exact candidate/ref integrity verification failed");
  }

  private async compileContext(reviewId: string) {
    const durable = await this.dependencies.persistence.getReviewContextInput(reviewId);
    if (!durable) throw new Error("Durable Reviewer context input disappeared");
    const criteria = developmentAcceptanceCriteriaSchema.parse(durable.task.acceptanceCriteria);
    return this.dependencies.contextCompiler.compile({
      acceptanceCriteria: criteria,
      baseCommit: durable.review.baseCommit,
      budget: durable.review.budget,
      candidateCommit: durable.review.candidateCommit,
      contextPolicy: durable.review.contextPolicy,
      modelProfile: durable.review.modelProfile,
      specification: durable.task.approvedSpec,
      taskTitle: durable.task.title,
      testEvidence: testEvidence(criteria, durable.attemptEvents),
      usage: durable.review.usage
    });
  }

  private async cleanup(
    fence: { leaseGeneration: number; reviewId: string; runnerId: string },
    workspace: SandboxWorkspace
  ): Promise<void> {
    try {
      await this.dependencies.sandboxManager.teardown(workspace);
      await this.dependencies.git.removeWorktree(workspace.path);
      await this.dependencies.persistence.recordReviewCleanup({
        ...fence,
        now: new Date(),
        status: "succeeded"
      });
    } catch (error) {
      try {
        await this.dependencies.persistence.recordReviewCleanup({
          ...fence,
          now: new Date(),
          status: "failed"
        });
      } catch {
        // The original cleanup ambiguity remains authoritative and the lease can expire.
      }
      throw error;
    }
  }

  private async failBeforeFinalization(input: {
    error: unknown;
    fence: { leaseGeneration: number; reviewId: string; runnerId: string };
    needsHumanReason?: "infrastructure_retry_exhausted" | "reviewer_failure";
    workspace: SandboxWorkspace;
  }): Promise<never> {
    const failureClass =
      input.error instanceof DevelopmentBudgetError
        ? "budget_exhausted"
        : input.error instanceof DevelopmentLeaseError
          ? "stale_lease"
          : "execution";
    if (input.error instanceof DevelopmentLeaseError) throw input.error;
    try {
      await this.dependencies.persistence.recordReviewFailure({
        ...input.fence,
        failureClass,
        now: new Date()
      });
    } catch (error) {
      if (!(error instanceof DevelopmentLeaseError)) throw error;
    }
    await this.cleanup(input.fence, input.workspace);
    await this.dependencies.persistence.completeReviewFailure({
      ...input.fence,
      ...(input.needsHumanReason ? { needsHumanReason: input.needsHumanReason } : {}),
      now: new Date(),
      safeSummary: "Independent Reviewer attempt failed closed without an authoritative decision"
    });
    throw input.error;
  }

  async runOne(
    policyInput: ReviewerRunPolicy,
    options: { taskId?: string } = {}
  ): Promise<unknown> {
    const policy = {
      ...policyInput,
      budget: developmentBudgetSchema.parse(policyInput.budget),
      modelProfile: modelProfileSchema.parse(policyInput.modelProfile)
    };
    const contextPolicy = developmentReviewerContextPolicySchema.parse({
      forbiddenPaths: policy.forbiddenPaths,
      readablePaths: policy.readablePaths,
      relevantPaths: policy.relevantPaths
    });
    const claimed = await this.dependencies.persistence.claimCandidateReadyReview({
      budget: policy.budget,
      contextPolicy,
      leaseDurationMs: policy.leaseDurationMs,
      modelProfile: policy.modelProfile,
      runnerId: this.dependencies.runnerId,
      ...(options.taskId ? { taskId: options.taskId } : {})
    });
    if (!claimed) return undefined;

    const { attempt, review, task } = claimed;
    const fence = {
      leaseGeneration: review.leaseGeneration,
      reviewId: review.id,
      runnerId: this.dependencies.runnerId
    };
    const workspace = this.dependencies.sandboxManager.identify({
      sandboxId: review.sandboxId,
      workspacePath: this.dependencies.git.workspacePath(review.id)
    });
    const heartbeatAbort = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      void this.dependencies.persistence.renewReviewLease({
        ...fence,
        leaseDurationMs: policy.leaseDurationMs
      }).catch((error: unknown) => {
        heartbeatFailure = error;
        heartbeatAbort.abort();
      });
    }, Math.max(250, Math.floor(policy.leaseDurationMs / 3)));
    const ensureHeartbeat = () => {
      if (heartbeatFailure) throw heartbeatFailure;
    };
    const appendEvent = (
      kind: "harness" | "tool" | "check" | "integrity",
      status: "started" | "success" | "failed" | "unknown" | "blocked",
      safeMetadata: JsonObject = {}
    ) => this.dependencies.persistence.appendReviewEvent({
      ...fence,
      kind,
      now: new Date(),
      safeMetadata,
      status
    });

    let executionId: string | undefined;
    let proposal: DevelopmentReviewResult | undefined;
    let contextDigest: string | undefined;
    try {
      await this.verifyCandidateBinding({
        attemptId: attempt.id,
        baseCommit: attempt.baseCommit,
        candidateCommit: review.candidateCommit,
        candidateRef: review.candidateRef
      });
      const retention = await this.dependencies.git.ensureReviewRetentionRef(
        review.id,
        review.candidateCommit
      );
      if (retention.ref !== review.retentionRef) {
        throw new Error("Reviewer retention identity changed");
      }
      const context = await this.compileContext(review.id);
      contextDigest = context.digest;
      await this.dependencies.persistence.saveReviewContext({
        ...fence,
        contextDigest: context.digest,
        contextManifest: context.manifest,
        now: new Date()
      });
      const workspacePath = await this.dependencies.git.createWorktree(
        review.id,
        review.candidateCommit
      );
      if (workspacePath !== workspace.path) throw new Error("Reviewer workspace identity changed");
      try {
        await this.dependencies.sandboxManager.create({
          sandboxId: review.sandboxId,
          workspacePath
        });
      } catch {
        throw new ReviewerInfrastructureError("sandbox");
      }
      await this.dependencies.git.assertWorkspaceClean(workspace.path, review.candidateCommit);
      await this.verifyCandidateBinding({
        attemptId: attempt.id,
        baseCommit: attempt.baseCommit,
        candidateCommit: review.candidateCommit,
        candidateRef: review.candidateRef
      });
      await this.dependencies.persistence.startReviewExecution({ ...fence, now: new Date() });
      const criteria = developmentAcceptanceCriteriaSchema.parse(task.acceptanceCriteria);
      const gateway = new SandboxGateway({
        allowedPaths: policy.readablePaths,
        approvedChecks: criteria,
        baseCommit: task.baseCommit,
        budget: policy.budget,
        candidateCommit: review.candidateCommit,
        forbiddenPaths: policy.forbiddenPaths,
        git: this.dependencies.git,
        knownSecrets: this.dependencies.knownSecrets ?? [],
        onAudit: ({ safeMetadata, status, tool }) =>
          appendEvent(tool === "review.run_check" ? "check" : "tool", status, {
            ...safeMetadata,
            tool
          }).then(() => undefined),
        onUsage: (delta) =>
          this.dependencies.persistence.recordReviewUsage({
            ...fence,
            delta,
            now: new Date()
          }).then(() => undefined),
        role: "reviewer",
        sandboxManager: this.dependencies.sandboxManager,
        workspace
      });
      const execution = await this.dependencies.harness.execute({
        attemptId: review.id,
        budget: policy.budget,
        context,
        modelProfile: policy.modelProfile,
        role: "reviewer",
        signal: heartbeatAbort.signal,
        tools: gateway
      });
      executionId = execution.executionId;
      for await (const event of execution.events) {
        ensureHeartbeat();
        if (event.kind === "usage") {
          await this.dependencies.persistence.recordReviewUsage({
            ...fence,
            delta: event.delta,
            now: new Date()
          });
        } else if (event.kind === "failed") {
          await appendEvent("harness", "failed", { failure_class: event.failureClass });
          throw new ReviewerInfrastructureError(event.failureClass);
        } else if (event.kind === "completed") {
          if (event.result !== "review_proposed" || proposal) {
            throw new ReviewerInfrastructureError("malformed_output");
          }
          try {
            proposal = developmentReviewResultSchema.parse(event.review);
          } catch {
            throw new ReviewerInfrastructureError("malformed_output");
          }
          await appendEvent("harness", "success", {
            decision: proposal.decision,
            finding_count: proposal.findings.length
          });
        } else if (event.kind === "tool") {
          await appendEvent("harness", event.status, { tool: event.tool });
        } else {
          await appendEvent("harness", "started", event.safeMetadata);
        }
      }
      if (!proposal) throw new ReviewerInfrastructureError("malformed_output");
      await this.dependencies.harness.abort(execution.executionId);
      executionId = undefined;
      ensureHeartbeat();
      await this.dependencies.git.assertWorkspaceClean(workspace.path, review.candidateCommit);
      await this.verifyCandidateBinding({
        attemptId: attempt.id,
        baseCommit: attempt.baseCommit,
        candidateCommit: review.candidateCommit,
        candidateRef: review.candidateRef
      });
      const retained = await this.dependencies.git.ensureReviewRetentionRef(
        review.id,
        review.candidateCommit
      );
      if (retained.ref !== review.retentionRef) {
        throw new Error("Reviewer retention identity changed");
      }
      const recompiled = await this.compileContext(review.id);
      if (recompiled.digest !== context.digest) {
        throw new Error("Reviewer context authority changed before proposal persistence");
      }
      await this.dependencies.contextCompiler.validateFindings(recompiled, proposal.findings);
      await this.dependencies.persistence.persistReviewProposal({
        ...fence,
        now: new Date(),
        result: proposal
      });
    } catch (error) {
      if (executionId) await this.dependencies.harness.abort(executionId).catch(() => undefined);
      clearInterval(heartbeat);
      heartbeatAbort.abort();
      if (
        attempt.fixIteration &&
        error instanceof ReviewerInfrastructureError &&
        review.infrastructureRetryCount < 2
      ) {
        await this.dependencies.persistence.recordReviewFailure({
          ...fence,
          failureClass: error.failureClass,
          now: new Date()
        });
        await this.cleanup(fence, workspace);
        await this.dependencies.persistence.prepareReviewInfrastructureRetry({
          ...fence,
          failureClass: error.failureClass,
          leaseDurationMs: policy.leaseDurationMs
        });
        return this.runOne(policy, { taskId: task.id });
      }
      const needsHumanReason = attempt.fixIteration
        ? error instanceof ReviewerInfrastructureError
          ? "infrastructure_retry_exhausted" as const
          : "reviewer_failure" as const
        : undefined;
      return this.failBeforeFinalization({
        error,
        fence,
        ...(needsHumanReason ? { needsHumanReason } : {}),
        workspace
      });
    }

    clearInterval(heartbeat);
    heartbeatAbort.abort();
    try {
      await this.cleanup(fence, workspace);
    } catch (error) {
      // Keep the durable proposal in finalizing. Cleanup failure releases the lease for
      // an authorized recovery call, which retries cleanup without another model session.
      throw error;
    }

    try {
      const finalized = await this.dependencies.persistence.finalizeReview({
        ...fence,
        contextDigest: contextDigest!,
        now: new Date()
      });
      return finalized;
    } catch (error) {
      if (!(error instanceof DevelopmentLeaseError)) {
        await this.dependencies.persistence.recordReviewFailure({
          ...fence,
          failureClass: "finalization",
          now: new Date()
        });
        await this.dependencies.persistence.completeReviewFailure({
          ...fence,
          ...(attempt.fixIteration ? { needsHumanReason: "reviewer_failure" } : {}),
          now: new Date(),
          safeSummary: "Independent Reviewer finalization failed closed"
        });
      }
      throw error;
    }
  }

  async recoverOne(leaseDurationMs: number) {
    const review = await this.dependencies.persistence.reclaimReview({
      leaseDurationMs,
      runnerId: this.dependencies.runnerId
    });
    if (!review) return undefined;
    const fence = {
      leaseGeneration: review.leaseGeneration,
      reviewId: review.id,
      runnerId: this.dependencies.runnerId
    };
    // Recovery never reuses or destroys an expired worker's external resources.
    // An interrupted review is ambiguous; fail closed instead of starting Pi again.
    const attempt = "getDevelopmentAttempt" in this.dependencies.developmentPersistence
      ? await this.dependencies.developmentPersistence.getDevelopmentAttempt(review.implementerAttemptId)
      : undefined;
    if (!attempt?.fixIteration) {
      const workspace = this.dependencies.sandboxManager.identify({
        sandboxId: review.sandboxId,
        workspacePath: this.dependencies.git.workspacePath(review.id)
      });
      if (review.authorityInvalidated) {
        await this.dependencies.persistence.recordReviewFailure({
          ...fence,
          failureClass: "authority_invalidated",
          now: new Date()
        });
        if (review.cleanupStatus !== "succeeded") await this.cleanup(fence, workspace);
        return this.dependencies.persistence.completeReviewFailure({
          ...fence,
          now: new Date(),
          safeSummary: "Reviewer authority was invalidated; cleanup completed without an authoritative decision"
        });
      }
      if (review.status === "finalizing" && review.decision && review.contextDigest && !review.failureClass) {
        try {
          const retained = await this.dependencies.git.ensureReviewRetentionRef(review.id, review.candidateCommit);
          if (retained.ref !== review.retentionRef) throw new Error("Reviewer retention identity changed");
          if (review.cleanupStatus !== "succeeded") await this.cleanup(fence, workspace);
          return this.dependencies.persistence.finalizeReview({
            ...fence,
            contextDigest: review.contextDigest,
            now: new Date()
          });
        } catch {
          await this.dependencies.persistence.recordReviewFailure({
            ...fence,
            failureClass: "candidate_unavailable",
            now: new Date()
          });
        }
      }
      if (review.cleanupStatus !== "succeeded") await this.cleanup(fence, workspace);
      return this.dependencies.persistence.completeReviewFailure({
        ...fence,
        now: new Date(),
        safeSummary: "Interrupted independent Reviewer was reconstructed without Pi session state and failed closed"
      });
    }
    await this.dependencies.persistence.recordReviewFailure({
      ...fence,
      failureClass: review.authorityInvalidated ? "authority_invalidated" : "execution_interrupted",
      now: new Date()
    });
    return this.dependencies.persistence.completeReviewFailure({
      ...fence,
      ...(attempt?.fixIteration && !review.authorityInvalidated
        ? { needsHumanReason: "reviewer_failure" }
        : {}),
      now: new Date(),
      safeSummary: review.authorityInvalidated
        ? "Reviewer authority was invalidated; recovery stopped without external cleanup"
        : "Interrupted independent Reviewer failed closed without session authority"
    });
  }
}
