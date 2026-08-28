import { stat } from "node:fs/promises";
import {
  DevelopmentBudgetError,
  DevelopmentLeaseError,
  createDevelopmentRepositories
} from "@personal-agent/db";
import {
  developmentAcceptanceCriteriaSchema,
  developmentBudgetSchema,
  emptyDevelopmentUsage,
  isSecretFreeText,
  modelProfileSchema,
  type DevelopmentBudget,
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

  async runOne(policyInput: DevelopmentRunPolicy) {
    const policy = {
      ...policyInput,
      budget: developmentBudgetSchema.parse(policyInput.budget),
      modelProfile: modelProfileSchema.parse(policyInput.modelProfile)
    };
    const claimed = await this.dependencies.persistence.claimReadyDevelopmentTask({
      budget: policy.budget,
      leaseDurationMs: policy.leaseDurationMs,
      modelProfile: policy.modelProfile,
      now: new Date(),
      runnerId: this.dependencies.runnerId
    });
    if (!claimed) return undefined;

    const { attempt, task } = claimed;
    const fence = {
      attemptId: attempt.id,
      leaseGeneration: attempt.leaseGeneration,
      runnerId: this.dependencies.runnerId
    };
    let taskStatus: DevelopmentTaskStatus = "preparing";
    let workspace: SandboxWorkspace | undefined;
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
    ) =>
      this.dependencies.persistence.appendDevelopmentAttemptEvent({
        ...fence,
        kind,
        now: new Date(),
        safeMetadata,
        status
      });

    try {
      const context = await this.dependencies.contextCompiler.compile({
        acceptanceCriteria: task.acceptanceCriteria,
        allowedPaths: policy.allowedPaths,
        baseCommit: task.baseCommit,
        budget: attempt.budget,
        forbiddenPaths: policy.forbiddenPaths,
        relevantPaths: policy.relevantPaths,
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

      const workspacePath = await this.dependencies.git.createWorktree(attempt.id, task.baseCommit);
      workspace = this.dependencies.sandboxManager.identify({
        sandboxId: attempt.sandboxId,
        workspacePath
      });
      workspace = await this.dependencies.sandboxManager.create({
        sandboxId: attempt.sandboxId,
        workspacePath
      });
      await this.dependencies.git.verifyWorkspaceBase(workspace.path, task.baseCommit);
      await this.dependencies.persistence.transitionDevelopmentAttempt({
        ...fence,
        attemptStatus: "implementing",
        now: new Date(),
        safeMetadata: { sandbox_id: attempt.sandboxId },
        taskStatus: "implementing"
      });
      taskStatus = "implementing";

      const gateway = new SandboxGateway({
        allowedPaths: policy.allowedPaths,
        budget: policy.budget,
        forbiddenPaths: policy.forbiddenPaths,
        git: this.dependencies.git,
        knownSecrets: this.dependencies.knownSecrets ?? [],
        onAudit: ({ safeMetadata, status, tool }) =>
          appendEvent("tool", status, { ...safeMetadata, tool }).then(() => undefined),
        onUsage: (delta) =>
          this.dependencies.persistence
            .recordDevelopmentUsage({ ...fence, delta, now: new Date() })
            .then(() => undefined),
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
          throw new Error(`Development harness failed: ${event.failureClass}`);
        } else if (event.kind === "completed") {
          completionProposed = true;
          await appendEvent("harness", "success", { result: event.result });
        } else if (event.kind === "tool") {
          await appendEvent("harness", event.status, { tool: event.tool });
        } else {
          await appendEvent("harness", "started", event.safeMetadata);
        }
      }
      if (!completionProposed) throw new Error("Harness ended without a completion proposal");
      await this.dependencies.harness.abort(execution.executionId);
      ensureHeartbeat();

      await this.dependencies.persistence.transitionDevelopmentAttempt({
        ...fence,
        attemptStatus: "testing",
        now: new Date(),
        taskStatus: "testing"
      });
      taskStatus = "testing";
      await stat(workspace.path);
      await this.dependencies.git.verifyWorkspaceBase(workspace.path, task.baseCommit);
      await this.dependencies.git.verifyWorkspaceSize(
        workspace.path,
        policy.budget.maxWorkspaceBytes
      );

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
          const candidate = await this.dependencies.git.captureCandidate({
            allowedPaths: policy.allowedPaths,
            attemptId: attempt.id,
            baseCommit: task.baseCommit,
            forbiddenPaths: policy.forbiddenPaths,
            maxDiffBytes: policy.budget.maxDiffBytes,
            workspacePath: candidateWorkspace.path
          });
          const verified = await this.dependencies.git.verifyCandidateRef(
            attempt.id,
            task.baseCommit,
            candidate.commit
          );
          if (!verified) throw new Error("Trusted candidate ref disappeared before persistence");
          return { candidateCommit: candidate.commit, candidateRef: candidate.ref };
        },
        now: new Date(),
        safeSummary: "Candidate captured after deterministic Phase 2A checks"
      });
      taskStatus = "candidate_ready";
      return result;
    } catch (error) {
      if (
        !(error instanceof DevelopmentLeaseError) &&
        !heartbeatFailure
      ) {
        const failureClass =
          error instanceof DevelopmentBudgetError
            ? "budget_exhausted"
            : error instanceof z.ZodError
              ? "validation"
              : "execution";
        try {
          await this.dependencies.persistence.transitionDevelopmentAttempt({
            ...fence,
            attemptStatus: "failed",
            failureClass,
            now: new Date(),
            safeSummary: "Phase 2A attempt terminated without a candidate",
            taskStatus: "failed"
          });
          taskStatus = "failed";
        } catch (transitionError) {
          if (!(transitionError instanceof DevelopmentLeaseError)) throw transitionError;
        }
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      heartbeatAbort.abort();
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
    const candidate = await this.dependencies.git.verifyCandidateRef(
      attempt.id,
      attempt.baseCommit
    );
    const workspacePath = this.dependencies.git.workspacePath(attempt.id);
    const workspace = this.dependencies.sandboxManager.identify({
      sandboxId: attempt.sandboxId,
      workspacePath
    });
    if (candidate) {
      await this.dependencies.persistence.reconcileDevelopmentCandidate({
        attemptId: attempt.id,
        candidateCommit: candidate.commit,
        candidateRef: candidate.ref,
        leaseGeneration: attempt.leaseGeneration,
        now: new Date(),
        runnerId: this.dependencies.runnerId,
        safeSummary: "Candidate reconciled from the trusted attempt ref after interruption"
      });
    }
    await this.dependencies.sandboxManager.teardown(workspace);
    await this.dependencies.git.removeWorktree(workspace.path);
    await this.dependencies.persistence.appendDevelopmentAttemptEvent({
      attemptId: attempt.id,
      kind: "teardown",
      leaseGeneration: attempt.leaseGeneration,
      now: new Date(),
      runnerId: this.dependencies.runnerId,
      safeMetadata: { recovery: true, sandbox_id: attempt.sandboxId },
      status: "success"
    });
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
