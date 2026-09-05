import { randomUUID } from "node:crypto";
import {
  canTransitionDevelopmentAttempt,
  canTransitionDevelopmentTask,
  createSecretFreeJsonSchema,
  createSecretFreeTextSchema,
  developmentAcceptanceCriteriaSchema,
  developmentAttemptEventKindSchema,
  developmentAttemptStatusSchema,
  developmentBudgetSchema,
  developmentContextManifestSchema,
  developmentEventStatusSchema,
  developmentImplementerContextPolicySchema,
  developmentNeedsHumanReasonSchema,
  developmentTaskStatusSchema,
  developmentUsageSchema,
  emptyDevelopmentUsage,
  gitObjectIdSchema,
  isDurableJson,
  modelProfileSchema,
  redactText,
  type DevelopmentAttemptStatus,
  type DevelopmentBudget,
  type DevelopmentTaskStatus,
  type DevelopmentUsage,
  type JsonObject,
  type JsonValue
} from "@personal-agent/shared";
import { and, asc, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import {
  developmentAttemptEvents,
  developmentAttempts,
  developmentReviews,
  developmentTasks
} from "./schema.js";

const uuidSchema = z.string().uuid();
const positiveDurationSchema = z.number().int().positive();
const recoveryCandidateLimit = 100;

class SkipRecoveryCandidate extends Error {}

export class DevelopmentLeaseError extends Error {}
export class DevelopmentTransitionError extends Error {}
export class DevelopmentBudgetError extends Error {}

type DevelopmentTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function leaseExpiry(now: Date, durationMs: number): Date {
  return new Date(now.getTime() + positiveDurationSchema.parse(durationMs));
}

async function freshDatabaseTime(transaction: DevelopmentTransaction): Promise<Date> {
  const result = await transaction.execute<{ databaseNow: Date }>(
    sql`select clock_timestamp() as "databaseNow"`
  );
  return z.coerce.date().parse(result.rows[0]?.databaseNow);
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

export type DevelopmentRepositoryTestHooks = {
  afterReclaimLock?: (attemptId: string) => Promise<void>;
};

export function createDevelopmentRepositories(
  database: Database,
  knownSecrets: readonly string[] = [],
  testHooks: DevelopmentRepositoryTestHooks = {}
) {
  const secretFreeText = createSecretFreeTextSchema(knownSecrets);
  const shortText = secretFreeText.trim().min(1).max(500);
  const specificationText = secretFreeText.trim().min(1).max(100_000);
  const safeMetadataSchema = createSecretFreeJsonSchema(knownSecrets)
    .refine((value) => JSON.stringify(value).length <= 8_192, "Safe metadata is too large")
    .refine(isDurableJson, "Unsafe durable metadata is not allowed");
  const acceptanceCriteriaSchema = developmentAcceptanceCriteriaSchema.refine(
    (value) =>
      secretFreeText.safeParse(JSON.stringify(value)).success &&
      isDurableJson(JSON.parse(JSON.stringify(value)) as JsonValue),
    "Acceptance criteria contain unsafe durable data"
  );

  const approvedTaskInputSchema = z.object({
    acceptanceCriteria: acceptanceCriteriaSchema,
    approvedAt: z.date(),
    approvedSpec: specificationText,
    baseCommit: gitObjectIdSchema,
    title: shortText
  });

  const claimInputSchema = z.object({
    budget: developmentBudgetSchema,
    leaseDurationMs: positiveDurationSchema,
    modelProfile: modelProfileSchema,
    now: z.date(),
    runnerId: shortText,
    taskId: uuidSchema.optional()
  });

  const fenceSchema = z.object({
    attemptId: uuidSchema,
    leaseGeneration: z.number().int().positive(),
    now: z.date(),
    runnerId: shortText
  });

  // Canonical overlapping-row order: task -> attempt -> review.
  async function lockedAttempt(
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
    input: z.infer<typeof fenceSchema>
  ) {
    const [identity] = await transaction
      .select({ taskId: developmentAttempts.taskId })
      .from(developmentAttempts)
      .where(eq(developmentAttempts.id, input.attemptId))
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
      .where(eq(developmentAttempts.id, input.attemptId))
      .limit(1)
      .for("update");

    const databaseNow = await freshDatabaseTime(transaction);
    if (
      !attempt ||
      attempt.leaseOwner !== input.runnerId ||
      attempt.leaseGeneration !== input.leaseGeneration ||
      !attempt.leaseExpiresAt ||
      attempt.leaseExpiresAt <= databaseNow
    ) {
      throw new DevelopmentLeaseError("Development attempt lease is not current");
    }
    return { attempt, databaseNow, task };
  }

  async function insertEvent(
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
    input: {
      attemptId: string;
      createdAt: Date;
      kind: z.infer<typeof developmentAttemptEventKindSchema>;
      safeMetadata: JsonObject;
      status: z.infer<typeof developmentEventStatusSchema>;
    }
  ) {
    const [sequenceResult] = await transaction
      .select({ value: max(developmentAttemptEvents.sequence) })
      .from(developmentAttemptEvents)
      .where(eq(developmentAttemptEvents.attemptId, input.attemptId));
    const [event] = await transaction
      .insert(developmentAttemptEvents)
      .values({
        attemptId: input.attemptId,
        createdAt: input.createdAt,
        id: randomUUID(),
        kind: input.kind,
        safeMetadata: input.safeMetadata,
        sequence: (sequenceResult?.value ?? 0) + 1,
        status: input.status
      })
      .returning();
    return event!;
  }

  async function persistCapturedCandidate(
    input: {
      attemptId: string;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
      safeSummary: string;
    },
    capture: () => Promise<{ candidateCommit: string; candidateRef: string }>
  ) {
    const fence = fenceSchema.parse(input);
    const safeSummary = redactText(input.safeSummary, knownSecrets).slice(0, 2_000);
    return database.transaction(async (transaction) => {
      const { attempt, databaseNow } = await lockedAttempt(transaction, fence);
      const [task] = await transaction
        .select()
        .from(developmentTasks)
        .where(eq(developmentTasks.id, attempt.taskId))
        .limit(1)
        .for("update");
      if (attempt.status !== "capturing_candidate" || task?.status !== "testing") {
        throw new DevelopmentTransitionError("Candidate capture is not allowed in the current state");
      }
      const captured = await capture();
      const candidateCommit = gitObjectIdSchema.parse(captured.candidateCommit);
      const expectedRef = `refs/personal-agent/development-attempts/${fence.attemptId}`;
      if (captured.candidateRef !== expectedRef) {
        throw new Error("Candidate ref is not the trusted attempt ref");
      }
      const [updatedAttempt] = await transaction
        .update(developmentAttempts)
        .set({
          candidateCommit,
          candidateRef: captured.candidateRef,
          completedAt: databaseNow,
          safeSummary,
          status: "succeeded",
          updatedAt: databaseNow
        })
        .where(eq(developmentAttempts.id, attempt.id))
        .returning();
      const [updatedTask] = await transaction
        .update(developmentTasks)
        .set({ status: "candidate_ready", updatedAt: databaseNow })
        .where(eq(developmentTasks.id, attempt.taskId))
        .returning();
      await insertEvent(transaction, {
        attemptId: attempt.id,
        createdAt: databaseNow,
        kind: "git",
        safeMetadata: { candidate_commit: candidateCommit, candidate_ref: captured.candidateRef },
        status: "success"
      });
      return { attempt: updatedAttempt!, task: updatedTask! };
    });
  }

  return {
    appendDevelopmentAttemptEvent: async (input: {
      attemptId: string;
      kind: z.input<typeof developmentAttemptEventKindSchema>;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
      safeMetadata?: JsonObject;
      status: z.input<typeof developmentEventStatusSchema>;
    }) => {
      const fence = fenceSchema.parse(input);
      const kind = developmentAttemptEventKindSchema.parse(input.kind);
      const status = developmentEventStatusSchema.parse(input.status);
      const safeMetadata = safeMetadataSchema.parse(input.safeMetadata ?? {});
      return database.transaction(async (transaction) => {
        await lockedAttempt(transaction, fence);
        return insertEvent(transaction, {
          attemptId: fence.attemptId,
          createdAt: fence.now,
          kind,
          safeMetadata,
          status
        });
      });
    },

    blockDevelopmentCandidateIntegrity: async (input: {
      attemptId: string;
      now: Date;
    }) => {
      const attemptId = uuidSchema.parse(input.attemptId);
      return database.transaction(async (transaction) => {
        const [identity] = await transaction
          .select({ taskId: developmentAttempts.taskId })
          .from(developmentAttempts)
          .where(eq(developmentAttempts.id, attemptId))
          .limit(1);
        const [task] = identity
          ? await transaction
              .select()
              .from(developmentTasks)
              .where(eq(developmentTasks.id, identity.taskId))
              .limit(1)
              .for("update")
          : [];
        const [attempt] = await transaction
          .select()
          .from(developmentAttempts)
          .where(eq(developmentAttempts.id, attemptId))
          .limit(1)
          .for("update");
        if (
          attempt?.status !== "succeeded" ||
          task?.status !== "candidate_ready"
        ) {
          throw new DevelopmentTransitionError("Candidate integrity blocking is not allowed in the current state");
        }
        const [updatedAttempt] = await transaction
          .update(developmentAttempts)
          .set({
            failureClass: "candidate_integrity",
            safeSummary: "Trusted candidate ref is missing or inconsistent",
            updatedAt: input.now
          })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ status: "blocked", updatedAt: input.now })
          .where(eq(developmentTasks.id, attempt.taskId))
          .returning();
        await insertEvent(transaction, {
          attemptId: attempt.id,
          createdAt: input.now,
          kind: "git",
          safeMetadata: { failure_class: "candidate_integrity" },
          status: "blocked"
        });
        return { attempt: updatedAttempt!, task: updatedTask! };
      });
    },

    claimReadyDevelopmentTask: async (input: z.input<typeof claimInputSchema>) => {
      const value = claimInputSchema.parse(input);
      return database.transaction(async (transaction) => {
        const conditions = [eq(developmentTasks.status, "ready")];
        if (value.taskId) conditions.push(eq(developmentTasks.id, value.taskId));
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(and(...conditions))
          .orderBy(asc(developmentTasks.createdAt), asc(developmentTasks.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!task) return undefined;

        const databaseNow = await freshDatabaseTime(transaction);
        const attemptId = randomUUID();
        const [attempt] = await transaction
          .insert(developmentAttempts)
          .values({
            attemptNumber: 1,
            baseCommit: task.baseCommit,
            budget: value.budget,
            createdAt: databaseNow,
            harnessAdapter: "pi",
            id: attemptId,
            leaseExpiresAt: leaseExpiry(databaseNow, value.leaseDurationMs),
            leaseGeneration: 1,
            leaseOwner: value.runnerId,
            modelProfile: value.modelProfile,
            role: "implementer",
            sandboxId: `development-attempt-${attemptId}`,
            startedAt: databaseNow,
            status: "preparing",
            taskId: task.id,
            updatedAt: databaseNow,
            usage: emptyDevelopmentUsage()
          })
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ status: "preparing", updatedAt: databaseNow })
          .where(and(eq(developmentTasks.id, task.id), eq(developmentTasks.status, "ready")))
          .returning();
        await insertEvent(transaction, {
          attemptId,
          createdAt: databaseNow,
          kind: "transition",
          safeMetadata: { from_status: "ready", lease_generation: 1, to_status: "preparing" },
          status: "started"
        });
        return { attempt: attempt!, sourceReview: undefined, task: updatedTask! };
      });
    },

    claimFixRequiredDevelopmentTask: async (input: {
      budget: unknown;
      contextPolicy: unknown;
      leaseDurationMs: number;
      modelProfile: unknown;
      runnerId: string;
      taskId?: string;
    }) => {
      const value = z.object({
        budget: developmentBudgetSchema,
        contextPolicy: developmentImplementerContextPolicySchema,
        leaseDurationMs: positiveDurationSchema,
        modelProfile: modelProfileSchema,
        runnerId: shortText,
        taskId: uuidSchema.optional()
      }).strict().parse(input);
      return database.transaction(async (transaction) => {
        const conditions = [eq(developmentTasks.status, "fix_required")];
        if (value.taskId) conditions.push(eq(developmentTasks.id, value.taskId));
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(and(...conditions))
          .orderBy(asc(developmentTasks.createdAt), asc(developmentTasks.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!task) return undefined;
        if (task.authorityInvalidatedAt) {
          throw new DevelopmentTransitionError("Invalidated task cannot start a fix attempt");
        }
        const [parentAttempt] = await transaction
          .select()
          .from(developmentAttempts)
          .where(eq(developmentAttempts.taskId, task.id))
          .orderBy(desc(developmentAttempts.attemptNumber))
          .limit(1)
          .for("update");
        const [sourceReview] = await transaction
          .select()
          .from(developmentReviews)
          .where(eq(developmentReviews.implementerAttemptId, parentAttempt!.id))
          .limit(1)
          .for("update");
        if (
          parentAttempt?.status !== "succeeded" ||
          parentAttempt.failureClass ||
          !parentAttempt.candidateCommit ||
          !sourceReview ||
          sourceReview.status !== "succeeded" ||
          sourceReview.decision !== "REQUEST_CHANGES" ||
          sourceReview.failureClass ||
          !sourceReview.finalizedAt ||
          sourceReview.candidateCommit !== parentAttempt.candidateCommit ||
          sourceReview.candidateRef !== parentAttempt.candidateRef
        ) {
          throw new DevelopmentTransitionError(
            "Fix claim requires the reconciled authoritative rejected candidate"
          );
        }
        const fixIteration = (parentAttempt.fixIteration ?? 0) + 1;
        const databaseNow = await freshDatabaseTime(transaction);
        const attemptId = randomUUID();
        const [attempt] = await transaction
          .insert(developmentAttempts)
          .values({
            attemptNumber: fixIteration + 1,
            baseCommit: parentAttempt.candidateCommit,
            budget: value.budget,
            contextPolicy: value.contextPolicy,
            createdAt: databaseNow,
            fixIteration,
            harnessAdapter: "pi",
            id: attemptId,
            infrastructureRetryCount: 0,
            leaseExpiresAt: leaseExpiry(databaseNow, value.leaseDurationMs),
            leaseGeneration: 1,
            leaseOwner: value.runnerId,
            modelProfile: value.modelProfile,
            parentCandidateCommit: parentAttempt.candidateCommit,
            role: "implementer",
            sandboxId: `development-attempt-${attemptId}`,
            sourceReviewId: sourceReview.id,
            startedAt: databaseNow,
            status: "preparing",
            taskId: task.id,
            updatedAt: databaseNow,
            usage: emptyDevelopmentUsage()
          })
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ needsHumanReason: null, status: "preparing", updatedAt: databaseNow })
          .where(eq(developmentTasks.id, task.id))
          .returning();
        await insertEvent(transaction, {
          attemptId,
          createdAt: databaseNow,
          kind: "transition",
          safeMetadata: {
            fix_iteration: fixIteration,
            from_status: "fix_required",
            lease_generation: 1,
            source_review_id: sourceReview.id,
            to_status: "preparing"
          },
          status: "started"
        });
        return { attempt: attempt!, sourceReview, task: updatedTask! };
      });
    },

    createApprovedDevelopmentTask: async (input: z.input<typeof approvedTaskInputSchema>) => {
      const value = approvedTaskInputSchema.parse(input);
      const [task] = await database
        .insert(developmentTasks)
        .values({
          acceptanceCriteria: value.acceptanceCriteria,
          approvedAt: value.approvedAt,
          approvedSpec: value.approvedSpec,
          baseCommit: value.baseCommit,
          createdAt: value.approvedAt,
          id: randomUUID(),
          status: "ready",
          title: value.title,
          updatedAt: value.approvedAt
        })
        .returning();
      return task!;
    },

    getConsumedFixAttemptInput: async (id: string) => {
      const [row] = await database
        .select({ attempt: developmentAttempts, sourceReview: developmentReviews, task: developmentTasks })
        .from(developmentAttempts)
        .innerJoin(developmentTasks, eq(developmentTasks.id, developmentAttempts.taskId))
        .innerJoin(developmentReviews, eq(developmentReviews.id, developmentAttempts.sourceReviewId))
        .where(and(
          eq(developmentAttempts.id, uuidSchema.parse(id)),
          sql`${developmentAttempts.fixIteration} is not null`,
          sql`${developmentAttempts.parentCandidateCommit} is not null`,
          eq(developmentReviews.status, "succeeded"),
          eq(developmentReviews.decision, "REQUEST_CHANGES"),
          eq(developmentReviews.candidateCommit, developmentAttempts.parentCandidateCommit),
          eq(developmentReviews.taskId, developmentTasks.id)
        ))
        .limit(1);
      return row;
    },

    getDevelopmentAttempt: async (id: string) => {
      const [attempt] = await database
        .select()
        .from(developmentAttempts)
        .where(eq(developmentAttempts.id, uuidSchema.parse(id)))
        .limit(1);
      return attempt;
    },

    getDevelopmentTask: async (id: string) => {
      const [task] = await database
        .select()
        .from(developmentTasks)
        .where(eq(developmentTasks.id, uuidSchema.parse(id)))
        .limit(1);
      return task;
    },

    lastDevelopmentTeardownSucceeded: async (attemptId: string) => {
      const [event] = await database
        .select()
        .from(developmentAttemptEvents)
        .where(and(
          eq(developmentAttemptEvents.attemptId, uuidSchema.parse(attemptId)),
          eq(developmentAttemptEvents.kind, "teardown")
        ))
        .orderBy(desc(developmentAttemptEvents.sequence))
        .limit(1);
      return event?.status === "success";
    },

    listDevelopmentAttempts: async (taskId: string) =>
      database
        .select()
        .from(developmentAttempts)
        .where(eq(developmentAttempts.taskId, uuidSchema.parse(taskId)))
        .orderBy(asc(developmentAttempts.attemptNumber)),

    listDevelopmentAttemptEvents: async (attemptId: string) =>
      database
        .select()
        .from(developmentAttemptEvents)
        .where(eq(developmentAttemptEvents.attemptId, uuidSchema.parse(attemptId)))
        .orderBy(asc(developmentAttemptEvents.sequence)),

    reclaimExpiredDevelopmentAttempt: async (input: {
      leaseDurationMs: number;
      now: Date;
      runnerId: string;
    }) => {
      const value = z
        .object({
          leaseDurationMs: positiveDurationSchema,
          now: z.date(),
          runnerId: shortText
        })
        .parse(input);
      return database.transaction(async (transaction) => {
        const candidates = await transaction
          .select({ id: developmentAttempts.id, taskId: developmentAttempts.taskId, fixIteration: developmentAttempts.fixIteration })
          .from(developmentAttempts)
          .innerJoin(developmentTasks, eq(developmentTasks.id, developmentAttempts.taskId))
          .where(sql`(${developmentAttempts.status} in ('preparing', 'implementing', 'testing', 'capturing_candidate')
              or (${developmentAttempts.status} = 'interrupted' and ${developmentAttempts.fixIteration} is not null))
            and ${developmentTasks.status} in ('preparing', 'implementing', 'testing')`)
          .orderBy(asc(developmentAttempts.leaseExpiresAt), asc(developmentAttempts.id))
          .limit(recoveryCandidateLimit);

        for (const candidate of candidates) {
          try {
            return await transaction.transaction(async (candidateTransaction) => {
              const [task] = await candidateTransaction
                .select()
                .from(developmentTasks)
                .where(eq(developmentTasks.id, candidate.taskId))
                .limit(1)
                .for("update", { skipLocked: true });
              if (!task || !["preparing", "implementing", "testing"].includes(task.status)) {
                throw new SkipRecoveryCandidate();
              }
              const [attempt] = await candidateTransaction
                .select()
                .from(developmentAttempts)
                .where(sql`${developmentAttempts.id} = ${candidate.id}
                  and (${developmentAttempts.status} in ('preparing', 'implementing', 'testing', 'capturing_candidate')
                    or (${developmentAttempts.status} = 'interrupted' and ${developmentAttempts.fixIteration} is not null))`)
                .limit(1)
                .for("update", { skipLocked: true });
              if (!attempt) throw new SkipRecoveryCandidate();
              const databaseNow = await freshDatabaseTime(candidateTransaction);
              if (!attempt.leaseExpiresAt || attempt.leaseExpiresAt > databaseNow) throw new SkipRecoveryCandidate();
              await testHooks.afterReclaimLock?.(attempt.id);

              const leaseGeneration = attempt.leaseGeneration + 1;
              const [updatedAttempt] = await candidateTransaction
                .update(developmentAttempts)
                .set({
                  leaseExpiresAt: leaseExpiry(databaseNow, value.leaseDurationMs),
                  leaseGeneration,
                  leaseOwner: value.runnerId,
                  status: "interrupted",
                  updatedAt: databaseNow
                })
                .where(eq(developmentAttempts.id, attempt.id))
                .returning();
              await candidateTransaction
                .update(developmentTasks)
                .set({ status: attempt.fixIteration ? "preparing" : "blocked", updatedAt: databaseNow })
                .where(eq(developmentTasks.id, attempt.taskId));
              await insertEvent(candidateTransaction, {
                attemptId: attempt.id,
                createdAt: databaseNow,
                kind: "transition",
                safeMetadata: { lease_generation: leaseGeneration, reason: "lease_expired" },
                status: "unknown"
              });
              return updatedAttempt!;
            });
          } catch (error) {
            if (!(error instanceof SkipRecoveryCandidate)) throw error;
          }
        }
        return undefined;
      });
    },

    prepareDevelopmentInfrastructureRetry: async (input: {
      attemptId: string;
      failureClass: string;
      leaseDurationMs: number;
      leaseGeneration: number;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse({ ...input, now: new Date() });
      const failureClass = shortText.parse(input.failureClass);
      return database.transaction(async (transaction) => {
        const { attempt, databaseNow } = await lockedAttempt(transaction, fence);
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.id, attempt.taskId))
          .limit(1)
          .for("update");
        if (
          !attempt.fixIteration ||
          attempt.infrastructureRetryCount >= 2 ||
          !["preparing", "implementing", "testing", "capturing_candidate", "interrupted"].includes(attempt.status) ||
          !task ||
          task.authorityInvalidatedAt
        ) {
          throw new DevelopmentTransitionError("Infrastructure retry is not authorized");
        }
        const leaseGeneration = attempt.leaseGeneration + 1;
        const [updatedAttempt] = await transaction
          .update(developmentAttempts)
          .set({
            failureClass: null,
            infrastructureRetryCount: attempt.infrastructureRetryCount + 1,
            leaseExpiresAt: leaseExpiry(databaseNow, input.leaseDurationMs),
            leaseGeneration,
            leaseOwner: input.runnerId,
            status: "preparing",
            updatedAt: databaseNow
          })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ needsHumanReason: null, status: "preparing", updatedAt: databaseNow })
          .where(eq(developmentTasks.id, task.id))
          .returning();
        await insertEvent(transaction, {
          attemptId: attempt.id,
          createdAt: databaseNow,
          kind: "transition",
          safeMetadata: {
            failure_class: failureClass,
            infrastructure_retry_count: updatedAttempt!.infrastructureRetryCount,
            lease_generation: leaseGeneration,
            to_status: "preparing"
          },
          status: "unknown"
        });
        return { attempt: updatedAttempt!, task: updatedTask! };
      });
    },

    markDevelopmentNeedsHuman: async (input: {
      attemptId: string;
      failureClass: string;
      leaseGeneration: number;
      reason: unknown;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse({ ...input, now: new Date() });
      const reason = developmentNeedsHumanReasonSchema.parse(input.reason);
      const failureClass = shortText.parse(input.failureClass);
      return database.transaction(async (transaction) => {
        const { attempt, databaseNow } = await lockedAttempt(transaction, fence);
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.id, attempt.taskId))
          .limit(1)
          .for("update");
        if (!attempt.fixIteration) {
          throw new DevelopmentTransitionError("Only a fix attempt can require Phase 2C human action");
        }
        const [updatedAttempt] = await transaction
          .update(developmentAttempts)
          .set({
            completedAt: databaseNow,
            failureClass,
            safeSummary: "Phase 2C fix attempt stopped for deterministic human escalation",
            status: "failed",
            updatedAt: databaseNow
          })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ needsHumanReason: reason, status: "needs_human", updatedAt: databaseNow })
          .where(eq(developmentTasks.id, task!.id))
          .returning();
        await insertEvent(transaction, {
          attemptId: attempt.id,
          createdAt: databaseNow,
          kind: "transition",
          safeMetadata: { failure_class: failureClass, reason, to_status: "needs_human" },
          status: "blocked"
        });
        return { attempt: updatedAttempt!, task: updatedTask! };
      });
    },

    recordDevelopmentUsage: async (input: {
      attemptId: string;
      delta: DevelopmentUsage;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const delta = developmentUsageSchema.parse(input.delta);
      return database.transaction(async (transaction) => {
        const { attempt } = await lockedAttempt(transaction, fence);
        const usage = addUsage(developmentUsageSchema.parse(attempt.usage), delta);
        const budget = developmentBudgetSchema.parse(attempt.budget);
        if (!usageWithinBudget(usage, budget)) {
          throw new DevelopmentBudgetError("Development attempt budget exhausted");
        }
        const [updated] = await transaction
          .update(developmentAttempts)
          .set({ updatedAt: fence.now, usage })
          .where(eq(developmentAttempts.id, fence.attemptId))
          .returning();
        return updated!;
      });
    },

    recordDevelopmentCandidate: async (input: {
      attemptId: string;
      candidateCommit: string;
      candidateRef: string;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
      safeSummary: string;
    }) => {
      const expectedRef = `refs/personal-agent/development-attempts/${input.attemptId}`;
      if (input.candidateRef !== expectedRef) {
        throw new Error("Candidate ref is not the trusted attempt ref");
      }
      return persistCapturedCandidate(input, async () => ({
        candidateCommit: input.candidateCommit,
        candidateRef: input.candidateRef
      }));
    },

    captureDevelopmentCandidate: async (input: {
      attemptId: string;
      capture: () => Promise<{ candidateCommit: string; candidateRef: string }>;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
      safeSummary: string;
    }) => {
      return persistCapturedCandidate(input, input.capture);
    },

    reconcileDevelopmentCandidate: async (input: {
      attemptId: string;
      candidateCommit: string;
      candidateRef: string;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
      safeSummary: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const candidateCommit = gitObjectIdSchema.parse(input.candidateCommit);
      const expectedRef = `refs/personal-agent/development-attempts/${fence.attemptId}`;
      if (input.candidateRef !== expectedRef) {
        throw new Error("Candidate ref is not the trusted attempt ref");
      }
      return database.transaction(async (transaction) => {
        const { attempt } = await lockedAttempt(transaction, fence);
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.id, attempt.taskId))
          .limit(1)
          .for("update");
        const expectedTaskStatus = attempt.fixIteration ? "preparing" : "blocked";
        if (attempt.status !== "interrupted" || task?.status !== expectedTaskStatus) {
          throw new DevelopmentTransitionError("Candidate reconciliation is not allowed in the current state");
        }
        const [updatedAttempt] = await transaction
          .update(developmentAttempts)
          .set({
            candidateCommit,
            candidateRef: input.candidateRef,
            completedAt: fence.now,
            safeSummary: redactText(input.safeSummary, knownSecrets).slice(0, 2_000),
            status: "succeeded",
            updatedAt: fence.now
          })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ status: "candidate_ready", updatedAt: fence.now })
          .where(eq(developmentTasks.id, attempt.taskId))
          .returning();
        await insertEvent(transaction, {
          attemptId: attempt.id,
          createdAt: fence.now,
          kind: "git",
          safeMetadata: { candidate_commit: candidateCommit, reconciliation: true },
          status: "success"
        });
        return { attempt: updatedAttempt!, task: updatedTask! };
      });
    },

    renewDevelopmentLease: async (input: {
      attemptId: string;
      leaseDurationMs: number;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      return database.transaction(async (transaction) => {
        const { attempt, databaseNow } = await lockedAttempt(transaction, fence);
        const [updated] = await transaction
          .update(developmentAttempts)
          .set({
            leaseExpiresAt: leaseExpiry(databaseNow, input.leaseDurationMs),
            updatedAt: databaseNow
          })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        return updated!;
      });
    },

    saveDevelopmentContext: async (input: {
      attemptId: string;
      contextDigest: string;
      contextManifest: unknown;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
    }) => {
      const fence = fenceSchema.parse(input);
      const contextDigest = z.string().regex(/^[0-9a-f]{64}$/).parse(input.contextDigest);
      const contextManifest = developmentContextManifestSchema.parse(input.contextManifest);
      return database.transaction(async (transaction) => {
        const { attempt } = await lockedAttempt(transaction, fence);
        if (
          attempt.contextDigest &&
          attempt.contextDigest !== contextDigest
        ) {
          throw new Error("Compiled development context is immutable for this attempt");
        }
        const [updated] = await transaction
          .update(developmentAttempts)
          .set({ contextDigest, contextManifest, updatedAt: fence.now })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        return updated!;
      });
    },

    transitionDevelopmentAttempt: async (input: {
      attemptId: string;
      attemptStatus: DevelopmentAttemptStatus;
      failureClass?: string;
      leaseGeneration: number;
      now: Date;
      runnerId: string;
      safeMetadata?: JsonObject;
      safeSummary?: string;
      taskStatus: DevelopmentTaskStatus;
    }) => {
      const fence = fenceSchema.parse(input);
      const attemptStatus = developmentAttemptStatusSchema.parse(input.attemptStatus);
      const taskStatus = developmentTaskStatusSchema.parse(input.taskStatus);
      const safeMetadata = safeMetadataSchema.parse(input.safeMetadata ?? {});
      const failureClass = input.failureClass ? shortText.parse(input.failureClass) : undefined;
      const safeSummary = input.safeSummary
        ? redactText(input.safeSummary, knownSecrets).slice(0, 2_000)
        : undefined;
      return database.transaction(async (transaction) => {
        const { attempt } = await lockedAttempt(transaction, fence);
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.id, attempt.taskId))
          .limit(1)
          .for("update");
        const fromAttemptStatus = developmentAttemptStatusSchema.parse(attempt.status);
        const fromTaskStatus = developmentTaskStatusSchema.parse(task!.status);
        if (!canTransitionDevelopmentAttempt(fromAttemptStatus, attemptStatus)) {
          throw new DevelopmentTransitionError(
            `Invalid development attempt transition: ${fromAttemptStatus} -> ${attemptStatus}`
          );
        }
        if (
          fromTaskStatus !== taskStatus &&
          !canTransitionDevelopmentTask(fromTaskStatus, taskStatus)
        ) {
          throw new DevelopmentTransitionError(
            `Invalid development task transition: ${fromTaskStatus} -> ${taskStatus}`
          );
        }
        const completedAt = ["failed", "cancelled"].includes(attemptStatus) ? fence.now : null;
        const [updatedAttempt] = await transaction
          .update(developmentAttempts)
          .set({
            completedAt,
            failureClass: failureClass ?? attempt.failureClass,
            safeSummary: safeSummary ?? attempt.safeSummary,
            status: attemptStatus,
            updatedAt: fence.now
          })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ status: taskStatus, updatedAt: fence.now })
          .where(eq(developmentTasks.id, task!.id))
          .returning();
        await insertEvent(transaction, {
          attemptId: attempt.id,
          createdAt: fence.now,
          kind: "transition",
          safeMetadata: {
            ...safeMetadata,
            from_attempt_status: fromAttemptStatus,
            from_task_status: fromTaskStatus,
            to_attempt_status: attemptStatus,
            to_task_status: taskStatus
          },
          status: ["failed", "cancelled"].includes(attemptStatus) ? "failed" : "success"
        });
        return { attempt: updatedAttempt!, task: updatedTask! };
      });
    }
  };
}
