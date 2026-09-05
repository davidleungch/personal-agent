import { createHash } from "node:crypto";
import {
  developmentNeedsHumanReasonSchema,
  developmentReviewResultSchema,
  type DevelopmentNeedsHumanReason,
  type DevelopmentReviewFinding
} from "@personal-agent/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import {
  developmentAttempts,
  developmentReviews,
  developmentTasks
} from "./schema.js";
import { DevelopmentTransitionError } from "./development-repositories.js";

const uuidSchema = z.string().uuid();

function fingerprint(finding: DevelopmentReviewFinding): string {
  const normalized = Object.fromEntries(
    Object.entries(finding).map(([key, value]) => [
      key,
      (value as string).trim().replace(/\s+/g, " ").toLowerCase()
    ])
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function blockingFingerprints(findings: readonly DevelopmentReviewFinding[]): Set<string> {
  return new Set(
    findings
      .filter((finding) => finding.severity === "critical" || finding.severity === "high")
      .map(fingerprint)
  );
}

function blockingFindingCount(findings: readonly DevelopmentReviewFinding[]): number {
  return findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high"
  ).length;
}

function nonConvergenceReason(
  history: ReadonlyArray<{ findings: DevelopmentReviewFinding[] }>
): DevelopmentNeedsHumanReason | undefined {
  const current = history.at(-1)!;
  const currentBlocking = blockingFingerprints(current.findings);
  if (currentBlocking.size === 0) return "minor_only_rejection";
  const previous = history.at(-2);
  if (!previous) return undefined;
  const previousBlocking = blockingFingerprints(previous.findings);
  if ([...currentBlocking].some((value) => previousBlocking.has(value))) {
    return "non_convergence";
  }
  if (blockingFindingCount(current.findings) > blockingFindingCount(previous.findings)) {
    return "non_convergence";
  }
  const older = new Set(
    history.slice(0, -2).flatMap((review) => [...blockingFingerprints(review.findings)])
  );
  return [...currentBlocking].some((value) => older.has(value))
    ? "non_convergence"
    : undefined;
}

export function createFixLoopRepositories(database: Database) {
  return {
    findCurrentReviewForReconciliation: async () => {
      const rows = await database
        .select({ attempt: developmentAttempts, review: developmentReviews, task: developmentTasks })
        .from(developmentTasks)
        .innerJoin(developmentAttempts, eq(developmentAttempts.taskId, developmentTasks.id))
        .innerJoin(
          developmentReviews,
          eq(developmentReviews.implementerAttemptId, developmentAttempts.id)
        )
        .where(
          and(
            eq(developmentTasks.status, "candidate_ready"),
            isNull(developmentTasks.authorityInvalidatedAt),
            eq(developmentAttempts.status, "succeeded"),
            isNull(developmentAttempts.failureClass),
            sql`not exists (
              select 1 from development_attempts later_attempt
              where later_attempt.task_id = ${developmentTasks.id}
                and later_attempt.attempt_number > ${developmentAttempts.attemptNumber}
            )`,
            eq(developmentReviews.status, "succeeded"),
            isNull(developmentReviews.failureClass)
          )
        )
        .orderBy(asc(developmentTasks.createdAt), desc(developmentAttempts.attemptNumber))
        .limit(1);
      return rows[0];
    },

    getConsumedSourceReview: async (reviewId: string) => {
      const [row] = await database
        .select({ consumer: developmentAttempts, review: developmentReviews })
        .from(developmentAttempts)
        .innerJoin(developmentReviews, eq(developmentReviews.id, developmentAttempts.sourceReviewId))
        .innerJoin(
          developmentTasks,
          eq(developmentTasks.id, developmentAttempts.taskId)
        )
        .where(eq(developmentReviews.id, uuidSchema.parse(reviewId)))
        .limit(1);
      if (
        !row ||
        row.review.status !== "succeeded" ||
        row.review.decision !== "REQUEST_CHANGES" ||
        row.consumer.taskId !== row.review.taskId ||
        row.consumer.parentCandidateCommit !== row.review.candidateCommit
      ) {
        return undefined;
      }
      return { attempt: row.consumer, review: row.review };
    },

    getReconciledReview: async (taskId: string) => {
      const [task] = await database
        .select()
        .from(developmentTasks)
        .where(eq(developmentTasks.id, uuidSchema.parse(taskId)))
        .limit(1);
      if (!task || !["approved_candidate", "fix_required", "needs_human"].includes(task.status)) {
        return undefined;
      }
      const [attempt] = await database
        .select()
        .from(developmentAttempts)
        .where(eq(developmentAttempts.taskId, task.id))
        .orderBy(desc(developmentAttempts.attemptNumber))
        .limit(1);
      if (!attempt?.candidateCommit) return undefined;
      const [review] = await database
        .select()
        .from(developmentReviews)
        .where(eq(developmentReviews.implementerAttemptId, attempt.id))
        .limit(1);
      return review?.status === "succeeded" ? { attempt, review, task } : undefined;
    },

    reconcileCurrentReview: async (input: {
      equivalentCandidate?: boolean;
      reviewId: string;
    }) => {
      const reviewId = uuidSchema.parse(input.reviewId);
      const [identity] = await database
        .select({ taskId: developmentReviews.taskId })
        .from(developmentReviews)
        .where(eq(developmentReviews.id, reviewId))
        .limit(1);
      if (!identity) throw new DevelopmentTransitionError("Review does not exist");

      return database.transaction(async (transaction) => {
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.id, identity.taskId))
          .limit(1)
          .for("update");
        const clock = await transaction.execute<{ databaseNow: Date }>(
          sql`select clock_timestamp() as "databaseNow"`
        );
        const databaseNow = z.coerce.date().parse(clock.rows[0]?.databaseNow);
        const [attemptIdentity] = await transaction
          .select({ id: developmentReviews.implementerAttemptId })
          .from(developmentReviews)
          .where(eq(developmentReviews.id, reviewId))
          .limit(1);
        const [attempt] = await transaction
          .select()
          .from(developmentAttempts)
          .where(eq(developmentAttempts.id, attemptIdentity!.id))
          .limit(1)
          .for("update");
        const [review] = await transaction
          .select()
          .from(developmentReviews)
          .where(eq(developmentReviews.id, reviewId))
          .limit(1)
          .for("update");
        const [latest] = await transaction
          .select()
          .from(developmentAttempts)
          .where(eq(developmentAttempts.taskId, task!.id))
          .orderBy(desc(developmentAttempts.attemptNumber))
          .limit(1);

        if (
          task?.status !== "candidate_ready" ||
          task.authorityInvalidatedAt ||
          review?.status !== "succeeded" ||
          review.failureClass ||
          !review.finalizedAt ||
          !attempt ||
          attempt.id !== latest?.id ||
          attempt.status !== "succeeded" ||
          attempt.failureClass ||
          attempt.candidateCommit !== review.candidateCommit ||
          attempt.candidateRef !== review.candidateRef ||
          attempt.taskId !== task.id
        ) {
          throw new DevelopmentTransitionError(
            "Finalized review is not current and authoritative for reconciliation"
          );
        }
        const result = developmentReviewResultSchema.parse({
          decision: review.decision,
          findings: review.findings
        });
        let status: "approved_candidate" | "fix_required" | "needs_human";
        let reason: DevelopmentNeedsHumanReason | undefined;
        if (result.decision === "APPROVE") {
          status = "approved_candidate";
        } else {
          const historyRows = await transaction
            .select({ findings: developmentReviews.findings })
            .from(developmentReviews)
            .innerJoin(
              developmentAttempts,
              eq(developmentAttempts.id, developmentReviews.implementerAttemptId)
            )
            .where(
              and(
                eq(developmentReviews.taskId, task.id),
                eq(developmentReviews.status, "succeeded"),
                eq(developmentReviews.decision, "REQUEST_CHANGES")
              )
            )
            .orderBy(asc(developmentAttempts.attemptNumber));
          reason = attempt.fixIteration === 3
            ? "fix_iteration_exhausted"
            : input.equivalentCandidate
              ? "non_convergence"
              : nonConvergenceReason(historyRows);
          status = reason ? "needs_human" : "fix_required";
        }
        const [updated] = await transaction
          .update(developmentTasks)
          .set({
            needsHumanReason: reason
              ? developmentNeedsHumanReasonSchema.parse(reason)
              : null,
            status,
            updatedAt: databaseNow
          })
          .where(eq(developmentTasks.id, task.id))
          .returning();
        return { attempt, review, task: updated! };
      });
    }
  };
}
