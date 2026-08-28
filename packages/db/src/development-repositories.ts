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
import { and, asc, eq, lte, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import {
  developmentAttemptEvents,
  developmentAttempts,
  developmentTasks
} from "./schema.js";

const uuidSchema = z.string().uuid();
const positiveDurationSchema = z.number().int().positive();

export class DevelopmentLeaseError extends Error {}
export class DevelopmentTransitionError extends Error {}
export class DevelopmentBudgetError extends Error {}

function leaseExpiry(now: Date, durationMs: number): Date {
  return new Date(now.getTime() + positiveDurationSchema.parse(durationMs));
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

export function createDevelopmentRepositories(
  database: Database,
  knownSecrets: readonly string[] = []
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
    runnerId: shortText
  });

  const fenceSchema = z.object({
    attemptId: uuidSchema,
    leaseGeneration: z.number().int().positive(),
    now: z.date(),
    runnerId: shortText
  });

  async function lockedAttempt(
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
    input: z.infer<typeof fenceSchema>
  ) {
    const [attempt] = await transaction
      .select()
      .from(developmentAttempts)
      .where(eq(developmentAttempts.id, input.attemptId))
      .limit(1)
      .for("update");

    if (
      !attempt ||
      attempt.leaseOwner !== input.runnerId ||
      attempt.leaseGeneration !== input.leaseGeneration ||
      !attempt.leaseExpiresAt ||
      attempt.leaseExpiresAt <= input.now
    ) {
      throw new DevelopmentLeaseError("Development attempt lease is not current");
    }
    return attempt;
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
      const attempt = await lockedAttempt(transaction, fence);
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
          completedAt: fence.now,
          safeSummary,
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
        const [attempt] = await transaction
          .select()
          .from(developmentAttempts)
          .where(eq(developmentAttempts.id, attemptId))
          .limit(1)
          .for("update");
        const [task] = attempt
          ? await transaction
              .select()
              .from(developmentTasks)
              .where(eq(developmentTasks.id, attempt.taskId))
              .limit(1)
              .for("update")
          : [];
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
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.status, "ready"))
          .orderBy(asc(developmentTasks.createdAt), asc(developmentTasks.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!task) return undefined;

        const attemptId = randomUUID();
        const expiresAt = leaseExpiry(value.now, value.leaseDurationMs);
        const [attempt] = await transaction
          .insert(developmentAttempts)
          .values({
            attemptNumber: 1,
            baseCommit: task.baseCommit,
            budget: value.budget,
            createdAt: value.now,
            harnessAdapter: "pi",
            id: attemptId,
            leaseExpiresAt: expiresAt,
            leaseGeneration: 1,
            leaseOwner: value.runnerId,
            modelProfile: value.modelProfile,
            role: "implementer",
            sandboxId: `development-attempt-${attemptId}`,
            startedAt: value.now,
            status: "preparing",
            taskId: task.id,
            updatedAt: value.now,
            usage: emptyDevelopmentUsage()
          })
          .returning();
        const [updatedTask] = await transaction
          .update(developmentTasks)
          .set({ status: "preparing", updatedAt: value.now })
          .where(and(eq(developmentTasks.id, task.id), eq(developmentTasks.status, "ready")))
          .returning();
        await insertEvent(transaction, {
          attemptId,
          createdAt: value.now,
          kind: "transition",
          safeMetadata: { from_status: "ready", lease_generation: 1, to_status: "preparing" },
          status: "started"
        });
        return { attempt: attempt!, task: updatedTask! };
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
          maxAttempts: 1,
          status: "ready",
          title: value.title,
          updatedAt: value.approvedAt
        })
        .returning();
      return task!;
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
        const [attempt] = await transaction
          .select()
          .from(developmentAttempts)
          .where(
            and(
              lte(developmentAttempts.leaseExpiresAt, value.now),
              sql`${developmentAttempts.status} in ('preparing', 'implementing', 'testing', 'capturing_candidate')`
            )
          )
          .orderBy(asc(developmentAttempts.leaseExpiresAt), asc(developmentAttempts.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!attempt) return undefined;

        const leaseGeneration = attempt.leaseGeneration + 1;
        const [updatedAttempt] = await transaction
          .update(developmentAttempts)
          .set({
            leaseExpiresAt: leaseExpiry(value.now, value.leaseDurationMs),
            leaseGeneration,
            leaseOwner: value.runnerId,
            status: "interrupted",
            updatedAt: value.now
          })
          .where(eq(developmentAttempts.id, attempt.id))
          .returning();
        await transaction
          .update(developmentTasks)
          .set({ status: "blocked", updatedAt: value.now })
          .where(eq(developmentTasks.id, attempt.taskId));
        await insertEvent(transaction, {
          attemptId: attempt.id,
          createdAt: value.now,
          kind: "transition",
          safeMetadata: { lease_generation: leaseGeneration, reason: "lease_expired" },
          status: "unknown"
        });
        return updatedAttempt!;
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
        const attempt = await lockedAttempt(transaction, fence);
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
        const attempt = await lockedAttempt(transaction, fence);
        const [task] = await transaction
          .select()
          .from(developmentTasks)
          .where(eq(developmentTasks.id, attempt.taskId))
          .limit(1)
          .for("update");
        if (attempt.status !== "interrupted" || task?.status !== "blocked") {
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
      const expiresAt = leaseExpiry(fence.now, input.leaseDurationMs);
      const [attempt] = await database
        .update(developmentAttempts)
        .set({ leaseExpiresAt: expiresAt, updatedAt: fence.now })
        .where(
          and(
            eq(developmentAttempts.id, fence.attemptId),
            eq(developmentAttempts.leaseOwner, fence.runnerId),
            eq(developmentAttempts.leaseGeneration, fence.leaseGeneration),
            sql`${developmentAttempts.leaseExpiresAt} > ${fence.now}`
          )
        )
        .returning();
      if (!attempt) throw new DevelopmentLeaseError("Development attempt lease is not current");
      return attempt;
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
        const attempt = await lockedAttempt(transaction, fence);
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
        const attempt = await lockedAttempt(transaction, fence);
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
