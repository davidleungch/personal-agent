import { randomUUID } from "node:crypto";
import {
  boundedModelValue,
  compileDurableContext,
  decisionObjectToJsonObject,
  modelDecisionSchema,
  resolveModelId,
  routeModel,
  ModelInvocationError,
  type AgentRole,
  type ModelMap,
  type ModelTransport,
  type ModelUsage
} from "@personal-agent/agents";
import {
  automationRuns,
  automations,
  evidence,
  modelInvocations,
  runEvents,
  toolCalls,
  type Database
} from "@personal-agent/db";
import {
  jsonObjectSchema,
  redactText,
  type JsonObject,
  type ModelProfile
} from "@personal-agent/shared";
import {
  type AnyToolDefinition,
  type GatewayRequest,
  type IntegrationAvailability,
  type ToolResult
} from "@personal-agent/tools";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createRunState, RunLeaseError } from "./run-state.js";

type RuntimeStatus =
  | "queued"
  | "running"
  | "verifying"
  | "retry_wait"
  | "needs_human"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

type RuntimeState = Readonly<{
  automation: Readonly<{ goal: string; toolPolicy: string }>;
  evidence: readonly Readonly<{ createdAt: Date; tool?: string; type: string }>[];
  invocations: readonly Readonly<{
    schemaOutcome: "not_requested" | "valid" | "invalid";
    status: "started" | "succeeded" | "failed";
    summary?: string;
  }>[];
  recentEvents: readonly Readonly<{
    createdAt: Date;
    eventType: string;
    payload: JsonObject;
  }>[];
  run: Readonly<{
    attempt: number;
    checkpoint: JsonObject;
    id: string;
    modelProfile: ModelProfile;
    status: RuntimeStatus;
    workflowPhase: string;
  }>;
}>;

type InvocationCompletion = Readonly<{
  completedAt: Date;
  latencyMs: number;
  schemaOutcome: "not_requested" | "valid" | "invalid";
  status: "succeeded" | "failed";
  summary: string;
  usage: JsonObject;
}>;

export interface AgentRuntimePersistence {
  beginInvocation(input: {
    executionModelId: string;
    modelProfile: ModelProfile;
    role: AgentRole;
    runId: string;
    startedAt: Date;
  }): Promise<string>;
  finishInvocation(id: string, input: InvocationCompletion): Promise<void>;
  load(runId: string): Promise<RuntimeState | undefined>;
  recoverInterruptedInvocations(runId: string, now: Date): Promise<void>;
  renewLease(runId: string, workerId: string, now: Date): Promise<boolean>;
  saveCheckpoint(input: {
    checkpoint: JsonObject;
    now: Date;
    runId: string;
    workerId: string;
    workflowPhase: string;
  }): Promise<void>;
  transition(input: {
    availableAt?: Date;
    checkpoint?: JsonObject;
    errorSummary?: string;
    now: Date;
    resultSummary?: string;
    runId: string;
    toStatus: RuntimeStatus;
    workerId: string;
    workflowPhase?: string;
  }): Promise<void>;
}

export type RuntimeToolGateway = Readonly<{
  execute(request: GatewayRequest): Promise<ToolResult<unknown>>;
  resolveDefinitions(
    toolPolicy: string,
    integrations: IntegrationAvailability
  ): readonly AnyToolDefinition[];
}>;

export type AgentRuntimeLimits = Readonly<{
  contextCharacters: number;
  leaseHeartbeatMs: number;
  malformedBackoffMs: number;
  maxEscalationDepth: number;
  maxModelInvocations: number;
  maxReasoningRetries: number;
  maxTransportRetries: number;
  transportBackoffMs: number;
}>;

export const defaultAgentRuntimeLimits: AgentRuntimeLimits = Object.freeze({
  contextCharacters: 24_000,
  leaseHeartbeatMs: 20_000,
  malformedBackoffMs: 100,
  maxEscalationDepth: 2,
  maxModelInvocations: 12,
  maxReasoningRetries: 1,
  maxTransportRetries: 2,
  transportBackoffMs: 1_000
});

const terminalStatuses = new Set<RuntimeStatus>([
  "needs_human",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "retry_wait"
]);

const policyFailureClasses = new Set([
  "capability_not_granted",
  "integration_unavailable",
  "permission_denied",
  "policy_denied",
  "unknown_tool"
]);

function validateLimits(limits: AgentRuntimeLimits): AgentRuntimeLimits {
  const entries = Object.entries(limits);
  if (entries.some(([, value]) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Agent runtime limits must be non-negative integers");
  }
  if (
    limits.contextCharacters < 2_000 ||
    limits.leaseHeartbeatMs < 1 ||
    limits.maxModelInvocations < 1
  ) {
    throw new Error("Agent runtime context and invocation budgets must be positive");
  }
  if (limits.maxEscalationDepth > 2) {
    throw new Error("Agent runtime escalation depth cannot exceed semantic profile depth");
  }
  return limits;
}

function usageJson(usage: ModelUsage): JsonObject {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens })
  };
}

function roleFor(state: RuntimeState): AgentRole {
  return state.run.status === "verifying" ? "verification" : "general";
}

function riskFor(definitions: readonly AnyToolDefinition[]): "low" | "medium" | "high" {
  return definitions.some((definition) => definition.sideEffect === "consequential")
    ? "high"
    : definitions.some((definition) => definition.sideEffect === "reversible")
      ? "medium"
      : "low";
}

function exposedDefinitions(definitions: readonly AnyToolDefinition[]) {
  return definitions.map((definition) => ({
    inputSchema: jsonObjectSchema.parse(z.toJSONSchema(definition.inputSchema)),
    name: definition.name,
    permission: definition.permission,
    sideEffect: definition.sideEffect
  }));
}

function toolCheckpoint(
  checkpoint: JsonObject,
  tool: string,
  result: ToolResult<unknown>,
  knownSecrets: readonly string[]
): JsonObject {
  return {
    ...checkpoint,
    lastToolObservation: {
      ...(result.data === undefined
        ? {}
        : { data: boundedModelValue(result.data, knownSecrets) }),
      ...(result.externalId ? { externalId: redactText(result.externalId, knownSecrets) } : {}),
      ...(result.failureClass ? { failureClass: result.failureClass } : {}),
      status: result.status,
      tool
    }
  };
}

function completedPostconditions(
  state: RuntimeState,
  definitions: readonly AnyToolDefinition[]
): boolean {
  const pending = state.run.checkpoint.pendingConsequentialOperation;
  if (typeof pending === "object" && pending !== null && !Array.isArray(pending)) {
    if (pending.outcome !== "confirmed" || typeof pending.tool !== "string") return false;
    if (!state.evidence.some((item) => item.tool === pending.tool)) return false;
  }

  if (state.automation.toolPolicy === "none") return true;
  if (definitions.length === 0) return false;

  const allowedTools = new Set(definitions.map((definition) => definition.name));
  return state.evidence.some(
    (item) => item.tool !== undefined && allowedTools.has(item.tool)
  );
}

export function createAgentRuntime(options: {
  clock?: () => Date;
  gateway: RuntimeToolGateway;
  integrations: IntegrationAvailability;
  knownSecrets?: readonly string[];
  limits?: Partial<AgentRuntimeLimits>;
  models: ModelMap;
  persistence: AgentRuntimePersistence;
  transport?: ModelTransport;
}) {
  const clock = options.clock ?? (() => new Date());
  const knownSecrets = options.knownSecrets ?? [];
  const limits = validateLimits({ ...defaultAgentRuntimeLimits, ...options.limits });

  async function withLeaseHeartbeat<T>(
    execution: Promise<T>,
    runId: string,
    workerId: string
  ): Promise<T> {
    const settled = execution.then(
      (value) => ({ kind: "succeeded" as const, value }),
      (error: unknown) => ({ error, kind: "failed" as const })
    );

    while (true) {
      let timer!: NodeJS.Timeout;
      const heartbeat = new Promise<{ kind: "heartbeat" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "heartbeat" }), limits.leaseHeartbeatMs);
      });
      const outcome = await Promise.race([settled, heartbeat]);
      clearTimeout(timer);

      if (outcome.kind === "succeeded") return outcome.value;
      if (outcome.kind === "failed") throw outcome.error;
      if (!await options.persistence.renewLease(runId, workerId, clock())) {
        throw new RunLeaseError("Automation run lease was lost during execution");
      }
    }
  }

  async function terminal(
    state: RuntimeState,
    workerId: string,
    status: "blocked" | "failed",
    summary: string,
    workflowPhase: string
  ): Promise<RuntimeStatus> {
    const now = clock();
    await options.persistence.transition({
      checkpoint: { ...state.run.checkpoint, runtimeResult: { status, summary } },
      errorSummary: summary,
      now,
      runId: state.run.id,
      toStatus: status,
      workerId,
      workflowPhase
    });
    return status;
  }

  async function retryOrStop(input: {
    failureCount: number;
    invocationCount: number;
    maximumFailures: number;
    state: RuntimeState;
    summary: string;
    waitMs: number;
    workerId: string;
  }): Promise<RuntimeStatus> {
    if (
      input.failureCount >= input.maximumFailures ||
      input.invocationCount >= limits.maxModelInvocations
    ) {
      return terminal(input.state, input.workerId, "blocked", "model_limits_exhausted", "blocked_limits");
    }
    const now = clock();
    await options.persistence.transition({
      availableAt: new Date(now.getTime() + input.waitMs),
      errorSummary: input.summary,
      now,
      runId: input.state.run.id,
      toStatus: "retry_wait",
      workerId: input.workerId,
      workflowPhase: "model_retry_wait"
    });
    return "retry_wait";
  }

  async function execute(runId: string, workerId: string): Promise<RuntimeStatus> {
    await options.persistence.recoverInterruptedInvocations(runId, clock());

    while (true) {
      const state = await options.persistence.load(runId);
      if (!state) throw new Error("Automation run not found");
      if (terminalStatuses.has(state.run.status)) return state.run.status;
      if (!options.transport) {
        return terminal(
          state,
          workerId,
          "blocked",
          "openai_configuration_unavailable",
          "blocked_configuration"
        );
      }

      const definitions = options.gateway.resolveDefinitions(
        state.automation.toolPolicy,
        options.integrations
      );
      const invocationCount = state.invocations.length;
      if (invocationCount >= limits.maxModelInvocations) {
        return terminal(state, workerId, "blocked", "model_invocation_budget_exhausted", "blocked_limits");
      }
      const invalidCount = state.invocations.filter(
        (invocation) => invocation.schemaOutcome === "invalid"
      ).length;
      const transientCount = state.invocations.filter(
        (invocation) => invocation.summary === "model_transport_transient"
      ).length;
      const maximumMalformedFailures =
        (limits.maxReasoningRetries + 1) * (limits.maxEscalationDepth + 1);
      if (invalidCount >= maximumMalformedFailures) {
        return terminal(state, workerId, "blocked", "model_reasoning_exhausted", "blocked_limits");
      }

      const role = roleFor(state);
      const escalationDepth = Math.floor(invalidCount / (limits.maxReasoningRetries + 1));
      const profile = routeModel({
        complexity: "low",
        escalationDepth,
        maxEscalationDepth: limits.maxEscalationDepth,
        preferredProfile: state.run.modelProfile,
        risk: riskFor(definitions),
        role
      });
      const modelId = resolveModelId(profile, options.models);
      const context = compileDurableContext(
        {
          allowedTools: exposedDefinitions(definitions),
          checkpoint: state.run.checkpoint,
          evidence: state.evidence.map((item) => ({
            createdAt: item.createdAt.toISOString(),
            ...(item.tool ? { tool: item.tool } : {}),
            type: item.type
          })),
          goal: state.automation.goal,
          limits: {
            invocationsRemaining: limits.maxModelInvocations - invocationCount,
            reasoningRetriesRemaining: Math.max(0, maximumMalformedFailures - invalidCount)
          },
          policyConstraints: [
            "Only allowedTools may be requested.",
            "All tool execution goes through the Tool Gateway.",
            "Unknown consequential outcomes require verification before retry.",
            "The model cannot change permissions, budgets, retries, or its model profile."
          ],
          recentEvents: state.recentEvents.map((event) => ({
            createdAt: event.createdAt.toISOString(),
            eventType: event.eventType,
            payload: event.payload
          })),
          workflowPhase: state.run.workflowPhase
        },
        { knownSecrets, maxCharacters: limits.contextCharacters }
      );
      const startedAt = clock();
      const invocationId = await options.persistence.beginInvocation({
        executionModelId: modelId,
        modelProfile: profile,
        role,
        runId,
        startedAt
      });

      let output: unknown;
      let usage: ModelUsage = {};
      try {
        const response = await withLeaseHeartbeat(
          options.transport.invoke({ context, modelId, role }),
          runId,
          workerId
        );
        output = response.output;
        usage = response.usage;
      } catch (error) {
        if (error instanceof RunLeaseError) throw error;
        const failure = error instanceof ModelInvocationError ? error.failureClass : "permanent";
        const now = clock();
        await options.persistence.finishInvocation(invocationId, {
          completedAt: now,
          latencyMs: Math.max(0, now.getTime() - startedAt.getTime()),
          schemaOutcome: failure === "malformed_output" ? "invalid" : "not_requested",
          status: "failed",
          summary: failure === "transient" ? "model_transport_transient" : failure === "malformed_output" ? "model_output_invalid" : "model_transport_permanent",
          usage: {}
        });
        if (failure === "malformed_output") {
          return retryOrStop({
            failureCount: invalidCount + 1,
            invocationCount: invocationCount + 1,
            maximumFailures: maximumMalformedFailures,
            state,
            summary: "model_output_invalid",
            waitMs: limits.malformedBackoffMs,
            workerId
          });
        }
        if (failure === "transient") {
          return retryOrStop({
            failureCount: transientCount + 1,
            invocationCount: invocationCount + 1,
            maximumFailures: limits.maxTransportRetries + 1,
            state,
            summary: "model_transport_transient",
            waitMs: limits.transportBackoffMs * 2 ** transientCount,
            workerId
          });
        }
        return terminal(state, workerId, "failed", "model_transport_permanent", "failed_model");
      }

      const decision = modelDecisionSchema.safeParse(output);
      const completedAt = clock();
      await options.persistence.finishInvocation(invocationId, {
        completedAt,
        latencyMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        schemaOutcome: decision.success ? "valid" : "invalid",
        status: decision.success ? "succeeded" : "failed",
        summary: decision.success ? `decision_${decision.data.kind}` : "model_output_invalid",
        usage: usageJson(usage)
      });
      if (!decision.success) {
        return retryOrStop({
          failureCount: invalidCount + 1,
          invocationCount: invocationCount + 1,
          maximumFailures: maximumMalformedFailures,
          state,
          summary: "model_output_invalid",
          waitMs: limits.malformedBackoffMs,
          workerId
        });
      }

      if (decision.data.kind === "complete") {
        if (!completedPostconditions(state, definitions)) {
          return terminal(
            state,
            workerId,
            "blocked",
            "completion_postconditions_unmet",
            "blocked_verification"
          );
        }
        await options.persistence.transition({
          checkpoint: {
            ...state.run.checkpoint,
            structuredResult: {
              ...(decision.data.data
                ? { data: boundedModelValue(decisionObjectToJsonObject(decision.data.data), knownSecrets) }
                : {}),
              summary: redactText(decision.data.summary, knownSecrets)
            }
          },
          now: completedAt,
          resultSummary: redactText(decision.data.summary, knownSecrets),
          runId,
          toStatus: "succeeded",
          workerId,
          workflowPhase: "completed"
        });
        return "succeeded";
      }
      if (decision.data.kind === "needs_human") {
        await options.persistence.transition({
          checkpoint: {
            ...state.run.checkpoint,
            humanRequest: {
              question: redactText(decision.data.prompt, knownSecrets),
              reason: redactText(decision.data.reason, knownSecrets)
            }
          },
          now: completedAt,
          resultSummary: "human_input_required",
          runId,
          toStatus: "needs_human",
          workerId,
          workflowPhase: "needs_human"
        });
        return "needs_human";
      }
      if (decision.data.kind === "blocked") {
        return terminal(
          state,
          workerId,
          "blocked",
          `model_blocked_${decision.data.code}`,
          "blocked_model_decision"
        );
      }

      const requestedTool = decision.data.tool;
      const definition = definitions.find((item) => item.name === requestedTool);
      if (!definition) {
        return terminal(state, workerId, "blocked", "unauthorized_tool_requested", "blocked_policy");
      }
      if (!await options.persistence.renewLease(runId, workerId, clock())) {
        throw new RunLeaseError("Automation run lease was lost before tool execution");
      }
      const result = await withLeaseHeartbeat(
        options.gateway.execute({
          input: decisionObjectToJsonObject(decision.data.arguments),
          integrations: options.integrations,
          runId,
          tool: definition.name,
          toolPolicy: state.automation.toolPolicy,
          workerId
        }),
        runId,
        workerId
      );
      const afterTool = await options.persistence.load(runId);
      if (!afterTool) throw new Error("Automation run not found after tool execution");
      await options.persistence.saveCheckpoint({
        checkpoint: toolCheckpoint(
          afterTool.run.checkpoint,
          definition.name,
          result,
          knownSecrets
        ),
        now: clock(),
        runId,
        workerId,
        workflowPhase: result.status === "unknown" ? "verifying_tool_call" : "tool_result_recorded"
      });
      if (result.status === "unknown") {
        const current = (await options.persistence.load(runId))!;
        return terminal(
          current,
          workerId,
          "blocked",
          "unknown_tool_outcome_requires_verification",
          "blocked_verification"
        );
      }
      if (result.status === "failed") {
        const current = (await options.persistence.load(runId))!;
        return terminal(
          current,
          workerId,
          policyFailureClasses.has(result.failureClass ?? "") ? "blocked" : "failed",
          `tool_failed_${result.failureClass ?? "unclassified"}`,
          "tool_failed"
        );
      }
    }
  }

  return { execute };
}

export function createDatabaseAgentRuntimePersistence(
  database: Database,
  knownSecrets: readonly string[] = []
): AgentRuntimePersistence {
  const runState = createRunState(database, knownSecrets);

  return {
    beginInvocation: async (input) => {
      const id = randomUUID();
      await database.insert(modelInvocations).values({
        executionModelId: input.executionModelId,
        id,
        modelProfile: input.modelProfile,
        role: input.role,
        runId: input.runId,
        schemaOutcome: "not_requested",
        startedAt: input.startedAt,
        status: "started",
        usage: {}
      });
      return id;
    },
    finishInvocation: async (id, input) => {
      await database
        .update(modelInvocations)
        .set({
          completedAt: input.completedAt,
          latencyMs: input.latencyMs,
          schemaOutcome: input.schemaOutcome,
          status: input.status,
          summary: redactText(input.summary, knownSecrets),
          usage: input.usage
        })
        .where(eq(modelInvocations.id, id));
    },
    load: async (runId) => {
      const [run] = await database
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.id, runId))
        .limit(1);
      if (!run) return undefined;
      const [automation] = await database
        .select()
        .from(automations)
        .where(eq(automations.id, run.automationId))
        .limit(1);
      const eventRows = await database
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.createdAt))
        .limit(20);
      const evidenceRows = await database
        .select({
          createdAt: evidence.createdAt,
          tool: toolCalls.tool,
          type: evidence.evidenceType
        })
        .from(evidence)
        .leftJoin(
          toolCalls,
          and(eq(evidence.toolCallId, toolCalls.id), eq(evidence.runId, toolCalls.runId))
        )
        .where(eq(evidence.runId, runId))
        .orderBy(desc(evidence.createdAt))
        .limit(20);
      const invocationRows = await database
        .select({
          schemaOutcome: modelInvocations.schemaOutcome,
          status: modelInvocations.status,
          summary: modelInvocations.summary
        })
        .from(modelInvocations)
        .where(eq(modelInvocations.runId, runId))
        .orderBy(asc(modelInvocations.startedAt), asc(modelInvocations.id));
      return {
        automation: { goal: automation!.goal, toolPolicy: automation!.toolPolicy },
        evidence: evidenceRows.reverse().map((item) => ({
          createdAt: item.createdAt,
          ...(item.tool ? { tool: item.tool } : {}),
          type: item.type
        })),
        invocations: invocationRows.map((item) => ({
          schemaOutcome: item.schemaOutcome as "not_requested" | "valid" | "invalid",
          status: item.status as "started" | "succeeded" | "failed",
          ...(item.summary ? { summary: item.summary } : {})
        })),
        recentEvents: eventRows.reverse().map((item) => ({
          createdAt: item.createdAt,
          eventType: item.eventType,
          payload: item.payload
        })),
        run: {
          attempt: run.attempt,
          checkpoint: run.checkpoint,
          id: run.id,
          modelProfile: run.modelProfile as ModelProfile,
          status: run.status as RuntimeStatus,
          workflowPhase: run.workflowPhase
        }
      };
    },
    recoverInterruptedInvocations: async (runId, now) => {
      await database
        .update(modelInvocations)
        .set({
          completedAt: now,
          latencyMs: 0,
          status: "failed",
          summary: "model_execution_interrupted"
        })
        .where(and(eq(modelInvocations.runId, runId), eq(modelInvocations.status, "started")));
    },
    renewLease: async (runId, workerId, now) =>
      Boolean(await runState.renewLease(runId, workerId, now, 60_000)),
    saveCheckpoint: async (input) => {
      await runState.saveCheckpoint(input);
    },
    transition: async (input) => {
      await runState.transitionRun(input);
    }
  };
}
