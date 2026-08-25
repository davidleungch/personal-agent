import { randomUUID } from "node:crypto";
import { automationRuns, runEvents, type Database } from "@personal-agent/db";
import {
  automationRunStatusSchema,
  createSecretFreeJsonSchema,
  createSecretFreeTextSchema,
  type JsonObject
} from "@personal-agent/shared";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

type RunStatus = (typeof automationRunStatusSchema)["_output"];

const validTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  blocked: [],
  cancelled: [],
  failed: [],
  needs_human: ["queued"],
  queued: ["running"],
  retry_wait: ["queued"],
  running: ["succeeded", "verifying", "retry_wait", "needs_human", "failed", "blocked", "cancelled"],
  succeeded: [],
  verifying: ["succeeded", "retry_wait", "blocked"]
};

export class InvalidRunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`Invalid automation run transition: ${from} -> ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

export class RunLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLeaseError";
  }
}

function leaseExpiry(now: Date, leaseDurationMs: number): Date {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Lease duration must be a positive integer");
  }

  return new Date(now.getTime() + leaseDurationMs);
}

function unresolvedConsequentialOperation(checkpoint: JsonObject): boolean {
  const operation = checkpoint.pendingConsequentialOperation;
  return (
    typeof operation === "object" &&
    operation !== null &&
    !Array.isArray(operation) &&
    operation.outcome === "pending"
  );
}

export function createRunState(database: Database, knownSecrets: readonly string[] = []) {
  const safeJson = createSecretFreeJsonSchema(knownSecrets);
  const safeText = createSecretFreeTextSchema(knownSecrets);

  async function claimRun(workerId: string, now: Date, leaseDurationMs: number) {
    const claimedBy = safeText.min(1).parse(workerId);
    const expiresAt = leaseExpiry(now, leaseDurationMs);

    return database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select()
        .from(automationRuns)
        .where(
          and(
            isNull(automationRuns.claimedBy),
            lte(automationRuns.availableAt, now),
            sql`${automationRuns.status} in ('queued', 'running', 'verifying', 'retry_wait')`
          )
        )
        .orderBy(asc(automationRuns.availableAt), asc(automationRuns.createdAt), asc(automationRuns.id))
        .limit(1)
        .for("update", { skipLocked: true });

      if (!candidate) {
        return undefined;
      }

      if (candidate.status === "retry_wait") {
        await transaction.insert(runEvents).values({
          createdAt: now,
          eventType: "retry_available",
          fromStatus: "retry_wait",
          id: randomUUID(),
          payload: {},
          runId: candidate.id,
          toStatus: "queued"
        });
      }

      const starting = candidate.status === "queued" || candidate.status === "retry_wait";
      const status = starting ? "running" : candidate.status;
      const [claimed] = await transaction
        .update(automationRuns)
        .set({
          attempt: sql`${automationRuns.attempt} + 1`,
          claimedAt: now,
          claimedBy,
          leaseExpiresAt: expiresAt,
          startedAt: sql`coalesce(${automationRuns.startedAt}, ${now})`,
          status,
          updatedAt: now
        })
        .where(eq(automationRuns.id, candidate.id))
        .returning();

      await transaction.insert(runEvents).values({
        createdAt: now,
        eventType: starting ? "run_started" : "lease_acquired",
        fromStatus: starting ? "queued" : null,
        id: randomUUID(),
        payload: {},
        runId: candidate.id,
        toStatus: starting ? "running" : null
      });

      return claimed!;
    });
  }

  async function renewLease(runId: string, workerId: string, now: Date, leaseDurationMs: number) {
    const claimedBy = safeText.min(1).parse(workerId);
    const expiresAt = leaseExpiry(now, leaseDurationMs);
    const [run] = await database
      .update(automationRuns)
      .set({ leaseExpiresAt: expiresAt, updatedAt: now })
      .where(
        and(
          eq(automationRuns.id, runId),
          eq(automationRuns.claimedBy, claimedBy),
          sql`${automationRuns.leaseExpiresAt} > ${now}`
        )
      )
      .returning();
    return run;
  }

  async function saveCheckpoint(input: {
    checkpoint: JsonObject;
    now: Date;
    runId: string;
    workerId: string;
    workflowPhase: string;
  }) {
    const checkpoint = safeJson.parse(input.checkpoint);
    const claimedBy = safeText.min(1).parse(input.workerId);
    const workflowPhase = safeText.min(1).max(200).parse(input.workflowPhase);

    return database.transaction(async (transaction) => {
      const [run] = await transaction
        .update(automationRuns)
        .set({ checkpoint, updatedAt: input.now, workflowPhase })
        .where(
          and(
            eq(automationRuns.id, input.runId),
            eq(automationRuns.claimedBy, claimedBy),
            sql`${automationRuns.leaseExpiresAt} > ${input.now}`
          )
        )
        .returning();

      if (!run) {
        throw new RunLeaseError("Cannot save checkpoint without a current run lease");
      }

      await transaction.insert(runEvents).values({
        createdAt: input.now,
        eventType: "checkpoint_saved",
        id: randomUUID(),
        payload: { workflowPhase },
        runId: input.runId
      });
      return run;
    });
  }

  async function transitionRun(input: {
    availableAt?: Date;
    checkpoint?: JsonObject;
    errorSummary?: string;
    now: Date;
    payload?: JsonObject;
    resultSummary?: string;
    runId: string;
    toStatus: RunStatus;
    workerId?: string;
    workflowPhase?: string;
  }) {
    const toStatus = automationRunStatusSchema.parse(input.toStatus);
    const checkpoint = input.checkpoint === undefined ? undefined : safeJson.parse(input.checkpoint);
    const payload = safeJson.parse(input.payload ?? {});
    const workerId = input.workerId === undefined ? undefined : safeText.min(1).parse(input.workerId);
    const workflowPhase =
      input.workflowPhase === undefined ? undefined : safeText.min(1).max(200).parse(input.workflowPhase);

    return database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.id, input.runId))
        .limit(1)
        .for("update");

      if (!current) {
        throw new Error("Automation run not found");
      }

      const fromStatus = automationRunStatusSchema.parse(current.status);

      if (!validTransitions[fromStatus].includes(toStatus)) {
        throw new InvalidRunTransitionError(fromStatus, toStatus);
      }

      if (current.claimedBy && current.claimedBy !== workerId) {
        throw new RunLeaseError("Automation run is leased by another worker");
      }

      if (current.claimedBy && current.leaseExpiresAt && current.leaseExpiresAt <= input.now) {
        throw new RunLeaseError("Automation run lease has expired");
      }

      if (toStatus === "retry_wait" && !input.availableAt) {
        throw new Error("retry_wait requires availableAt");
      }

      if (fromStatus === "retry_wait" && current.availableAt > input.now) {
        throw new Error("retry_wait is not available yet");
      }

      const clearsLease = ["queued", "retry_wait", "needs_human", "succeeded", "failed", "blocked", "cancelled"].includes(toStatus);
      const terminal = ["succeeded", "failed", "blocked", "cancelled"].includes(toStatus);
      const [updated] = await transaction
        .update(automationRuns)
        .set({
          availableAt: input.availableAt ?? current.availableAt,
          checkpoint: checkpoint ?? current.checkpoint,
          claimedAt: clearsLease ? null : current.claimedAt,
          claimedBy: clearsLease ? null : current.claimedBy,
          completedAt: terminal ? input.now : null,
          errorSummary:
            input.errorSummary === undefined ? current.errorSummary : safeText.parse(input.errorSummary),
          leaseExpiresAt: clearsLease ? null : current.leaseExpiresAt,
          resultSummary:
            input.resultSummary === undefined ? current.resultSummary : safeText.parse(input.resultSummary),
          status: toStatus,
          updatedAt: input.now,
          workflowPhase: workflowPhase ?? current.workflowPhase
        })
        .where(eq(automationRuns.id, input.runId))
        .returning();

      await transaction.insert(runEvents).values({
        createdAt: input.now,
        eventType: "status_changed",
        fromStatus,
        id: randomUUID(),
        payload,
        runId: input.runId,
        toStatus
      });
      return updated!;
    });
  }

  async function recoverExpiredLeases(now: Date, limit = 100) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Recovery batch limit must be a positive integer");
    }

    return database.transaction(async (transaction) => {
      const expired = await transaction
        .select()
        .from(automationRuns)
        .where(
          and(
            lte(automationRuns.leaseExpiresAt, now),
            sql`${automationRuns.status} in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human')`
          )
        )
        .orderBy(asc(automationRuns.leaseExpiresAt), asc(automationRuns.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      const recovered = [];

      for (const run of expired) {
        const unknown = run.status === "running" && unresolvedConsequentialOperation(run.checkpoint);
        const checkpoint = unknown
          ? {
              ...run.checkpoint,
              pendingConsequentialOperation: {
                ...(run.checkpoint.pendingConsequentialOperation as JsonObject),
                outcome: "unknown"
              }
            }
          : run.checkpoint;
        const status = unknown ? "verifying" : run.status;
        const [updated] = await transaction
          .update(automationRuns)
          .set({
            checkpoint,
            claimedAt: null,
            claimedBy: null,
            leaseExpiresAt: null,
            status,
            updatedAt: now
          })
          .where(eq(automationRuns.id, run.id))
          .returning();

        await transaction.insert(runEvents).values({
          createdAt: now,
          eventType: unknown ? "consequential_outcome_unknown" : "lease_expired",
          fromStatus: unknown ? "running" : null,
          id: randomUUID(),
          payload: {},
          runId: run.id,
          toStatus: unknown ? "verifying" : null
        });
        recovered.push(updated!);
      }

      return recovered;
    });
  }

  return { claimRun, recoverExpiredLeases, renewLease, saveCheckpoint, transitionRun };
}
