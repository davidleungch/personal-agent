import { randomUUID } from "node:crypto";
import {
  createSecretFreeJsonSchema,
  createSecretFreeTextSchema,
  developmentAcceptanceCriteriaSchema,
  developmentBudgetSchema,
  developmentEventStatusSchema,
  developmentNeedsHumanReasonSchema,
  developmentReviewerContextManifestSchema,
  developmentReviewerContextPolicySchema,
  developmentReviewEventKindSchema,
  developmentReviewResultSchema,
  developmentUsageSchema,
  emptyDevelopmentUsage,
  gitObjectIdSchema,
  isDurableJson,
  modelProfileSchema,
  redactText,
  type DevelopmentBudget,
  type DevelopmentReviewResult,
  type DevelopmentUsage,
  type JsonObject
} from "@personal-agent/shared";
import { and, asc, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import { DevelopmentBudgetError, DevelopmentLeaseError, DevelopmentTransitionError } from "./development-repositories.js";
import {
  developmentAttemptEvents,
  developmentAttempts,
  developmentReviewEvents,
  developmentReviews,
  developmentTasks
} from "./schema.js";

const uuidSchema = z.string().uuid();
const positiveDurationSchema = z.number().int().positive();

type ReviewTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function leaseExpiry(databaseNow: Date, durationMs: number): Date {
  return new Date(databaseNow.getTime() + positiveDurationSchema.parse(durationMs));
}

async function freshDatabaseTime(transaction: ReviewTransaction): Promise<Date> {
  const result = await transaction.execute<{ databaseNow: Date }>(
    sql`select clock_timestamp() as "databaseNow"`
  );
  return z.coerce.date().parse(result.rows[0]?.databaseNow);
}

function reviewTaskAuthorityInvalidated(task: { authorityInvalidatedAt: Date | null; status: string } | undefined): boolean {
  return task?.authorityInvalidatedAt !== null || task?.status === "blocked";
}

function addUsage(current: DevelopmentUsage, delta: DevelopmentUsage): DevelopmentUsage {
  return {
    commandMs: current.commandMs + delta.commandMs,
    commandOutputBytes: current.commandOutputBytes + delta.commandOutputBytes,
    costUsdMicros: current.costUsdMicros + delta.costUsdMicros,
    inputTokens: current.inputTokens + delta.inputTokens,
    modelInvocations: current.modelInvocations + delta.modelInvocations,
    outputTokens: current.outputTokens + delta.outputTokens,
    toolCalls: current.toolCalls + delta.toolCalls
  };
}

function usageWithinBudget(usage: DevelopmentUsage, budget: DevelopmentBudget): boolean {
  return (
    usage.modelInvocations <= budget.maxModelInvocations &&
    usage.inputTokens + usage.outputTokens <= budget.maxTokens &&
    usage.costUsdMicros <= budget.maxCostUsdMicros &&
    usage.toolCalls <= budget.maxToolCalls &&
    usage.commandOutputBytes <= budget.maxCommandOutputBytes &&
    usage.commandMs <= budget.maxWallClockMs
  );
}

export type ReviewRepositoryTestHooks = {
  afterClaimExistingLock?: (reviewId: string) => Promise<void>;
  afterFinalizeLock?: (reviewId: string) => Promise<void>;
  afterReclaimLock?: (reviewId: string) => Promise<void>;
};

export function createReviewRepositories(
  database: Database,
  knownSecrets: readonly string[] = [],
  testHooks: ReviewRepositoryTestHooks = {}
) {
  const secretFreeText = createSecretFreeTextSchema(knownSecrets);
  const shortText = secretFreeText.trim().min(1).max(500);
  const safeMetadataSchema = createSecretFreeJsonSchema(knownSecrets)
    .refine((value) => JSON.stringify(value).length <= 8_192, "Safe metadata is too large")
    .refine(isDurableJson, "Unsafe durable metadata is not allowed");
  const safeReviewResultSchema = developmentReviewResultSchema.refine(
    (value) => secretFreeText.safeParse(JSON.stringify(value)).success,
    "Review result contains unsafe durable data"
  );
  const fenceSchema = z.object({
    leaseGeneration: z.number().int().positive(),
    reviewId: uuidSchema,
    runnerId: shortText
  });

  // Canonical overlapping-row order: task -> attempt -> review.
  async function lockedReview(
    transaction: ReviewTransaction,
    input: z.infer<typeof fenceSchema>
  ) {
    const [identity] = await transaction
      .select({ taskId: developmentReviews.taskId, attemptId: developmentReviews.implementerAttemptId })
      .from(developmentReviews)
      .where(eq(developmentReviews.id, input.reviewId))
      .limit(1);
    const [task] = await transaction
      .select()
      .from(developmentTasks)
      .where(eq(developmentTasks.id, identity!.taskId))
      .limit(1)
      .for("update");
    const [attempt] = await transaction
      .select()
      .from(developmentAttempts)
      .where(eq(developmentAttempts.id, identity!.attemptId))
      .limit(1)
      .for("update");
    const review = (await transaction
      .select()
      .from(developmentReviews)
      .where(eq(developmentReviews.id, input.reviewId))
      .limit(1)
      .for("update"))[0]!;
    const databaseNow = await freshDatabaseTime(transaction);
    if (
      review!.leaseOwner !== input.runnerId ||
      review.leaseGeneration !== input.leaseGeneration ||
      review.leaseExpiresAt <= databaseNow
    ) {
      throw new DevelopmentLeaseError("Development review lease is not current");
    }
    return { attempt, databaseNow, review, task };
  }

  async function insertEvent(
    transaction: ReviewTransaction,
    input: {
      createdAt: Date;
      kind: z.infer<typeof developmentReviewEventKindSchema>;
      reviewId: string;
      safeMetadata: JsonObject;
      status: z.infer<typeof developmentEventStatusSchema>;
    }
  ) {
    const [sequence] = await transaction
      .select({ value: max(developmentReviewEvents.sequence) })
      .from(developmentReviewEvents)
      .where(eq(developmentReviewEvents.reviewId, input.reviewId));
    const [event] = await transaction
      .insert(developmentReviewEvents)
      .values({
        createdAt: input.createdAt,
        id: randomUUID(),
        kind: input.kind,
        reviewId: input.reviewId,
        safeMetadata: input.safeMetadata,
        sequence: (sequence?.value ?? 0) + 1,
        status: input.status
      })
      .returning();
    return event!;
  }

  async function contextInput(reviewId: string) {
    const [row] = await database
      .select({ attempt: developmentAttempts, review: developmentReviews, task: developmentTasks })
      .from(developmentReviews)
      .innerJoin(developmentTasks, eq(developmentTasks.id, developmentReviews.taskId))
      .innerJoin(
        developmentAttempts,
        eq(developmentAttempts.id, developmentReviews.implementerAttemptId)
      )
      .where(eq(developmentReviews.id, uuidSchema.parse(reviewId)))
      .limit(1);
    if (!row) return undefined;
    const events = await database
      .select()
      .from(developmentAttemptEvents)
      .where(eq(developmentAttemptEvents.attemptId, row.attempt.id))
      .orderBy(asc(developmentAttemptEvents.sequence));
    return { ...row, attemptEvents: events };
  }

  const repositories = {
    appendReviewEvent: async (input: {
      kind: z.input<typeof developmentReviewEventKindSchema>;
      leaseGeneration: number;
      now: Date;
      reviewId: string;
      runnerId: string;
      safeMetadata?: JsonObject;
      status: z.input<typeof developmentEventStatusSchema>;
    }) => {
      const fence = fenceSchema.parse(input);
      const kind = developmentReviewEventKindSchema.parse(input.kind);
      const status = developmentEventStatusSchema.parse(input.status);
      const safeMetadata = safeMetadataSchema.parse(input.safeMetadata ?? {});
      return database.transaction(async (transaction) => {
        const { databaseNow } = await lockedReview(transaction, fence);
        return insertEvent(transaction, {
          createdAt: databaseNow,
          kind,
          reviewId: fence.reviewId,
          safeMetadata,
          status
        });
      });
    },

    claimCandidateReadyReview: async (input: {
      budget: unknown;
      contextPolicy: unknown;
      leaseDurationMs: number;
      modelProfile: unknown;
      runnerId: string;
      taskId?: string;
    }) => {
      const value = z.object({
        budget: developmentBudgetSchema,
        contextPolicy: developmentReviewerContextPolicySchema,
        leaseDurationMs: positiveDurationSchema,
        modelProfile: modelProfileSchema,
        runnerId: shortText,
        taskId: uuidSchema.optional()
      }).strict().parse(input);
      return database.transaction(async (transaction) => {
        const taskConditions = [
          eq(developmentTasks.status, "candidate_ready"),
          isNull(developmentTasks.authorityInvalidatedAt),
          sql`(
            not exists (
              select 1
              from development_reviews existing_review
              join development_attempts reviewed_attempt
                on reviewed_attempt.id = existing_review.implementer_attempt_id
              where existing_review.task_id = ${developmentTasks.id}
                and reviewed_attempt.attempt_number = (
                  select max(latest_attempt.attempt_number)
                  from development_attempts latest_attempt
                  where latest_attempt.task_id = ${developmentTasks.id}
                )
            ) or exists (
              select 1
              from development_reviews retry_review
              join development_attempts retry_attempt
                on retry_attempt.id = retry_review.implementer_attempt_id
              where retry_review.task_id = ${developmentTasks.id}
                and retry_attempt.attempt_number = (
                  select max(latest_attempt.attempt_number)
                  from development_attempts latest_attempt
                  where latest_attempt.task_id = ${developmentTasks.id}
                )
                and retry_review.status = 'preparing'
                and retry_review.lease_owner = ${value.runnerId}
                and retry_review.lease_expires_at > clock_timestamp()
            )
          )`
        ];
        if (value.taskId) taskConditions.push(eq(developmentTasks.id, value.taskId));
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(and(...taskConditions))
          .orderBy(asc(developmentTasks.createdAt), asc(developmentTasks.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!task) return undefined;
        const [attempt] = await transaction
          .select()
          .from(developmentAttempts)
          .where(
            and(
              eq(developmentAttempts.taskId, task.id),
              eq(developmentAttempts.role, "implementer"),
              eq(developmentAttempts.status, "succeeded")
            )
          )
          .orderBy(sql`${developmentAttempts.attemptNumber} desc`)
          .limit(1)
          .for("update");
        if (!attempt?.candidateCommit || !attempt.candidateRef || !attempt.contextDigest) {
          throw new DevelopmentTransitionError("Candidate is missing required durable implementation evidence");
        }
        const [existingReview] = await transaction
          .select()
          .from(developmentReviews)
          .where(eq(developmentReviews.implementerAttemptId, attempt.id))
          .limit(1)
          .for("update");
        if (existingReview) {
          await testHooks.afterClaimExistingLock?.(existingReview.id);
          const databaseNow = await freshDatabaseTime(transaction);
          if (
            existingReview.status !== "preparing" ||
            existingReview.leaseOwner !== value.runnerId ||
            existingReview.leaseExpiresAt <= databaseNow
          ) {
            return undefined;
          }
          const attemptEvents = await transaction
            .select()
            .from(developmentAttemptEvents)
            .where(eq(developmentAttemptEvents.attemptId, attempt.id))
            .orderBy(asc(developmentAttemptEvents.sequence));
          return { attempt, review: existingReview, task, attemptEvents };
        }
        const databaseNow = await freshDatabaseTime(transaction);
        const attemptEvents = await transaction
          .select()
          .from(developmentAttemptEvents)
          .where(eq(developmentAttemptEvents.attemptId, attempt.id))
          .orderBy(asc(developmentAttemptEvents.sequence));
        const reviewId = randomUUID();
        const [review] = await transaction
          .insert(developmentReviews)
          .values({
            baseCommit: task.baseCommit,
            budget: value.budget,
            candidateCommit: attempt.candidateCommit,
            candidateRef: attempt.candidateRef,
            cleanupStatus: "pending",
            contextPolicy: value.contextPolicy,
            findings: [],
            harnessAdapter: "pi",
            id: reviewId,
            implementerAttemptId: attempt.id,
            leaseExpiresAt: leaseExpiry(databaseNow, value.leaseDurationMs),
            leaseGeneration: 1,
            infrastructureRetryCount: 0,
            leaseOwner: value.runnerId,
            modelProfile: value.modelProfile,
            retentionRef: `refs/personal-agent/reviews/${reviewId}`,
            role: "reviewer",
            sandboxId: `development-review-${reviewId}`,
            startedAt: databaseNow,
            status: "preparing",
            taskId: task.id,
            updatedAt: databaseNow,
            usage: emptyDevelopmentUsage()
          })
          .returning();
        await insertEvent(transaction, {
          createdAt: review!.startedAt,
          kind: "transition",
          reviewId,
          safeMetadata: { lease_generation: 1, to_status: "preparing" },
          status: "started"
        });
        return { attempt, review: review!, task, attemptEvents };
      });
    },

    completeReviewFailure: async (input: {
      leaseGeneration: number;
      needsHumanReason?: unknown;
      now: Date;
      reviewId: string;
      runnerId: string;
      safeSummary: string;
    }) => {
      const fence = fenceSchema.parse(input);
      return database.transaction(async (transaction) => {
        const { attempt, databaseNow, review, task } = await lockedReview(transaction, fence);
        if (
          review.cleanupStatus !== "succeeded" ||
          !(
            review.status === "interrupted" ||
            (review.status === "finalizing" && review.failureClass)
          )
        ) {
          throw new DevelopmentTransitionError("Review failure cannot finalize in the current state");
        }
        const [updated] = await transaction
          .update(developmentReviews)
          .set({
            completedAt: databaseNow,
            safeSummary: redactText(input.safeSummary, knownSecrets).slice(0, 2_000),
            status: "failed",
            updatedAt: databaseNow
          })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        const needsHumanReason = input.needsHumanReason
          ? developmentNeedsHumanReasonSchema.parse(input.needsHumanReason)
          : undefined;
        if (needsHumanReason && !reviewTaskAuthorityInvalidated(task)) {
          if (!attempt?.fixIteration) {
            throw new DevelopmentTransitionError("Only a fix-candidate review can require Phase 2C human action");
          }
          await transaction
            .update(developmentTasks)
            .set({
              needsHumanReason,
              status: "needs_human",
              updatedAt: databaseNow
            })
            .where(eq(developmentTasks.id, review.taskId));
        }
        await insertEvent(transaction, {
          createdAt: databaseNow,
          kind: "finalization",
          reviewId: review.id,
          safeMetadata: {
            failure_class: review.failureClass ?? "interrupted",
            ...(needsHumanReason ? { needs_human_reason: needsHumanReason } : {})
          },
          status: "failed"
        });
        return updated!;
      });
    },

    finalizeReview: async (input: {
      contextDigest: string;
      leaseGeneration: number;
      now: Date;
      reviewId: string;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const contextDigest = z.string().regex(/^[0-9a-f]{64}$/).parse(input.contextDigest);
      // Phase 2A provenance and the immutable commit ID are already durable. Mutable
      // Git retention refs are deliberately not identity inputs to this DB transition.
      return database.transaction(async (transaction) => {
        const { attempt, databaseNow, review, task } = await lockedReview(transaction, fence);
        await testHooks.afterFinalizeLock?.(review.id);
        if (
          review.status !== "finalizing" ||
          review.cleanupStatus !== "succeeded" ||
          !review.decision ||
          review.failureClass ||
          review.contextDigest !== contextDigest
        ) {
          throw new DevelopmentTransitionError("Review cannot finalize in the current state");
        }
        if (
          task?.status !== "candidate_ready" ||
          task.authorityInvalidatedAt ||
          attempt?.status !== "succeeded" ||
          attempt.candidateCommit !== review.candidateCommit ||
          attempt.candidateRef !== review.candidateRef
        ) {
          throw new DevelopmentTransitionError("Review candidate binding changed before finalization");
        }
        const safeSummary = review.decision === "APPROVE"
          ? "Independent Reviewer approved the exact candidate with zero findings"
          : `Independent Reviewer requested changes with ${review.findings.length} validated finding(s)`;
        const [updated] = await transaction
          .update(developmentReviews)
          .set({
            completedAt: databaseNow,
            finalizedAt: databaseNow,
            safeSummary,
            status: "succeeded",
            updatedAt: databaseNow
          })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        await insertEvent(transaction, {
          createdAt: databaseNow,
          kind: "finalization",
          reviewId: review.id,
          safeMetadata: {
            candidate_commit: review.candidateCommit,
            context_digest: contextDigest,
            decision: review.decision,
            finding_count: review.findings.length
          },
          status: "success"
        });
        return updated!;
      });
    },

    getCurrentAuthoritativeReview: async (taskId: string, candidateCommit: string) => {
      const [row] = await database
        .select({ attempt: developmentAttempts, review: developmentReviews, task: developmentTasks })
        .from(developmentReviews)
        .innerJoin(developmentTasks, eq(developmentTasks.id, developmentReviews.taskId))
        .innerJoin(
          developmentAttempts,
          eq(developmentAttempts.id, developmentReviews.implementerAttemptId)
        )
        .where(
          and(
            eq(developmentTasks.id, uuidSchema.parse(taskId)),
            eq(developmentTasks.status, "candidate_ready"),
            isNull(developmentTasks.authorityInvalidatedAt),
            eq(developmentAttempts.taskId, developmentTasks.id),
            eq(developmentAttempts.status, "succeeded"),
            eq(developmentTasks.baseCommit, developmentReviews.baseCommit),
            eq(developmentAttempts.candidateCommit, developmentReviews.candidateCommit),
            eq(developmentAttempts.candidateRef, developmentReviews.candidateRef),
            isNull(developmentAttempts.failureClass),
            eq(developmentReviews.candidateCommit, gitObjectIdSchema.parse(candidateCommit)),
            eq(developmentReviews.status, "succeeded"),
            eq(developmentReviews.cleanupStatus, "succeeded"),
            isNotNull(developmentReviews.contextDigest),
            isNotNull(developmentReviews.contextManifest),
            isNotNull(developmentReviews.completedAt),
            isNotNull(developmentReviews.finalizedAt),
            isNotNull(developmentReviews.safeSummary),
            isNull(developmentReviews.failureClass)
          )
        )
        .limit(1);
      const review = row?.review;
      if (
        !review ||
        !developmentReviewerContextManifestSchema.safeParse(review.contextManifest).success ||
        !developmentReviewerContextPolicySchema.safeParse(review.contextPolicy).success ||
        !developmentBudgetSchema.safeParse(review.budget).success ||
        !developmentUsageSchema.safeParse(review.usage).success ||
        !developmentReviewResultSchema.safeParse({
          decision: review.decision,
          findings: review.findings
        }).success
      ) {
        return undefined;
      }
      const [latest] = await database
        .select({ id: developmentAttempts.id })
        .from(developmentAttempts)
        .where(eq(developmentAttempts.taskId, uuidSchema.parse(taskId)))
        .orderBy(sql`${developmentAttempts.attemptNumber} desc`)
        .limit(1);
      return latest?.id === row?.attempt.id ? review : undefined;
    },

    getReview: async (id: string) => {
      const [review] = await database
        .select()
        .from(developmentReviews)
        .where(eq(developmentReviews.id, uuidSchema.parse(id)))
        .limit(1);
      return review;
    },

    getReviewContextInput: contextInput,

    listReviewEvents: async (reviewId: string) =>
      database
        .select()
        .from(developmentReviewEvents)
        .where(eq(developmentReviewEvents.reviewId, uuidSchema.parse(reviewId)))
        .orderBy(asc(developmentReviewEvents.sequence)),

    persistReviewProposal: async (input: {
      leaseGeneration: number;
      now: Date;
      result: DevelopmentReviewResult;
      reviewId: string;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const result = safeReviewResultSchema.parse(input.result);
      return database.transaction(async (transaction) => {
        const { databaseNow, review, task } = await lockedReview(transaction, fence);
        if (review.status === "finalizing") {
          if (review.decision === result.decision && JSON.stringify(review.findings) === JSON.stringify(result.findings)) {
            return review;
          }
          throw new DevelopmentTransitionError("A different Reviewer proposal is already durable");
        }
        if (
          review.status !== "reviewing" ||
          !review.contextDigest ||
          reviewTaskAuthorityInvalidated(task)
        ) {
          throw new DevelopmentTransitionError("Reviewer proposal is not allowed in the current state");
        }
        const criterionIds = new Set(
          developmentAcceptanceCriteriaSchema.parse(task!.acceptanceCriteria).map((criterion) => criterion.id)
        );
        if (result.findings.some((finding) => !criterionIds.has(finding.acceptanceCriterionId))) {
          throw new DevelopmentTransitionError("Review finding references an unknown acceptance criterion");
        }
        const [updated] = await transaction
          .update(developmentReviews)
          .set({
            decision: result.decision,
            findings: result.findings,
            status: "finalizing",
            updatedAt: databaseNow
          })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        await insertEvent(transaction, {
          createdAt: databaseNow,
          kind: "transition",
          reviewId: review.id,
          safeMetadata: { decision: result.decision, finding_count: result.findings.length, to_status: "finalizing" },
          status: "success"
        });
        return updated!;
      });
    },

    prepareReviewInfrastructureRetry: async (input: {
      failureClass: string;
      leaseDurationMs: number;
      leaseGeneration: number;
      reviewId: string;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const failureClass = shortText.parse(input.failureClass);
      return database.transaction(async (transaction) => {
        const { attempt, databaseNow, review, task } = await lockedReview(transaction, fence);
        if (
          !attempt?.fixIteration ||
          review.decision ||
          reviewTaskAuthorityInvalidated(task) ||
          review.infrastructureRetryCount >= 2 ||
          review.cleanupStatus !== "succeeded" ||
          !["preparing", "reviewing", "interrupted"].includes(review.status)
        ) {
          throw new DevelopmentTransitionError("Reviewer infrastructure retry is not authorized");
        }
        const leaseGeneration = review.leaseGeneration + 1;
        const [updated] = await transaction
          .update(developmentReviews)
          .set({
            cleanupStatus: "pending",
            failureClass: null,
            infrastructureRetryCount: review.infrastructureRetryCount + 1,
            leaseExpiresAt: leaseExpiry(databaseNow, input.leaseDurationMs),
            leaseGeneration,
            leaseOwner: input.runnerId,
            status: "preparing",
            updatedAt: databaseNow
          })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        await insertEvent(transaction, {
          createdAt: databaseNow,
          kind: "transition",
          reviewId: review.id,
          safeMetadata: {
            failure_class: failureClass,
            infrastructure_retry_count: updated!.infrastructureRetryCount,
            lease_generation: leaseGeneration,
            to_status: "preparing"
          },
          status: "unknown"
        });
        return updated!;
      });
    },

    reclaimReview: async (input: {
      leaseDurationMs: number;
      runnerId: string;
    }) => {
      const value = z.object({
        leaseDurationMs: positiveDurationSchema,
        runnerId: shortText
      }).strict().parse(input);
      return database.transaction(async (transaction) => {
        const [candidate] = await transaction
          .select({ id: developmentReviews.id, taskId: developmentReviews.taskId, attemptId: developmentReviews.implementerAttemptId })
          .from(developmentReviews)
          .where(sql`${developmentReviews.status} in ('preparing', 'reviewing', 'finalizing', 'interrupted')`)
          .orderBy(asc(developmentReviews.leaseExpiresAt), asc(developmentReviews.id))
          .limit(1);
        if (!candidate) return undefined;
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.id, candidate.taskId))
          .limit(1)
          .for("update", { skipLocked: true });
        if (
          !task ||
          (task.status !== "candidate_ready" &&
            !(task.status === "blocked" && task.authorityInvalidatedAt !== null))
        ) return undefined;
        await transaction
          .select()
          .from(developmentAttempts)
          .where(eq(developmentAttempts.id, candidate.attemptId))
          .limit(1)
          .for("update");
        const review = (await transaction
          .select()
          .from(developmentReviews)
          .where(sql`${developmentReviews.id} = ${candidate.id}
            and ${developmentReviews.status} in ('preparing', 'reviewing', 'finalizing', 'interrupted')`)
          .limit(1)
          .for("update"))[0]!;
        await testHooks.afterReclaimLock?.(review.id);
        const databaseNow = await freshDatabaseTime(transaction);
        if (review.leaseExpiresAt > databaseNow) return undefined;
        const leaseGeneration = review.leaseGeneration + 1;
        const status = review.status === "preparing" || review.status === "reviewing"
          ? "interrupted"
          : review.status;
        const [updated] = await transaction
          .update(developmentReviews)
          .set({
            failureClass: status === "interrupted" ? (review.failureClass ?? "lease_expired") : review.failureClass,
            leaseExpiresAt: leaseExpiry(databaseNow, value.leaseDurationMs),
            leaseGeneration,
            leaseOwner: value.runnerId,
            status,
            updatedAt: databaseNow
          })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        await insertEvent(transaction, {
          createdAt: updated!.updatedAt,
          kind: "transition",
          reviewId: review.id,
          safeMetadata: { lease_generation: leaseGeneration, reason: "lease_expired", to_status: status },
          status: "unknown"
        });
        return {
          ...updated!,
          authorityInvalidated: task.authorityInvalidatedAt !== null || task.status === "blocked",
          taskStatus: task.status
        };
      });
    },

    recordReviewCleanup: async (input: {
      leaseGeneration: number;
      now: Date;
      reviewId: string;
      runnerId: string;
      status: "failed" | "succeeded";
    }) => {
      const fence = fenceSchema.parse(input);
      return database.transaction(async (transaction) => {
        const { databaseNow, review } = await lockedReview(transaction, fence);
        if (review.cleanupStatus === "succeeded") return review;
        const [updated] = await transaction
          .update(developmentReviews)
          .set({
            cleanupStatus: input.status,
            ...(input.status === "failed" ? { leaseExpiresAt: databaseNow } : {}),
            updatedAt: databaseNow
          })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        await insertEvent(transaction, {
          createdAt: databaseNow,
          kind: "cleanup",
          reviewId: review.id,
          safeMetadata: { sandbox_id: review.sandboxId },
          status: input.status === "succeeded" ? "success" : "failed"
        });
        return updated!;
      });
    },

    recordReviewFailure: async (input: {
      failureClass: string;
      leaseGeneration: number;
      now: Date;
      reviewId: string;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const failureClass = shortText.parse(input.failureClass);
      return database.transaction(async (transaction) => {
        const { databaseNow, review } = await lockedReview(transaction, fence);
        if (["succeeded", "failed"].includes(review.status)) {
          throw new DevelopmentTransitionError("Terminal Review cannot be failed again");
        }
        const status = review.decision ? "finalizing" : "interrupted";
        const [updated] = await transaction
          .update(developmentReviews)
          .set({ failureClass, status, updatedAt: databaseNow })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        await insertEvent(transaction, {
          createdAt: databaseNow,
          kind: "transition",
          reviewId: review.id,
          safeMetadata: { failure_class: failureClass, to_status: status },
          status: "failed"
        });
        return updated!;
      });
    },

    recordReviewUsage: async (input: {
      delta: DevelopmentUsage;
      leaseGeneration: number;
      now: Date;
      reviewId: string;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const delta = developmentUsageSchema.parse(input.delta);
      return database.transaction(async (transaction) => {
        const { databaseNow, review } = await lockedReview(transaction, fence);
        const usage = addUsage(developmentUsageSchema.parse(review.usage), delta);
        if (!usageWithinBudget(usage, developmentBudgetSchema.parse(review.budget))) {
          throw new DevelopmentBudgetError("Development review budget exhausted");
        }
        const [updated] = await transaction
          .update(developmentReviews)
          .set({ updatedAt: databaseNow, usage })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        return updated!;
      });
    },

    renewReviewLease: async (input: {
      leaseDurationMs: number;
      leaseGeneration: number;
      reviewId: string;
      runnerId: string;
    }) => {
      const value = z.object({
        leaseDurationMs: positiveDurationSchema,
        leaseGeneration: z.number().int().positive(),
        reviewId: uuidSchema,
        runnerId: shortText
      }).strict().parse(input);
      return database.transaction(async (transaction) => {
        const { databaseNow, review } = await lockedReview(transaction, value);
        const [updated] = await transaction
          .update(developmentReviews)
          .set({
            leaseExpiresAt: leaseExpiry(databaseNow, value.leaseDurationMs),
            updatedAt: databaseNow
          })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        return updated!;
      });
    },

    saveReviewContext: async (input: {
      contextDigest: string;
      contextManifest: unknown;
      leaseGeneration: number;
      now: Date;
      reviewId: string;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const contextDigest = z.string().regex(/^[0-9a-f]{64}$/).parse(input.contextDigest);
      const contextManifest = developmentReviewerContextManifestSchema.parse(input.contextManifest);
      return database.transaction(async (transaction) => {
        const { databaseNow, review } = await lockedReview(transaction, fence);
        if (review.contextDigest && review.contextDigest !== contextDigest) {
          throw new Error("Compiled Reviewer context is immutable for this attempt");
        }
        const [updated] = await transaction
          .update(developmentReviews)
          .set({ contextDigest, contextManifest, updatedAt: databaseNow })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        return updated!;
      });
    },

    startReviewExecution: async (input: {
      leaseGeneration: number;
      now: Date;
      reviewId: string;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      return database.transaction(async (transaction) => {
        const { databaseNow, review, task } = await lockedReview(transaction, fence);
        if (review.status !== "preparing" || !review.contextDigest || reviewTaskAuthorityInvalidated(task)) {
          throw new DevelopmentTransitionError("Review execution cannot start in the current state");
        }
        const [updated] = await transaction
          .update(developmentReviews)
          .set({ status: "reviewing", updatedAt: databaseNow })
          .where(eq(developmentReviews.id, review.id))
          .returning();
        await insertEvent(transaction, {
          createdAt: databaseNow,
          kind: "transition",
          reviewId: review.id,
          safeMetadata: { from_status: "preparing", to_status: "reviewing" },
          status: "success"
        });
        return updated!;
      });
    }
  };
  return {
    ...repositories,
    getAuthoritativeReview: repositories.getCurrentAuthoritativeReview
  };
}
