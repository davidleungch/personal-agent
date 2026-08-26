import { randomUUID } from "node:crypto";
import {
  automationRuns,
  automations,
  commandRequests,
  createRepositories,
  evidence,
  modelInvocations,
  runEvents,
  toolCalls,
  type Database
} from "@personal-agent/db";
import {
  automationRunStatusSchema,
  canTransitionAutomationRun,
  completionModeSchema,
  createSecretFreeTextSchema,
  modelProfileSchema,
  toolPolicySchema
} from "@personal-agent/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { Cron } from "croner";
import { z } from "zod";

export type ApplicationErrorCode =
  | "configuration_error"
  | "integration_unavailable"
  | "invalid_request"
  | "invalid_transition"
  | "not_found"
  | "policy_denied"
  | "version_conflict";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly status: number;

  constructor(code: ApplicationErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.name = "ApplicationError";
    this.status = status;
  }
}

const uuidSchema = z.string().uuid();
const safeText = createSecretFreeTextSchema();
const nameSchema = z.string().trim().min(1).max(200).pipe(safeText);
const goalSchema = z.string().trim().min(1).max(8_000).pipe(safeText);
const commandContentSchema = z.string().trim().min(1).max(8_000).pipe(safeText);
const timezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Timezone must be a valid IANA timezone");
const scheduleSchema = z.string().trim().refine((value) => {
  if (value.split(/\s+/).length !== 5) return false;
  try {
    new Cron(value, { mode: "5-part", paused: true, timezone: "UTC" });
    return true;
  } catch {
    return false;
  }
}, "Schedule must be a valid five-field cron expression");

export const commandCreateSchema = z.object({ content: commandContentSchema }).strict();
export const automationCreateSchema = z.object({
  completionMode: completionModeSchema,
  enabled: z.boolean().default(true),
  goal: goalSchema,
  modelProfile: modelProfileSchema,
  name: nameSchema,
  schedule: scheduleSchema,
  timezone: timezoneSchema.default("Asia/Hong_Kong"),
  toolPolicy: toolPolicySchema
}).strict();
const automationMutableSchema = z.object({
  completionMode: completionModeSchema,
  enabled: z.boolean(),
  goal: goalSchema,
  modelProfile: modelProfileSchema,
  name: nameSchema,
  schedule: scheduleSchema,
  timezone: timezoneSchema,
  toolPolicy: toolPolicySchema
}).partial();
export const automationUpdateSchema = automationMutableSchema.extend({
  version: z.number().int().positive()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "version"),
  "At least one mutable field is required"
);
export const emptyResumeSchema = z.object({}).strict();
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0)
}).strict();
export const runDetailBoundsSchema = z.object({
  evidenceLimit: z.coerce.number().int().min(1).max(50).default(20),
  eventLimit: z.coerce.number().int().min(1).max(50).default(20),
  modelLimit: z.coerce.number().int().min(1).max(50).default(20),
  toolLimit: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

const workerHealthSchema = z.object({
  integrations: z.object({
    browser: z.enum(["available", "unavailable"]),
    google: z.enum(["available", "unavailable"]),
    openai: z.enum(["available", "unavailable"])
  }).strict(),
  service: z.literal("worker"),
  status: z.literal("ok")
}).strict();

export type IntegrationStatus = z.infer<typeof workerHealthSchema>["integrations"];

const unavailableIntegrations: IntegrationStatus = {
  browser: "unavailable",
  google: "unavailable",
  openai: "unavailable"
};

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function nextOccurrence(schedule: string, timezone: string, now: Date): Date {
  return new Cron(schedule, {
    mode: "5-part",
    paused: true,
    timezone
  }).nextRun(now)!;
}

function commandView(command: typeof commandRequests.$inferSelect) {
  return {
    completedAt: iso(command.completedAt),
    content: command.content,
    createdAt: command.createdAt.toISOString(),
    errorSummary: command.errorSummary,
    id: command.id,
    intentType: command.intentType,
    status: command.status,
    updatedAt: command.updatedAt.toISOString()
  };
}

function automationView(automation: typeof automations.$inferSelect) {
  return {
    completionMode: automation.completionMode,
    createdAt: automation.createdAt.toISOString(),
    enabled: automation.enabled,
    goal: automation.goal,
    id: automation.id,
    lastRunAt: iso(automation.lastRunAt),
    modelProfile: automation.modelProfile,
    name: automation.name,
    nextRunAt: automation.nextRunAt.toISOString(),
    schedule: automation.schedule,
    timezone: automation.timezone,
    toolPolicy: automation.toolPolicy,
    updatedAt: automation.updatedAt.toISOString(),
    version: automation.version
  };
}

function runView(run: typeof automationRuns.$inferSelect, automation: { id: string; name: string }) {
  return {
    attempt: run.attempt,
    automation,
    completedAt: iso(run.completedAt),
    createdAt: run.createdAt.toISOString(),
    errorSummary: run.errorSummary,
    id: run.id,
    modelProfile: run.modelProfile,
    resultSummary: run.resultSummary,
    scheduledFor: iso(run.scheduledFor),
    startedAt: iso(run.startedAt),
    status: run.status,
    trigger: run.trigger,
    updatedAt: run.updatedAt.toISOString(),
    workflowPhase: run.workflowPhase
  };
}

function usageView(value: Record<string, unknown>) {
  return {
    ...(typeof value.inputTokens === "number" ? { inputTokens: value.inputTokens } : {}),
    ...(typeof value.outputTokens === "number" ? { outputTokens: value.outputTokens } : {}),
    ...(typeof value.totalTokens === "number" ? { totalTokens: value.totalTokens } : {})
  };
}

export async function readWorkerHealth(
  workerHealthUrl: string,
  fetcher: typeof fetch = fetch
): Promise<{ integrations: IntegrationStatus; worker: "available" | "unavailable" }> {
  try {
    const response = await fetcher(workerHealthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { integrations: unavailableIntegrations, worker: "unavailable" };
    const parsed = workerHealthSchema.safeParse(await response.json());
    return parsed.success
      ? { integrations: parsed.data.integrations, worker: "available" }
      : { integrations: unavailableIntegrations, worker: "unavailable" };
  } catch {
    return { integrations: unavailableIntegrations, worker: "unavailable" };
  }
}

export function createProductService(
  database: Database,
  options: {
    clock?: () => Date;
    readIntegrations?: () => Promise<{
      integrations: IntegrationStatus;
      worker: "available" | "unavailable";
    }>;
  } = {}
) {
  const clock = options.clock ?? (() => new Date());
  const repositories = createRepositories(database);
  const readIntegrations = options.readIntegrations ?? (async () => ({
    integrations: unavailableIntegrations,
    worker: "unavailable" as const
  }));

  async function createCommand(input: unknown) {
    const value = commandCreateSchema.parse(input);
    return commandView(await repositories.createCommandRequest({ content: value.content }));
  }

  async function getCommand(id: unknown) {
    const parsedId = uuidSchema.parse(id);
    const command = await repositories.getCommandRequest(parsedId);
    if (!command) throw new ApplicationError("not_found", 404, "Command request not found");
    return commandView(command);
  }

  async function listAutomations(input: unknown) {
    const page = paginationSchema.parse(input);
    const rows = await database
      .select()
      .from(automations)
      .orderBy(desc(automations.createdAt), desc(automations.id))
      .limit(page.limit)
      .offset(page.offset);
    return { items: rows.map(automationView), page: { ...page, count: rows.length } };
  }

  async function createAutomation(input: unknown) {
    const value = automationCreateSchema.parse(input);
    const now = clock();
    const automation = await repositories.createAutomation({
      ...value,
      nextRunAt: nextOccurrence(value.schedule, value.timezone, now)
    });
    return automationView(automation);
  }

  async function updateAutomation(id: unknown, input: unknown) {
    const parsedId = uuidSchema.parse(id);
    const value = automationUpdateSchema.parse(input);
    return database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(automations)
        .where(eq(automations.id, parsedId))
        .limit(1)
        .for("update");
      if (!current) throw new ApplicationError("not_found", 404, "Automation not found");
      if (current.version !== value.version) {
        throw new ApplicationError("version_conflict", 409, "Automation has changed; reload and retry");
      }

      const schedule = value.schedule ?? current.schedule;
      const timezone = value.timezone ?? current.timezone;
      const enabled = value.enabled ?? current.enabled;
      const shouldRecalculate =
        value.schedule !== undefined ||
        value.timezone !== undefined ||
        (value.enabled === true && !current.enabled);
      const now = clock();
      const [updated] = await transaction
        .update(automations)
        .set({
          completionMode: value.completionMode ?? current.completionMode,
          enabled,
          goal: value.goal ?? current.goal,
          modelProfile: value.modelProfile ?? current.modelProfile,
          name: value.name ?? current.name,
          nextRunAt: shouldRecalculate ? nextOccurrence(schedule, timezone, now) : current.nextRunAt,
          schedule,
          timezone,
          toolPolicy: value.toolPolicy ?? current.toolPolicy,
          updatedAt: now,
          version: sql`${automations.version} + 1`
        })
        .where(and(eq(automations.id, parsedId), eq(automations.version, value.version)))
        .returning();
      return automationView(updated!);
    });
  }

  async function listRuns(input: unknown) {
    const page = paginationSchema.parse(input);
    const rows = await database
      .select({ automation: { id: automations.id, name: automations.name }, run: automationRuns })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
      .limit(page.limit)
      .offset(page.offset);
    return {
      items: rows.map(({ automation, run }) => runView(run, automation)),
      page: { ...page, count: rows.length }
    };
  }

  async function getRun(id: unknown, boundsInput: unknown) {
    const parsedId = uuidSchema.parse(id);
    const bounds = runDetailBoundsSchema.parse(boundsInput);
    const [row] = await database
      .select({ automation: { id: automations.id, name: automations.name }, run: automationRuns })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .where(eq(automationRuns.id, parsedId))
      .limit(1);
    if (!row) throw new ApplicationError("not_found", 404, "Automation run not found");

    const [events, evidenceRows, tools, models] = await Promise.all([
      database
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, parsedId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(bounds.eventLimit),
      database
        .select({
          createdAt: evidence.createdAt,
          externalId: toolCalls.externalId,
          id: evidence.id,
          tool: toolCalls.tool,
          type: evidence.evidenceType
        })
        .from(evidence)
        .leftJoin(
          toolCalls,
          and(eq(evidence.toolCallId, toolCalls.id), eq(evidence.runId, toolCalls.runId))
        )
        .where(eq(evidence.runId, parsedId))
        .orderBy(desc(evidence.createdAt), desc(evidence.id))
        .limit(bounds.evidenceLimit),
      database
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.runId, parsedId))
        .orderBy(desc(toolCalls.requestedAt), desc(toolCalls.id))
        .limit(bounds.toolLimit),
      database
        .select()
        .from(modelInvocations)
        .where(eq(modelInvocations.runId, parsedId))
        .orderBy(desc(modelInvocations.startedAt), desc(modelInvocations.id))
        .limit(bounds.modelLimit)
    ]);

    return {
      ...runView(row.run, row.automation),
      evidence: evidenceRows.map((item) => ({
        createdAt: item.createdAt.toISOString(),
        externalId: item.externalId,
        id: item.id,
        tool: item.tool,
        type: item.type
      })),
      events: events.map((event) => ({
        createdAt: event.createdAt.toISOString(),
        eventType: event.eventType,
        fromStatus: event.fromStatus,
        id: event.id,
        toStatus: event.toStatus
      })),
      modelInvocations: models.map((model) => ({
        completedAt: iso(model.completedAt),
        id: model.id,
        latencyMs: model.latencyMs,
        modelProfile: model.modelProfile,
        role: model.role,
        schemaOutcome: model.schemaOutcome,
        startedAt: model.startedAt.toISOString(),
        status: model.status,
        summary: model.summary,
        usage: usageView(model.usage)
      })),
      toolCalls: tools.map((tool) => ({
        attempt: tool.attempt,
        completedAt: iso(tool.completedAt),
        externalId: tool.externalId,
        failureClass: tool.failureClass,
        id: tool.id,
        requestedAt: tool.requestedAt.toISOString(),
        sideEffectClass: tool.sideEffectClass,
        status: tool.status,
        tool: tool.tool
      }))
    };
  }

  async function resumeRun(id: unknown, input: unknown) {
    const parsedId = uuidSchema.parse(id);
    emptyResumeSchema.parse(input);
    return database.transaction(async (transaction) => {
      const [run] = await transaction
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.id, parsedId))
        .limit(1)
        .for("update");
      if (!run) throw new ApplicationError("not_found", 404, "Automation run not found");

      const status = automationRunStatusSchema.parse(run.status);
      if (status === "queued") {
        const [priorResume] = await transaction
          .select({ id: runEvents.id })
          .from(runEvents)
          .where(and(
            eq(runEvents.runId, parsedId),
            eq(runEvents.eventType, "status_changed"),
            eq(runEvents.fromStatus, "needs_human"),
            eq(runEvents.toStatus, "queued")
          ))
          .limit(1);
        if (priorResume) return { id: run.id, resumed: false, status: "queued" as const };
      }

      if (!canTransitionAutomationRun(status, "queued")) {
        throw new ApplicationError(
          "invalid_transition",
          409,
          "Only a needs_human run can be resumed"
        );
      }

      const now = clock();
      const [updated] = await transaction
        .update(automationRuns)
        .set({
          availableAt: now,
          claimedAt: null,
          claimedBy: null,
          completedAt: null,
          leaseExpiresAt: null,
          status: "queued",
          updatedAt: now
        })
        .where(eq(automationRuns.id, parsedId))
        .returning({ id: automationRuns.id, status: automationRuns.status });
      await transaction.insert(runEvents).values({
        createdAt: now,
        eventType: "status_changed",
        fromStatus: "needs_human",
        id: randomUUID(),
        payload: { reason: "human_resume" },
        runId: parsedId,
        toStatus: "queued"
      });
      return { id: updated!.id, resumed: true, status: "queued" as const };
    });
  }

  async function getStatus() {
    await database.execute(sql`select 1`);
    const worker = await readIntegrations();
    return {
      database: "available" as const,
      integrations: worker.integrations,
      service: "app" as const,
      status: "ok" as const,
      worker: worker.worker
    };
  }

  return {
    createAutomation,
    createCommand,
    getCommand,
    getRun,
    getStatus,
    listAutomations,
    listRuns,
    resumeRun,
    updateAutomation
  };
}

export type ProductService = ReturnType<typeof createProductService>;
