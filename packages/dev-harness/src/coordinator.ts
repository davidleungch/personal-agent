import { stat } from "node:fs/promises";
import {
  DevelopmentBudgetError,
  DevelopmentLeaseError,
  createDevelopmentRepositories
} from "@personal-agent/db";
import {
  developmentAcceptanceCriteriaSchema,
  developmentBudgetSchema,
  developmentImplementerContextPolicySchema,
  emptyDevelopmentUsage,
  isSecretFreeText,
  modelProfileSchema,
  type DevelopmentBudget,
  type DevelopmentNeedsHumanReason,
  type DevelopmentTaskStatus,
  type JsonObject,
  type ModelProfile
} from "@personal-agent/shared";
import { z } from "zod";
import type { DevelopmentHarness } from "./contract.js";
import { DevelopmentContextCompiler } from "./context-compiler.js";
import { TrustedGit } from "./git.js";
import { SandboxGateway, type SandboxManager, type SandboxWorkspace } from "./sandbox.js";

type DevelopmentPersistence = ReturnType<typeof createDevelopmentRepositories>;
type ClaimedDevelopment = {
  attempt: NonNullable<Awaited<ReturnType<DevelopmentPersistence["getDevelopmentAttempt"]>>>;
  sourceReview?: NonNullable<Awaited<ReturnType<DevelopmentPersistence["getConsumedFixAttemptInput"]>>>["sourceReview"];
  task: NonNullable<Awaited<ReturnType<DevelopmentPersistence["getDevelopmentTask"]>>>;
};

class InfrastructureExecutionError extends Error {
  constructor(readonly failureClass: string) {
    super(`Development infrastructure failed: ${failureClass}`);
  }
}
class CandidateCaptureInfrastructureError extends InfrastructureExecutionError {}

class DeterministicTestError extends Error {}
class NonConvergenceError extends Error {}
class NeedsHumanProposal extends Error {
  constructor(readonly reason: DevelopmentNeedsHumanReason) {
    super(`Fix Implementer requested human action: ${reason}`);
  }
}

export type DevelopmentRunPolicy = {
  allowedPaths: readonly string[];
  budget: DevelopmentBudget;
  forbiddenPaths: readonly string[];
  leaseDurationMs: number;
  modelProfile: ModelProfile;
  relevantPaths: readonly string[];
};

export class DevelopmentCoordinator {
  constructor(
    private readonly dependencies: {
      contextCompiler: DevelopmentContextCompiler;
      git: TrustedGit;
      harness: DevelopmentHarness;
      knownSecrets?: readonly string[];
      persistence: DevelopmentPersistence;
      runnerId: string;
      sandboxManager: SandboxManager;
    }
  ) {}

  async createApprovedTask(input: {
    acceptanceCriteria: unknown;
    approvedAt?: Date;
    approvedSpec: string;
    baseReference: string;
    title: string;
  }) {
    const baseCommit = await this.dependencies.git.resolveCommit(input.baseReference);
    return this.dependencies.persistence.createApprovedDevelopmentTask({
      acceptanceCriteria: developmentAcceptanceCriteriaSchema.parse(input.acceptanceCriteria),
      approvedAt: input.approvedAt ?? new Date(),
      approvedSpec: input.approvedSpec,
      baseCommit,
      title: input.title
    });
  }

  async runOne(
    policyInput: DevelopmentRunPolicy,
    options: { fixOnly?: boolean; taskId?: string } = {}
  ) {
    const policy = {
      ...policyInput,
      budget: developmentBudgetSchema.parse(policyInput.budget),
      modelProfile: modelProfileSchema.parse(policyInput.modelProfile)
    };
    const contextPolicy = options.fixOnly
      ? developmentImplementerContextPolicySchema.parse({
          allowedPaths: policy.allowedPaths,
          forbiddenPaths: policy.forbiddenPaths,
          relevantPaths: policy.relevantPaths
        })
      : undefined;
    const claimed = options.fixOnly
      ? await this.dependencies.persistence.claimFixRequiredDevelopmentTask({
          budget: policy.budget,
          contextPolicy: contextPolicy!,
          leaseDurationMs: policy.leaseDurationMs,
          modelProfile: policy.modelProfile,
          runnerId: this.dependencies.runnerId,
          ...(options.taskId ? { taskId: options.taskId } : {})
        })
      : await this.dependencies.persistence.claimReadyDevelopmentTask({
          budget: policy.budget,
          leaseDurationMs: policy.leaseDurationMs,
          modelProfile: policy.modelProfile,
          now: new Date(),
          runnerId: this.dependencies.runnerId,
          ...(options.taskId ? { taskId: options.taskId } : {})
        });
    if (!claimed) return undefined;
    return this.executeWithRetries(claimed as ClaimedDevelopment, policy);
  }

  private async executeWithRetries(
    claimed: ClaimedDevelopment,
    policy: DevelopmentRunPolicy
  ): Promise<unknown> {
    let current = claimed;
    while (true) {
      try {
        return await this.executeClaimed(current, policy);
      } catch (error) {
        if (error instanceof DevelopmentLeaseError) throw error;
        if (error instanceof CandidateCaptureInfrastructureError) {
          const candidate = await this.dependencies.git.verifyCandidateRef(
            current.attempt.id,
            current.attempt.baseCommit
          );
          if (candidate) {
            return this.dependencies.persistence.recordDevelopmentCandidate({
              attemptId: current.attempt.id,
              candidateCommit: candidate.commit,
              candidateRef: candidate.ref,
              leaseGeneration: current.attempt.leaseGeneration,
              now: new Date(),
              runnerId: this.dependencies.runnerId,
              safeSummary: "Candidate reconciled after uncertain trusted Git capture"
            });
          }
        }
        if (!current.attempt.fixIteration) {
          const latest = await this.dependencies.persistence.getDevelopmentAttempt(
            current.attempt.id
          );
          if (latest?.status === "succeeded") throw error;
          const failureClass = error instanceof DevelopmentBudgetError
            ? "budget_exhausted"
            : error instanceof z.ZodError
              ? "validation"
              : "execution";
          try {
            await this.dependencies.persistence.transitionDevelopmentAttempt({
              attemptId: current.attempt.id,
              attemptStatus: "failed",
              failureClass,
              leaseGeneration: current.attempt.leaseGeneration,
              now: new Date(),
              runnerId: this.dependencies.runnerId,
              safeSummary: "Phase 2A attempt terminated without a candidate",
              taskStatus: "failed"
            });
          } catch (transitionError) {
            if (!(transitionError instanceof DevelopmentLeaseError)) throw transitionError;
          }
          throw error;
        }
        const reason = error instanceof NeedsHumanProposal
          ? error.reason
          : error instanceof DeterministicTestError
            ? "deterministic_test_failure"
            : error instanceof NonConvergenceError
              ? "non_convergence"
              : error instanceof DevelopmentBudgetError
              ? "execution_budget_exhausted"
              : error instanceof z.ZodError
                ? "context_unavailable"
                : undefined;
        if (reason) {
          return this.dependencies.persistence.markDevelopmentNeedsHuman({
            attemptId: current.attempt.id,
            failureClass: (error as Error).constructor.name,
            leaseGeneration: current.attempt.leaseGeneration,
            reason,
            runnerId: this.dependencies.runnerId
          });
        }
        if (current.attempt.infrastructureRetryCount < 2) {
          if (!await this.dependencies.persistence.lastDevelopmentTeardownSucceeded(
            current.attempt.id
          )) {
            return this.dependencies.persistence.markDevelopmentNeedsHuman({
              attemptId: current.attempt.id,
              failureClass: "workspace_cleanup_failed",
              leaseGeneration: current.attempt.leaseGeneration,
              reason: "durable_integrity_failure",
              runnerId: this.dependencies.runnerId
            });
          }
          const retried = await this.dependencies.persistence.prepareDevelopmentInfrastructureRetry({
            attemptId: current.attempt.id,
            failureClass:
              error instanceof InfrastructureExecutionError ? error.failureClass : "infrastructure",
            leaseDurationMs: policy.leaseDurationMs,
            leaseGeneration: current.attempt.leaseGeneration,
            runnerId: this.dependencies.runnerId
          });
          current = { ...current, attempt: retried.attempt, task: retried.task };
          continue;
        }
        return this.dependencies.persistence.markDevelopmentNeedsHuman({
          attemptId: current.attempt.id,
          failureClass: "infrastructure_retry_exhausted",
          leaseGeneration: current.attempt.leaseGeneration,
          reason: "infrastructure_retry_exhausted",
          runnerId: this.dependencies.runnerId
        });
      }
    }
  }

  private async executeClaimed(claimed: ClaimedDevelopment, policy: DevelopmentRunPolicy) {
    const { attempt, sourceReview, task } = claimed;
    const fence = {
      attemptId: attempt.id,
      leaseGeneration: attempt.leaseGeneration,
      runnerId: this.dependencies.runnerId
    };
    let taskStatus: DevelopmentTaskStatus = "preparing";
    let workspace: SandboxWorkspace | undefined;
    let executionId: string | undefined;
    const heartbeatAbort = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      void this.dependencies.persistence
        .renewDevelopmentLease({
          ...fence,
          leaseDurationMs: policy.leaseDurationMs,
          now: new Date()
        })
        .catch((error: unknown) => {
          heartbeatFailure = error;
          heartbeatAbort.abort();
        });
    }, Math.max(250, Math.floor(policy.leaseDurationMs / 3)));
    const ensureHeartbeat = () => {
      if (heartbeatFailure) throw heartbeatFailure;
    };
    const appendEvent = (
      kind: "harness" | "tool" | "test" | "git" | "budget" | "teardown",
      status: "started" | "success" | "failed" | "unknown" | "blocked",
      safeMetadata: JsonObject = {}
    ) => this.dependencies.persistence.appendDevelopmentAttemptEvent({
      ...fence,
      kind,
      now: new Date(),
      safeMetadata,
      status
    });

    try {
      const storedPolicy = attempt.fixIteration
        ? developmentImplementerContextPolicySchema.parse(attempt.contextPolicy)
        : {
            allowedPaths: [...policy.allowedPaths],
            forbiddenPaths: [...policy.forbiddenPaths],
            relevantPaths: [...policy.relevantPaths]
          };
      const context = await this.dependencies.contextCompiler.compile({
        acceptanceCriteria: task.acceptanceCriteria,
        allowedPaths: storedPolicy.allowedPaths,
        authorityBaseCommit: task.baseCommit,
        baseCommit: attempt.baseCommit,
        budget: attempt.budget,
        ...(attempt.fixIteration
          ? {
              fix: {
                findings: sourceReview!.findings,
                iteration: attempt.fixIteration,
                sourceReviewId: sourceReview!.id
              }
            }
          : {}),
        forbiddenPaths: storedPolicy.forbiddenPaths,
        relevantPaths: [
          ...new Set([
            ...storedPolicy.relevantPaths,
            ...(sourceReview?.findings.flatMap((finding) =>
              finding.relevantPath ? [finding.relevantPath] : []
            ) ?? [])
          ])
        ],
        specification: task.approvedSpec,
        taskTitle: task.title,
        usage: attempt.usage
      });
      await this.dependencies.persistence.saveDevelopmentContext({
        ...fence,
        contextDigest: context.digest,
        contextManifest: context.manifest,
        now: new Date()
      });
      ensureHeartbeat();

      const workspacePath = await this.dependencies.git.createWorktree(attempt.id, attempt.baseCommit);
      workspace = this.dependencies.sandboxManager.identify({
        sandboxId: attempt.sandboxId,
        workspacePath
      });
      workspace = await this.dependencies.sandboxManager.create({
        sandboxId: attempt.sandboxId,
        workspacePath
      });
      await this.dependencies.git.verifyWorkspaceBase(workspace.path, attempt.baseCommit);
      await this.dependencies.persistence.transitionDevelopmentAttempt({
        ...fence,
        attemptStatus: "implementing",
        now: new Date(),
        safeMetadata: { sandbox_id: attempt.sandboxId },
        taskStatus: "implementing"
      });
      taskStatus = "implementing";

      const gateway = new SandboxGateway({
        allowedPaths: storedPolicy.allowedPaths,
        budget: policy.budget,
        ...(attempt.fixIteration ? { fix: true } : {}),
        forbiddenPaths: storedPolicy.forbiddenPaths,
        git: this.dependencies.git,
        knownSecrets: this.dependencies.knownSecrets ?? [],
        onAudit: ({ safeMetadata, status, tool }) =>
          appendEvent("tool", status, { ...safeMetadata, tool }).then(() => undefined),
        onUsage: (delta) =>
          this.dependencies.persistence.recordDevelopmentUsage({
            ...fence,
            delta,
            now: new Date()
          }).then(() => undefined),
        sandboxManager: this.dependencies.sandboxManager,
        workspace
      });
      const execution = await this.dependencies.harness.execute({
        attemptId: attempt.id,
        budget: policy.budget,
        context,
        modelProfile: policy.modelProfile,
        role: "implementer",
        signal: heartbeatAbort.signal,
        tools: gateway
      });
      executionId = execution.executionId;
      let completionProposed = false;
      for await (const event of execution.events) {
        ensureHeartbeat();
        if (event.kind === "usage") {
          await this.dependencies.persistence.recordDevelopmentUsage({
            ...fence,
            delta: event.delta,
            now: new Date()
          });
        } else if (event.kind === "failed") {
          await appendEvent("harness", "failed", { failure_class: event.failureClass });
          throw new InfrastructureExecutionError(event.failureClass);
        } else if (event.kind === "completed") {
          if (event.result === "needs_human_proposed") throw new NeedsHumanProposal(event.reason);
          if (event.result !== "completion_proposed") {
            throw new InfrastructureExecutionError("malformed_output");
          }
          completionProposed = true;
          await appendEvent("harness", "success", { result: event.result });
        } else if (event.kind === "tool") {
          await appendEvent("harness", event.status, { tool: event.tool });
        } else {
          await appendEvent("harness", "started", event.safeMetadata);
        }
      }
      if (!completionProposed) throw new InfrastructureExecutionError("malformed_output");
      await this.dependencies.harness.abort(execution.executionId);
      executionId = undefined;
      ensureHeartbeat();

      await this.dependencies.persistence.transitionDevelopmentAttempt({
        ...fence,
        attemptStatus: "testing",
        now: new Date(),
        taskStatus: "testing"
      });
      taskStatus = "testing";
      await stat(workspace.path);
      await this.dependencies.git.verifyWorkspaceBase(workspace.path, attempt.baseCommit);
      await this.dependencies.git.verifyWorkspaceSize(workspace.path, policy.budget.maxWorkspaceBytes);

      const criteria = developmentAcceptanceCriteriaSchema.parse(task.acceptanceCriteria);
      for (const criterion of criteria) {
        await appendEvent("test", "started", { criterion_id: criterion.id });
        const check = await this.dependencies.sandboxManager.execute(workspace, {
          arguments: criterion.check.arguments,
          executable: criterion.check.executable,
          maxOutputBytes: policy.budget.maxCommandOutputBytes,
          signal: heartbeatAbort.signal,
          timeoutMs: Math.min(criterion.check.timeoutMs, policy.budget.maxCommandMs),
          ...(criterion.check.workingDirectory
            ? { workingDirectory: criterion.check.workingDirectory }
            : {})
        });
        const output = `${check.stdout}${check.stderr}`;
        if (!isSecretFreeText(output, this.dependencies.knownSecrets)) {
          throw new Error("Deterministic check output contained secret material");
        }
        await this.dependencies.persistence.recordDevelopmentUsage({
          ...fence,
          delta: {
            ...emptyDevelopmentUsage(),
            commandMs: check.durationMs,
            commandOutputBytes: Buffer.byteLength(output)
          },
          now: new Date()
        });
        if (check.exitCode !== 0 || check.timedOut || check.outputLimitExceeded) {
          await appendEvent("test", "failed", {
            criterion_id: criterion.id,
            duration_ms: check.durationMs,
            exit_code: check.exitCode
          });
          if (attempt.fixIteration) throw new DeterministicTestError();
          throw new Error(`Deterministic acceptance check failed: ${criterion.id}`);
        }
        await appendEvent("test", "success", {
          criterion_id: criterion.id,
          duration_ms: check.durationMs,
          exit_code: check.exitCode
        });
      }
      ensureHeartbeat();

      await this.dependencies.persistence.transitionDevelopmentAttempt({
        ...fence,
        attemptStatus: "capturing_candidate",
        now: new Date(),
        taskStatus: "testing"
      });
      const candidateWorkspace = workspace;
      const result = await this.dependencies.persistence.captureDevelopmentCandidate({
        ...fence,
        capture: async () => {
          let candidate;
          try {
            candidate = await this.dependencies.git.captureCandidate({
              allowedPaths: storedPolicy.allowedPaths,
              attemptId: attempt.id,
              baseCommit: attempt.baseCommit,
              forbiddenPaths: storedPolicy.forbiddenPaths,
              maxDiffBytes: policy.budget.maxDiffBytes,
              workspacePath: candidateWorkspace.path
            });
          } catch (error) {
            if (error instanceof Error && error.message === "Candidate diff is empty") {
              throw new NonConvergenceError(error.message);
            }
            throw new CandidateCaptureInfrastructureError(
              error instanceof Error ? error.name : "git_capture"
            );
          }
          const verified = await this.dependencies.git.verifyCandidateRef(
            attempt.id,
            attempt.baseCommit,
            candidate.commit
          );
          if (!verified) {
            throw new CandidateCaptureInfrastructureError("candidate_ref_unavailable");
          }
          return { candidateCommit: candidate.commit, candidateRef: candidate.ref };
        },
        now: new Date(),
        safeSummary: attempt.fixIteration
          ? `Phase 2C fix candidate ${attempt.fixIteration} captured after deterministic checks`
          : "Candidate captured after deterministic Phase 2A checks"
      });
      taskStatus = "candidate_ready";
      return result;
    } finally {
      clearInterval(heartbeat);
      heartbeatAbort.abort();
      if (executionId) await this.dependencies.harness.abort(executionId).catch(() => undefined);
      if (workspace) {
        let teardownStatus: "success" | "failed" = "success";
        try {
          await this.dependencies.sandboxManager.teardown(workspace);
          await this.dependencies.git.removeWorktree(workspace.path);
        } catch {
          teardownStatus = "failed";
        }
        try {
          await appendEvent("teardown", teardownStatus, {
            sandbox_id: attempt.sandboxId,
            task_status: taskStatus
          });
        } catch (error) {
          if (!(error instanceof DevelopmentLeaseError)) throw error;
        }
      }
    }
  }

  async recoverOne(leaseDurationMs: number) {
    const attempt = await this.dependencies.persistence.reclaimExpiredDevelopmentAttempt({
      leaseDurationMs,
      now: new Date(),
      runnerId: this.dependencies.runnerId
    });
    if (!attempt) return undefined;
    let candidate;
    try {
      candidate = await this.dependencies.git.verifyCandidateRef(
        attempt.id,
        attempt.baseCommit
      );
    } catch {
      return this.dependencies.persistence.markDevelopmentNeedsHuman({
        attemptId: attempt.id,
        failureClass: "candidate_binding_invalid",
        leaseGeneration: attempt.leaseGeneration,
        reason: "candidate_binding_invalid",
        runnerId: this.dependencies.runnerId
      });
    }
    if (candidate) {
      // A captured candidate is durable authority; disposable worker resources are not.
      return this.dependencies.persistence.reconcileDevelopmentCandidate({
        attemptId: attempt.id,
        candidateCommit: candidate.commit,
        candidateRef: candidate.ref,
        leaseGeneration: attempt.leaseGeneration,
        now: new Date(),
        runnerId: this.dependencies.runnerId,
        safeSummary: "Candidate reconciled from the trusted attempt ref after interruption"
      });
    }
    if (attempt.fixIteration) {
      return this.dependencies.persistence.markDevelopmentNeedsHuman({
        attemptId: attempt.id,
        failureClass: "execution_interrupted",
        leaseGeneration: attempt.leaseGeneration,
        reason: "durable_integrity_failure",
        runnerId: this.dependencies.runnerId
      });
    }
    return { attempt, candidate };
  }

  async verifyDurableCandidate(attemptId: string): Promise<boolean> {
    const attempt = await this.dependencies.persistence.getDevelopmentAttempt(attemptId);
    if (!attempt?.candidateCommit || !attempt.candidateRef) return false;
    try {
      const candidate = await this.dependencies.git.verifyCandidateRef(
        attempt.id,
        attempt.baseCommit,
        attempt.candidateCommit
      );
      if (candidate?.ref === attempt.candidateRef) return true;
    } catch {
      // The deterministic transition below owns the safe integrity response.
    }
    await this.dependencies.persistence.blockDevelopmentCandidateIntegrity({
      attemptId: attempt.id,
      now: new Date()
    });
    return false;
  }
}
