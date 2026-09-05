import {
  createDevelopmentRepositories,
  createFixLoopRepositories
} from "@personal-agent/db";
import { TrustedGit } from "./git.js";

type FixPersistence = ReturnType<typeof createFixLoopRepositories>;
type DevelopmentPersistence = ReturnType<typeof createDevelopmentRepositories>;

export class FixLoopCoordinator {
  constructor(
    private readonly dependencies: {
      developmentPersistence: DevelopmentPersistence;
      git: TrustedGit;
      persistence: FixPersistence;
    }
  ) {}

  async reconcileOne() {
    const current = await this.dependencies.persistence.findCurrentReviewForReconciliation();
    if (!current) {
      // A process can die after reconciliation and before the fix starts.
      return this.dependencies.persistence.markStrandedFixRequired();
    }
    const candidate = await this.dependencies.git.verifyCandidateRef(
      current.attempt.id,
      current.attempt.baseCommit,
      current.attempt.candidateCommit!
    );
    const retained = await this.dependencies.git.verifyReviewRetentionRef(
      current.review.id,
      current.review.candidateCommit
    );
    if (!candidate || !retained || candidate.ref !== current.review.candidateRef) {
      await this.dependencies.developmentPersistence.blockDevelopmentCandidateIntegrity({
        attemptId: current.attempt.id,
        now: new Date()
      });
      throw new Error("Current candidate/review Git authority is unavailable for reconciliation");
    }
    const currentTree = await this.dependencies.git.treeId(current.review.candidateCommit);
    const attempts = await this.dependencies.developmentPersistence.listDevelopmentAttempts(
      current.task.id
    );
    let equivalentCandidate = false;
    for (const attempt of attempts) {
      if (attempt.id === current.attempt.id) continue;
      if (await this.dependencies.git.treeId(attempt.candidateCommit!) === currentTree) {
        equivalentCandidate = true;
        break;
      }
    }
    return this.dependencies.persistence.reconcileCurrentReview({
      equivalentCandidate,
      reviewId: current.review.id
    });
  }
}

export async function runBoundedFixLoop(input: {
  reconcile: () => Promise<
    | undefined
    | { task: { id: string; status: string } }
  >;
  runFix: (taskId: string) => Promise<unknown>;
  runReview: (taskId: string) => Promise<unknown>;
}) {
  for (let step = 0; step < 4; step += 1) {
    const reconciled = await input.reconcile();
    if (!reconciled) return undefined;
    if (["approved_candidate", "needs_human", "blocked"].includes(reconciled.task.status)) {
      return reconciled;
    }
    if (reconciled.task.status !== "fix_required") {
      throw new Error("Phase 2C reconciliation produced an invalid next state");
    }
    if (step === 3) throw new Error("Phase 2C deterministic loop bound was exceeded");
    const fixed = await input.runFix(reconciled.task.id) as { task?: { status?: string } } | undefined;
    if (fixed?.task && ["approved_candidate", "needs_human", "blocked"].includes(fixed.task.status ?? "")) {
      return fixed;
    }
    await input.runReview(reconciled.task.id);
  }
  throw new Error("Phase 2C deterministic loop bound was exceeded");
}
