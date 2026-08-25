import { randomUUID } from "node:crypto";
import {
  automationRunStatusSchema,
  automationRunTriggerSchema,
  commandStatusSchema,
  createSecretFreeJsonSchema,
  createSecretFreeTextSchema,
  idempotencyStateSchema,
  intentTypeSchema,
  isDurableJson,
  modelProfileSchema,
  redactText,
  sideEffectClassSchema,
  toolStatusSchema
} from "@personal-agent/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import {
  automationRuns,
  automations,
  commandRequests,
  evidence,
  idempotencyRecords,
  modelInvocations,
  runEvents,
  toolCalls
} from "./schema.js";

const nonEmpty = z.string().trim().min(1);
const identifier = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();

function ianaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function createRepositories(database: Database, knownSecrets: readonly string[] = []) {
  const secretFreeText = createSecretFreeTextSchema(knownSecrets);
  const secretFreeJson = createSecretFreeJsonSchema(knownSecrets)
    .refine((value) => JSON.stringify(value).length <= 32_768, "Durable JSON is too large")
    .refine(isDurableJson, "Prompts, transcripts, external content, and provider model IDs are not durable data");
  const safeNonEmpty = nonEmpty.pipe(secretFreeText);

  const commandInput = z.object({
    content: safeNonEmpty,
    errorSummary: z.string().optional(),
    intentType: intentTypeSchema.optional(),
    status: commandStatusSchema.default("pending"),
    structuredResult: secretFreeJson.optional()
  });

  const automationInput = z.object({
    completionMode: z.enum(["continue", "stop_after_success"]),
    enabled: z.boolean().default(true),
    goal: safeNonEmpty,
    lastRunAt: z.date().optional(),
    modelProfile: modelProfileSchema,
    name: safeNonEmpty,
    nextRunAt: z.date(),
    schedule: z
      .string()
      .trim()
      .refine((value) => value.split(/\s+/).length === 5, "Schedule must have exactly five fields"),
    timezone: z
      .string()
      .default("Asia/Hong_Kong")
      .refine(ianaTimezone, "Timezone must be a valid IANA timezone"),
    toolPolicy: identifier.pipe(secretFreeText)
  });

  const runInput = z
    .object({
      attempt: z.number().int().nonnegative().default(0),
      automationId: uuid,
      availableAt: z.date(),
      checkpoint: secretFreeJson.default({}),
      errorSummary: z.string().optional(),
      modelProfile: modelProfileSchema,
      resultSummary: z.string().optional(),
      scheduledFor: z.date().optional(),
      status: automationRunStatusSchema.default("queued"),
      trigger: automationRunTriggerSchema,
      workflowPhase: identifier.pipe(secretFreeText)
    })
    .refine(
      (value) => (value.trigger === "scheduled") === Boolean(value.scheduledFor),
      "Scheduled runs require scheduledFor and other triggers forbid it"
    );

  const runEventInput = z.object({
    eventType: identifier.pipe(secretFreeText),
    fromStatus: automationRunStatusSchema.optional(),
    payload: secretFreeJson.default({}),
    runId: uuid,
    toStatus: automationRunStatusSchema.optional()
  });

  const modelInvocationInput = z.object({
    completedAt: z.date().optional(),
    executionModelId: identifier.pipe(secretFreeText),
    latencyMs: z.number().int().nonnegative().optional(),
    modelProfile: modelProfileSchema,
    role: z.enum(["intent_router", "extractor", "general", "planner", "verification"]),
    runId: uuid,
    schemaOutcome: z.enum(["not_requested", "valid", "invalid"]),
    startedAt: z.date().optional(),
    status: z.enum(["started", "succeeded", "failed"]),
    summary: z.string().optional(),
    usage: secretFreeJson.default({})
  });

  const toolCallInput = z.object({
    attempt: z.number().int().positive(),
    completedAt: z.date().optional(),
    externalId: identifier.pipe(secretFreeText).optional(),
    failureClass: identifier.pipe(secretFreeText).optional(),
    idempotencyKey: identifier.pipe(secretFreeText).optional(),
    inputSummary: z.string().optional(),
    outputSummary: z.string().optional(),
    requestedAt: z.date().optional(),
    runId: uuid,
    sideEffectClass: sideEffectClassSchema,
    status: toolStatusSchema,
    tool: identifier.pipe(secretFreeText)
  });

  const idempotencyInput = z.object({
    key: identifier.pipe(secretFreeText),
    runId: uuid,
    scope: identifier.pipe(secretFreeText),
    state: idempotencyStateSchema
  });

  const evidenceInput = z.object({
    evidenceType: identifier.pipe(secretFreeText),
    payload: secretFreeJson,
    runId: uuid,
    toolCallId: uuid.optional()
  });

  return {
    addEvidence: async (input: z.input<typeof evidenceInput>) => {
      const value = evidenceInput.parse(input);
      const [record] = await database
        .insert(evidence)
        .values({
          evidenceType: value.evidenceType,
          id: randomUUID(),
          payload: value.payload,
          runId: value.runId,
          toolCallId: value.toolCallId ?? null
        })
        .returning();
      return record!;
    },
    appendRunEvent: async (input: z.input<typeof runEventInput>) => {
      const value = runEventInput.parse(input);
      const [record] = await database
        .insert(runEvents)
        .values({
          eventType: value.eventType,
          fromStatus: value.fromStatus ?? null,
          id: randomUUID(),
          payload: value.payload,
          runId: value.runId,
          toStatus: value.toStatus ?? null
        })
        .returning();
      return record!;
    },
    createAutomation: async (input: z.input<typeof automationInput>) => {
      const value = automationInput.parse(input);
      const [record] = await database
        .insert(automations)
        .values({
          completionMode: value.completionMode,
          enabled: value.enabled,
          goal: value.goal,
          id: randomUUID(),
          lastRunAt: value.lastRunAt ?? null,
          modelProfile: value.modelProfile,
          name: value.name,
          nextRunAt: value.nextRunAt,
          schedule: value.schedule,
          timezone: value.timezone,
          toolPolicy: value.toolPolicy
        })
        .returning();
      return record!;
    },
    createAutomationRun: async (input: z.input<typeof runInput>) => {
      const value = runInput.parse(input);
      const [record] = await database
        .insert(automationRuns)
        .values({
          attempt: value.attempt,
          automationId: value.automationId,
          availableAt: value.availableAt,
          checkpoint: value.checkpoint,
          errorSummary: value.errorSummary ? redactText(value.errorSummary, knownSecrets) : null,
          id: randomUUID(),
          modelProfile: value.modelProfile,
          resultSummary: value.resultSummary ? redactText(value.resultSummary, knownSecrets) : null,
          scheduledFor: value.scheduledFor ?? null,
          status: value.status,
          trigger: value.trigger,
          workflowPhase: value.workflowPhase
        })
        .returning();
      return record!;
    },
    createCommandRequest: async (input: z.input<typeof commandInput>) => {
      const value = commandInput.parse(input);
      const [record] = await database
        .insert(commandRequests)
        .values({
          content: value.content,
          errorSummary: value.errorSummary ? redactText(value.errorSummary, knownSecrets) : null,
          id: randomUUID(),
          intentType: value.intentType ?? null,
          status: value.status,
          structuredResult: value.structuredResult ?? null
        })
        .returning();
      return record!;
    },
    createIdempotencyRecord: async (input: z.input<typeof idempotencyInput>) => {
      const value = idempotencyInput.parse(input);
      const [record] = await database
        .insert(idempotencyRecords)
        .values({ id: randomUUID(), ...value })
        .returning();
      return record!;
    },
    getAutomation: async (id: string) => {
      const [record] = await database
        .select()
        .from(automations)
        .where(eq(automations.id, uuid.parse(id)))
        .limit(1);
      return record;
    },
    getAutomationRun: async (id: string) => {
      const [record] = await database
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.id, uuid.parse(id)))
        .limit(1);
      return record;
    },
    getCommandRequest: async (id: string) => {
      const [record] = await database
        .select()
        .from(commandRequests)
        .where(eq(commandRequests.id, uuid.parse(id)))
        .limit(1);
      return record;
    },
    recordModelInvocation: async (input: z.input<typeof modelInvocationInput>) => {
      const value = modelInvocationInput.parse(input);
      const [record] = await database
        .insert(modelInvocations)
        .values({
          completedAt: value.completedAt ?? null,
          executionModelId: value.executionModelId,
          id: randomUUID(),
          latencyMs: value.latencyMs ?? null,
          modelProfile: value.modelProfile,
          role: value.role,
          runId: value.runId,
          schemaOutcome: value.schemaOutcome,
          startedAt: value.startedAt,
          status: value.status,
          summary: value.summary ? redactText(value.summary, knownSecrets) : null,
          usage: value.usage
        })
        .returning();
      return record!;
    },
    recordToolCall: async (input: z.input<typeof toolCallInput>) => {
      const value = toolCallInput.parse(input);
      const [record] = await database
        .insert(toolCalls)
        .values({
          attempt: value.attempt,
          completedAt: value.completedAt ?? null,
          externalId: value.externalId ?? null,
          failureClass: value.failureClass ?? null,
          id: randomUUID(),
          idempotencyKey: value.idempotencyKey ?? null,
          inputSummary: value.inputSummary ? redactText(value.inputSummary, knownSecrets) : null,
          outputSummary: value.outputSummary ? redactText(value.outputSummary, knownSecrets) : null,
          requestedAt: value.requestedAt,
          runId: value.runId,
          sideEffectClass: value.sideEffectClass,
          status: value.status,
          tool: value.tool
        })
        .returning();
      return record!;
    }
  };
}
