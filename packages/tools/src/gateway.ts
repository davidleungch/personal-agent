import { redactJson, redactText, type JsonObject } from "@personal-agent/shared";
import {
  evidenceSchema,
  genericInputSummary,
  safeSummarySchema,
  ToolExecutionError,
  type AnyToolDefinition,
  type FailureClass,
  type PermissionClass,
  type ToolExecutionContext,
  type ToolEvidence,
  type ToolResult
} from "./contract.js";
import {
  resolveCapabilities,
  type IntegrationAvailability
} from "./capabilities.js";
import type { ToolPersistence } from "./persistence.js";
import type { ToolRegistry } from "./registry.js";

export type GatewayRequest = {
  input: unknown;
  integrations: IntegrationAvailability;
  permissionGrants?: readonly PermissionClass[];
  runId: string;
  tool: string;
  toolPolicy: string;
};

type AttemptOutcome = {
  result: ToolResult<unknown>;
  sideEffectStarted: boolean;
};

type ValidatedVerificationResult =
  | { status: "exists"; data: unknown; evidence: ToolEvidence[]; externalId?: string }
  | { status: "absent" }
  | { status: "unknown"; failureClass?: FailureClass };

const failed = (failureClass: FailureClass, retryable = false): ToolResult<never> => ({
  failureClass,
  retryable,
  status: "failed"
});

const unknown = (failureClass: FailureClass): ToolResult<never> => ({
  failureClass,
  retryable: false,
  status: "unknown"
});

function failureFromError(error: unknown): { failureClass: FailureClass; retryable: boolean } {
  if (error instanceof ToolExecutionError) {
    return { failureClass: error.failureClass, retryable: error.retryable };
  }
  return { failureClass: "transport_error", retryable: true };
}

function boundedToolName(name: string, knownSecrets: readonly string[]): string {
  return redactText(name, knownSecrets).slice(0, 200) || "invalid.tool_name";
}

export function createToolGateway(options: {
  clock?: () => Date;
  knownSecrets?: readonly string[];
  persistence: ToolPersistence;
  registry: ToolRegistry;
}) {
  const clock = options.clock ?? (() => new Date());
  const knownSecrets = options.knownSecrets ?? [];
  const summarySchema = safeSummarySchema(knownSecrets);

  function stringifySummary(summary: JsonObject): string {
    const redacted = redactJson(summary, knownSecrets) as JsonObject;
    return JSON.stringify(summarySchema.parse(redacted));
  }

  async function audit(
    request: GatewayRequest,
    definition: AnyToolDefinition | undefined,
    attempt: number,
    requestedAt: Date,
    result: ToolResult<unknown>,
    inputSummary: JsonObject,
    outputSummary: JsonObject,
    idempotencyKey?: string,
    evidenceItems: readonly ToolEvidence[] = []
  ): Promise<void> {
    await options.persistence.audit(
      {
        attempt,
        completedAt: clock(),
        ...(result.externalId ? { externalId: result.externalId } : {}),
        ...(result.failureClass ? { failureClass: result.failureClass } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        inputSummary: stringifySummary(inputSummary),
        outputSummary: stringifySummary(outputSummary),
        requestedAt,
        runId: request.runId,
        sideEffectClass: definition?.sideEffect ?? "read_only",
        status: result.status,
        tool: boundedToolName(request.tool, knownSecrets)
      },
      evidenceItems
    );
  }

  function executionContext(
    runId: string,
    signal: AbortSignal,
    operationKey: string | undefined,
    onSideEffect: () => void
  ): ToolExecutionContext {
    const context: ToolExecutionContext = {
      reportSideEffectStarted: onSideEffect,
      runId,
      signal
    };
    if (operationKey !== undefined) context.operationKey = operationKey;
    return context;
  }

  async function withinTimeout<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<{ timedOut: boolean; value?: T; error?: unknown }> {
    const controller = new AbortController();
    let timer!: NodeJS.Timeout;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ timedOut: true });
      }, timeoutMs);
    });
    const execution = operation(controller.signal).then(
      (value) => ({ timedOut: false as const, value }),
      (error: unknown) => ({ error, timedOut: false as const })
    );
    const outcome = await Promise.race([execution, timeout]);
    clearTimeout(timer);
    return outcome;
  }

  function validateResult(
    definition: AnyToolDefinition,
    result: ToolResult<unknown>
  ): { result: ToolResult<unknown>; evidenceItems: ToolEvidence[]; outputSummary: JsonObject } {
    if (!(["success", "failed", "unknown"] as const).includes(result.status)) {
      return { evidenceItems: [], outputSummary: { outcome: "invalid" }, result: failed("invalid_output") };
    }
    const evidenceItems: ToolEvidence[] = [];
    for (const item of result.evidence ?? []) {
      const parsed = evidenceSchema.safeParse(redactJson(item as never, knownSecrets));
      if (!parsed.success) {
        return { evidenceItems: [], outputSummary: { outcome: "invalid" }, result: failed("invalid_output") };
      }
      evidenceItems.push(parsed.data);
    }
    if (result.data !== undefined) {
      const parsed = definition.outputSchema.safeParse(result.data);
      if (!parsed.success) {
        return { evidenceItems: [], outputSummary: { outcome: "invalid" }, result: failed("invalid_output") };
      }
      return {
        evidenceItems,
        outputSummary: definition.safeOutputSummary(parsed.data),
        result: { ...result, data: parsed.data, evidence: evidenceItems }
      };
    }
    if (result.status === "success") {
      return { evidenceItems: [], outputSummary: { outcome: "invalid" }, result: failed("invalid_output") };
    }
    return {
      evidenceItems,
      outputSummary: { failureClass: result.failureClass ?? "transport_error", status: result.status },
      result: { ...result, evidence: evidenceItems }
    };
  }

  async function executeAttempt(
    definition: AnyToolDefinition,
    input: unknown,
    request: GatewayRequest,
    idempotencyKey: string | undefined
  ): Promise<AttemptOutcome> {
    let sideEffectStarted = false;
    const outcome = await withinTimeout(definition.timeoutMs, (signal) =>
      definition.execute(
        input,
        executionContext(request.runId, signal, idempotencyKey, () => {
          sideEffectStarted = true;
        })
      )
    );
    if (outcome.timedOut) {
      return {
        result:
          definition.sideEffect === "consequential" && sideEffectStarted
            ? unknown("timeout")
            : failed("timeout", true),
        sideEffectStarted
      };
    }
    if (outcome.error !== undefined) {
      const classified = failureFromError(outcome.error);
      return {
        result:
          definition.sideEffect === "consequential" && sideEffectStarted
            ? unknown(classified.failureClass)
            : failed(classified.failureClass, classified.retryable),
        sideEffectStarted
      };
    }
    return { result: outcome.value!, sideEffectStarted };
  }

  async function verify(
    definition: AnyToolDefinition,
    input: unknown,
    request: GatewayRequest,
    idempotencyKey: string
  ): Promise<ValidatedVerificationResult> {
    if (!definition.verify) return { failureClass: "verification_failed", status: "unknown" };
    const outcome = await withinTimeout(definition.timeoutMs, (signal) =>
      definition.verify!(input, executionContext(request.runId, signal, idempotencyKey, () => undefined))
    );
    if (outcome.timedOut || outcome.error !== undefined) {
      return { failureClass: "verification_failed", status: "unknown" };
    }
    const result = outcome.value!;
    if (result.status !== "exists") return result;
    const parsed = definition.outputSchema.safeParse(result.data);
    if (!parsed.success) return { failureClass: "verification_failed", status: "unknown" };
    const evidenceItems: ToolEvidence[] = [];
    for (const item of result.evidence ?? []) {
      const parsedEvidence = evidenceSchema.safeParse(redactJson(item as never, knownSecrets));
      if (!parsedEvidence.success) return { failureClass: "verification_failed", status: "unknown" };
      evidenceItems.push(parsedEvidence.data);
    }
    return { ...result, data: parsed.data, evidence: evidenceItems };
  }

  async function execute(request: GatewayRequest): Promise<ToolResult<unknown>> {
    const requestedAt = clock();
    const definition = options.registry.get(request.tool);
    const genericSummary = genericInputSummary(request.input);
    if (!definition) {
      const result = failed("unknown_tool");
      await audit(request, undefined, 1, requestedAt, result, genericSummary, { status: "rejected" });
      return result;
    }

    const capabilities = resolveCapabilities(request.toolPolicy, request.integrations);
    if (!capabilities.policyConfigured) {
      const result = failed("policy_denied");
      await audit(request, definition, 1, requestedAt, result, genericSummary, { status: "rejected" });
      return result;
    }
    if (
      (definition.integration === "browser" && request.integrations.browser === "unavailable") ||
      (definition.integration === "google" && request.integrations.google === "unavailable")
    ) {
      const result = failed("integration_unavailable");
      await audit(request, definition, 1, requestedAt, result, genericSummary, { status: "rejected" });
      return result;
    }
    if (!capabilities.tools.has(definition.name)) {
      const result = failed("capability_not_granted");
      await audit(request, definition, 1, requestedAt, result, genericSummary, { status: "rejected" });
      return result;
    }
    const permissions = new Set(request.permissionGrants ?? capabilities.permissions);
    if (!permissions.has(definition.permission)) {
      const result = failed("permission_denied");
      await audit(request, definition, 1, requestedAt, result, genericSummary, { status: "rejected" });
      return result;
    }

    const parsed = definition.inputSchema.safeParse(request.input);
    if (!parsed.success) {
      const result = failed("invalid_input");
      await audit(request, definition, 1, requestedAt, result, genericSummary, { status: "rejected" });
      return result;
    }
    const input = parsed.data;
    const inputSummary = definition.safeInputSummary(input);
    const idempotencyKey = definition.idempotencyKey?.(input);

    if (definition.sideEffect === "consequential") {
      const reservation = await options.persistence.reserveIdempotency({
        key: idempotencyKey!,
        now: clock(),
        runId: request.runId,
        scope: definition.name
      });
      if (!reservation.inserted) {
        if (reservation.record.state === "reserved") {
          const result = unknown("duplicate_in_progress");
          await audit(request, definition, 1, requestedAt, result, inputSummary, { status: "duplicate" }, idempotencyKey);
          return result;
        }
        const verification = await verify(definition, input, request, idempotencyKey!);
        if (verification.status === "exists") {
          if (reservation.record.state === "unknown") {
            await options.persistence.transitionIdempotency({
              expected: "unknown",
              key: idempotencyKey!,
              now: clock(),
              scope: definition.name,
              state: "confirmed"
            });
          }
          await options.persistence.markConsequentialOutcome({
            idempotencyKey: idempotencyKey!, now: clock(), outcome: "confirmed", runId: request.runId, tool: definition.name
          });
          const result: ToolResult<unknown> = {
            data: verification.data,
            evidence: verification.evidence,
            ...(verification.externalId ? { externalId: verification.externalId } : {}),
            retryable: false,
            status: "success"
          };
          await audit(
            request,
            definition,
            1,
            requestedAt,
            result,
            inputSummary,
            definition.safeOutputSummary(verification.data),
            idempotencyKey,
            verification.evidence
          );
          return result;
        }
        if (verification.status === "unknown" || reservation.record.state === "confirmed") {
          const result = unknown(
            verification.status === "unknown"
              ? (verification.failureClass ?? "verification_failed")
              : "verification_failed"
          );
          await audit(request, definition, 1, requestedAt, result, inputSummary, { status: "verification_unknown" }, idempotencyKey);
          await options.persistence.markConsequentialOutcome({
            idempotencyKey: idempotencyKey!, now: clock(), outcome: "unknown", runId: request.runId, tool: definition.name
          });
          return result;
        }
        const claimed = await options.persistence.transitionIdempotency({
          expected: "unknown",
          key: idempotencyKey!,
          now: clock(),
          scope: definition.name,
          state: "reserved"
        });
        if (!claimed) {
          const result = unknown("duplicate_in_progress");
          await audit(request, definition, 1, requestedAt, result, inputSummary, { status: "duplicate" }, idempotencyKey);
          return result;
        }
      }
      await options.persistence.markConsequentialPending({
        idempotencyKey: idempotencyKey!, now: clock(), runId: request.runId, tool: definition.name
      });
    }

    for (let attempt = 1; attempt <= definition.retryPolicy.maxAttempts; attempt += 1) {
      const attemptStartedAt = clock();
      const attempted = await executeAttempt(definition, input, request, idempotencyKey);
      const validated = validateResult(definition, attempted.result);
      await audit(
        request,
        definition,
        attempt,
        attemptStartedAt,
        validated.result,
        inputSummary,
        validated.outputSummary,
        idempotencyKey,
        validated.evidenceItems
      );

      if (validated.result.status === "success") {
        if (definition.sideEffect === "consequential") {
          await options.persistence.transitionIdempotency({
            expected: "reserved", key: idempotencyKey!, now: clock(), scope: definition.name, state: "confirmed"
          });
          await options.persistence.markConsequentialOutcome({
            idempotencyKey: idempotencyKey!, now: clock(), outcome: "confirmed", runId: request.runId, tool: definition.name
          });
        }
        return validated.result;
      }

      if (validated.result.status === "unknown" && definition.sideEffect === "consequential") {
        await options.persistence.transitionIdempotency({
          expected: "reserved", key: idempotencyKey!, now: clock(), scope: definition.name, state: "unknown"
        });
        const verification = await verify(definition, input, request, idempotencyKey!);
        if (verification.status === "exists") {
          await options.persistence.transitionIdempotency({
            expected: "unknown", key: idempotencyKey!, now: clock(), scope: definition.name, state: "confirmed"
          });
          await options.persistence.markConsequentialOutcome({
            idempotencyKey: idempotencyKey!, now: clock(), outcome: "confirmed", runId: request.runId, tool: definition.name
          });
          const result: ToolResult<unknown> = {
            data: verification.data,
            evidence: verification.evidence,
            ...(verification.externalId ? { externalId: verification.externalId } : {}),
            retryable: false,
            status: "success"
          };
          await audit(
            request,
            definition,
            attempt,
            attemptStartedAt,
            result,
            inputSummary,
            definition.safeOutputSummary(verification.data),
            idempotencyKey,
            verification.evidence
          );
          return result;
        }
        const mayRetry =
          verification.status === "absent" &&
          attempt < definition.retryPolicy.maxAttempts &&
          definition.retryPolicy.retryableFailureClasses.includes(
            validated.result.failureClass ?? "verification_failed"
          );
        if (mayRetry) {
          const claimed = await options.persistence.transitionIdempotency({
            expected: "unknown", key: idempotencyKey!, now: clock(), scope: definition.name, state: "reserved"
          });
          if (!claimed) {
            await options.persistence.markConsequentialOutcome({
              idempotencyKey: idempotencyKey!, now: clock(), outcome: "unknown", runId: request.runId, tool: definition.name
            });
            return validated.result;
          }
          await options.persistence.markConsequentialOutcome({
            idempotencyKey: idempotencyKey!, now: clock(), outcome: "absent", runId: request.runId, tool: definition.name
          });
          await options.persistence.markConsequentialPending({
            idempotencyKey: idempotencyKey!, now: clock(), runId: request.runId, tool: definition.name
          });
          continue;
        }
        await options.persistence.markConsequentialOutcome({
          idempotencyKey: idempotencyKey!, now: clock(), outcome: "unknown", runId: request.runId, tool: definition.name
        });
        return validated.result;
      }

      const mayRetry =
        validated.result.status === "failed" &&
        validated.result.retryable &&
        attempt < definition.retryPolicy.maxAttempts &&
        definition.retryPolicy.retryableFailureClasses.includes(
          validated.result.failureClass ?? "transport_error"
        );
      if (!mayRetry) {
        if (definition.sideEffect === "consequential") {
          await options.persistence.markConsequentialOutcome({
            idempotencyKey: idempotencyKey!, now: clock(), outcome: "failed", runId: request.runId, tool: definition.name
          });
        }
        return validated.result;
      }
    }
    throw new Error("Tool retry loop exhausted unexpectedly");
  }

  return {
    execute,
    resolveDefinitions: (toolPolicy: string, integrations: IntegrationAvailability) => {
      const capabilities = resolveCapabilities(toolPolicy, integrations);
      return options.registry.resolve(capabilities.tools);
    }
  };
}
