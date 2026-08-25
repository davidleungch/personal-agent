import { randomUUID } from "node:crypto";
import {
  automationRuns,
  evidence,
  idempotencyRecords,
  runEvents,
  toolCalls,
  type Database
} from "@personal-agent/db";
import {
  automationRunStatusSchema,
  idempotencyStateSchema,
  type JsonObject
} from "@personal-agent/shared";
import { and, eq } from "drizzle-orm";
import type { FailureClass, ToolEvidence, ToolStatus } from "./contract.js";

export type ToolAuditInput = {
  attempt: number;
  completedAt: Date;
  externalId?: string;
  failureClass?: FailureClass;
  idempotencyKey?: string;
  inputSummary: string;
  outputSummary: string;
  requestedAt: Date;
  runId: string;
  sideEffectClass: "read_only" | "reversible" | "consequential";
  status: ToolStatus;
  tool: string;
};

export type IdempotencyRecord = {
  key: string;
  runId: string;
  scope: string;
  state: "reserved" | "confirmed" | "unknown";
};

export interface ToolPersistence {
  audit(input: ToolAuditInput, evidenceItems: readonly ToolEvidence[]): Promise<string>;
  markConsequentialOutcome(input: {
    idempotencyKey: string;
    now: Date;
    outcome: "absent" | "confirmed" | "failed" | "unknown";
    runId: string;
    tool: string;
  }): Promise<void>;
  markConsequentialPending(input: {
    idempotencyKey: string;
    now: Date;
    runId: string;
    tool: string;
  }): Promise<void>;
  readIdempotency(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  reserveIdempotency(input: {
    key: string;
    now: Date;
    runId: string;
    scope: string;
  }): Promise<{ inserted: boolean; record: IdempotencyRecord }>;
  transitionIdempotency(input: {
    expected: "reserved" | "unknown";
    key: string;
    now: Date;
    scope: string;
    state: "reserved" | "confirmed" | "unknown";
  }): Promise<boolean>;
}

function operationCheckpoint(
  checkpoint: JsonObject,
  input: { idempotencyKey: string; outcome: string; tool: string }
): JsonObject {
  return {
    ...checkpoint,
    pendingConsequentialOperation: {
      idempotencyKey: input.idempotencyKey,
      outcome: input.outcome,
      tool: input.tool
    }
  };
}

export function createDatabaseToolPersistence(database: Database): ToolPersistence {
  return {
    audit: async (input, evidenceItems) => {
      const toolCallId = randomUUID();
      await database.transaction(async (transaction) => {
        await transaction.insert(toolCalls).values({
          attempt: input.attempt,
          completedAt: input.completedAt,
          externalId: input.externalId ?? null,
          failureClass: input.failureClass ?? null,
          id: toolCallId,
          idempotencyKey: input.idempotencyKey ?? null,
          inputSummary: input.inputSummary,
          outputSummary: input.outputSummary,
          requestedAt: input.requestedAt,
          runId: input.runId,
          sideEffectClass: input.sideEffectClass,
          status: input.status,
          tool: input.tool
        });
        for (const item of evidenceItems) {
          await transaction.insert(evidence).values({
            evidenceType: item.type,
            id: randomUUID(),
            payload: item.payload,
            runId: input.runId,
            toolCallId
          });
        }
      });
      return toolCallId;
    },

    markConsequentialOutcome: async (input) => {
      await database.transaction(async (transaction) => {
        const [run] = await transaction
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.id, input.runId))
          .limit(1)
          .for("update");
        if (!run) throw new Error("Automation run not found");
        const fromStatus = automationRunStatusSchema.parse(run.status);
        const entersVerification = input.outcome === "unknown" && fromStatus === "running";
        const status = entersVerification ? "verifying" : fromStatus;
        await transaction
          .update(automationRuns)
          .set({
            checkpoint: operationCheckpoint(run.checkpoint, input),
            status,
            updatedAt: input.now,
            workflowPhase: input.outcome === "unknown" ? "verifying_tool_call" : "tool_call_recorded"
          })
          .where(eq(automationRuns.id, input.runId));
        await transaction.insert(runEvents).values({
          createdAt: input.now,
          eventType:
            input.outcome === "unknown" ? "consequential_outcome_unknown" : "tool_outcome_recorded",
          fromStatus: entersVerification ? fromStatus : null,
          id: randomUUID(),
          payload: {
            idempotencyKey: input.idempotencyKey,
            outcome: input.outcome,
            tool: input.tool
          },
          runId: input.runId,
          toStatus: entersVerification ? status : null
        });
      });
    },

    markConsequentialPending: async (input) => {
      await database.transaction(async (transaction) => {
        const [run] = await transaction
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.id, input.runId))
          .limit(1)
          .for("update");
        if (!run) throw new Error("Automation run not found");
        await transaction
          .update(automationRuns)
          .set({
            checkpoint: operationCheckpoint(run.checkpoint, { ...input, outcome: "pending" }),
            updatedAt: input.now,
            workflowPhase: "tool_call_pending"
          })
          .where(eq(automationRuns.id, input.runId));
        await transaction.insert(runEvents).values({
          createdAt: input.now,
          eventType: "consequential_operation_pending",
          id: randomUUID(),
          payload: { idempotencyKey: input.idempotencyKey, tool: input.tool },
          runId: input.runId
        });
      });
    },

    readIdempotency: async (scope, key) => {
      const [record] = await database
        .select()
        .from(idempotencyRecords)
        .where(and(eq(idempotencyRecords.scope, scope), eq(idempotencyRecords.key, key)))
        .limit(1);
      if (!record) return undefined;
      return {
        key: record.key,
        runId: record.runId,
        scope: record.scope,
        state: idempotencyStateSchema.parse(record.state)
      };
    },

    reserveIdempotency: async (input) => {
      return database.transaction(async (transaction) => {
        const inserted = await transaction
          .insert(idempotencyRecords)
          .values({
            createdAt: input.now,
            id: randomUUID(),
            key: input.key,
            runId: input.runId,
            scope: input.scope,
            state: "reserved",
            updatedAt: input.now
          })
          .onConflictDoNothing()
          .returning();
        const record =
          inserted[0] ??
          (
            await transaction
              .select()
              .from(idempotencyRecords)
              .where(
                and(eq(idempotencyRecords.scope, input.scope), eq(idempotencyRecords.key, input.key))
              )
              .limit(1)
          )[0];
        return {
          inserted: inserted.length === 1,
          record: {
            key: record!.key,
            runId: record!.runId,
            scope: record!.scope,
            state: idempotencyStateSchema.parse(record!.state)
          }
        };
      });
    },

    transitionIdempotency: async (input) => {
      const [record] = await database
        .update(idempotencyRecords)
        .set({ state: input.state, updatedAt: input.now })
        .where(
          and(
            eq(idempotencyRecords.scope, input.scope),
            eq(idempotencyRecords.key, input.key),
            eq(idempotencyRecords.state, input.expected)
          )
        )
        .returning({ id: idempotencyRecords.id });
      return Boolean(record);
    }
  };
}
