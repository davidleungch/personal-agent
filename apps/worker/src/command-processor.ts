import { randomUUID } from "node:crypto";
import {
  automationCommandDecisionSchema,
  resolveModelId,
  type ModelMap,
  type ModelTransport
} from "@personal-agent/agents";
import { automations, commandRequests, type Database } from "@personal-agent/db";
import {
  createSecretFreeJsonSchema,
  createSecretFreeTextSchema,
  redactText,
  type JsonObject
} from "@personal-agent/shared";
import { and, asc, eq, gte, lte, or } from "drizzle-orm";
import { Cron } from "croner";

export class CommandLeaseError extends Error {
  constructor() {
    super("Command request lease is not current");
    this.name = "CommandLeaseError";
  }
}

function leaseExpiry(now: Date, leaseDurationMs: number): Date {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Command lease duration must be a positive integer");
  }
  return new Date(now.getTime() + leaseDurationMs);
}

function nextOccurrence(schedule: string, timezone: string, now: Date): Date {
  if (schedule.split(/\s+/).length !== 5) {
    throw new Error("Command automation schedule must have five fields");
  }
  try {
    const occurrence = new Cron(schedule, { mode: "5-part", paused: true, timezone }).nextRun(now);
    if (!occurrence) throw new Error("No future occurrence");
    return occurrence;
  } catch {
    throw new Error("Command automation schedule or timezone is invalid");
  }
}

export function createCommandProcessor(options: {
  clock?: () => Date;
  database: Database;
  knownSecrets?: readonly string[];
  leaseDurationMs?: number;
  models: ModelMap;
  transport?: ModelTransport;
}) {
  const clock = options.clock ?? (() => new Date());
  const knownSecrets = options.knownSecrets ?? [];
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  const safeJson = createSecretFreeJsonSchema(knownSecrets);
  const safeText = createSecretFreeTextSchema(knownSecrets);

  async function claim(workerId: string, now: Date) {
    const owner = safeText.min(1).parse(workerId);
    const expiresAt = leaseExpiry(now, leaseDurationMs);
    return options.database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select()
        .from(commandRequests)
        .where(or(
          eq(commandRequests.status, "pending"),
          and(eq(commandRequests.status, "processing"), lte(commandRequests.leaseExpiresAt, now))
        ))
        .orderBy(asc(commandRequests.createdAt), asc(commandRequests.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return undefined;
      const [claimed] = await transaction
        .update(commandRequests)
        .set({
          claimedAt: now,
          claimedBy: owner,
          leaseExpiresAt: expiresAt,
          status: "processing",
          updatedAt: now
        })
        .where(eq(commandRequests.id, candidate.id))
        .returning();
      return claimed!;
    });
  }

  async function finish(input: {
    commandId: string;
    errorSummary?: string;
    now: Date;
    status: "completed" | "failed" | "needs_input";
    structuredResult?: JsonObject;
    workerId: string;
  }) {
    const [updated] = await options.database
      .update(commandRequests)
      .set({
        claimedAt: null,
        claimedBy: null,
        completedAt: input.status === "completed" || input.status === "failed" ? input.now : null,
        errorSummary: input.errorSummary ? safeText.parse(input.errorSummary) : null,
        leaseExpiresAt: null,
        status: input.status,
        structuredResult: input.structuredResult ? safeJson.parse(input.structuredResult) : null,
        updatedAt: input.now
      })
      .where(and(
        eq(commandRequests.id, input.commandId),
        eq(commandRequests.claimedBy, input.workerId),
        gte(commandRequests.leaseExpiresAt, input.now)
      ))
      .returning();
    if (!updated) throw new CommandLeaseError();
  }

  async function processNext(workerId: string): Promise<"completed" | "failed" | "needs_input" | undefined> {
    const startedAt = clock();
    const command = await claim(workerId, startedAt);
    if (!command) return undefined;
    if (!options.transport) {
      await finish({
        commandId: command.id,
        errorSummary: "openai_configuration_unavailable",
        now: clock(),
        status: "failed",
        workerId
      });
      return "failed";
    }

    let output: unknown;
    try {
      output = (await options.transport.invoke({
        context: JSON.stringify({
          command: redactText(command.content, knownSecrets),
          constraints: {
            allowedModelProfiles: ["fast", "balanced", "reasoning"],
            allowedToolPolicies: [
              "browser-interact",
              "browser-read",
              "calendar-read",
              "calendar-write",
              "course-registration",
              "gmail-read",
              "none"
            ],
            timezoneRequired: true,
            trust: "trusted_user_command"
          }
        }),
        modelId: resolveModelId("fast", options.models),
        outputKind: "automation_command",
        role: "intent_router"
      })).output;
    } catch {
      await finish({
        commandId: command.id,
        errorSummary: "command_model_invocation_failed",
        now: clock(),
        status: "failed",
        workerId
      });
      return "failed";
    }

    const decision = automationCommandDecisionSchema.safeParse(output);
    if (!decision.success) {
      await finish({
        commandId: command.id,
        errorSummary: "command_model_output_invalid",
        now: clock(),
        status: "failed",
        workerId
      });
      return "failed";
    }
    if (decision.data.kind === "needs_input") {
      await finish({
        commandId: command.id,
        now: clock(),
        status: "needs_input",
        structuredResult: { prompt: redactText(decision.data.prompt, knownSecrets) },
        workerId
      });
      return "needs_input";
    }
    if (decision.data.kind === "unsupported") {
      await finish({
        commandId: command.id,
        errorSummary: redactText(decision.data.summary, knownSecrets),
        now: clock(),
        status: "failed",
        workerId
      });
      return "failed";
    }

    const automation = decision.data.automation;
    const now = clock();
    let nextRunAt: Date;
    try {
      nextRunAt = nextOccurrence(automation.schedule, automation.timezone, now);
    } catch {
      await finish({
        commandId: command.id,
        errorSummary: "command_automation_schedule_invalid",
        now,
        status: "failed",
        workerId
      });
      return "failed";
    }
    await options.database.transaction(async (transaction) => {
      const [owned] = await transaction
        .select()
        .from(commandRequests)
        .where(and(
          eq(commandRequests.id, command.id),
          eq(commandRequests.claimedBy, workerId),
          gte(commandRequests.leaseExpiresAt, now)
        ))
        .limit(1)
        .for("update");
      if (!owned) throw new CommandLeaseError();
      const [created] = await transaction
        .insert(automations)
        .values({
          completionMode: automation.completionMode,
          enabled: true,
          goal: safeText.parse(automation.goal),
          id: randomUUID(),
          modelProfile: automation.modelProfile,
          name: safeText.parse(automation.name),
          nextRunAt,
          schedule: automation.schedule,
          timezone: automation.timezone,
          toolPolicy: automation.toolPolicy
        })
        .returning({ id: automations.id });
      await transaction
        .update(commandRequests)
        .set({
          claimedAt: null,
          claimedBy: null,
          completedAt: now,
          errorSummary: null,
          intentType: "automation_create",
          leaseExpiresAt: null,
          status: "completed",
          structuredResult: safeJson.parse({ automationId: created!.id }),
          updatedAt: now
        })
        .where(eq(commandRequests.id, command.id));
    });
    return "completed";
  }

  return { claim, processNext };
}
