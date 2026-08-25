import type { JsonObject } from "@personal-agent/shared";
import { createSecretFreeJsonSchema, isDurableJson, jsonObjectSchema } from "@personal-agent/shared";
import { z, type ZodType } from "zod";

export const permissionClassSchema = z.enum([
  "external_read",
  "browser_interact",
  "external_write"
]);
export type PermissionClass = z.infer<typeof permissionClassSchema>;

export const failureClassSchema = z.enum([
  "unknown_tool",
  "capability_not_granted",
  "permission_denied",
  "invalid_input",
  "invalid_output",
  "integration_unavailable",
  "timeout",
  "rate_limited",
  "transport_error",
  "policy_denied",
  "duplicate_in_progress",
  "verification_failed"
]);
export type FailureClass = z.infer<typeof failureClassSchema>;

export const evidenceSchema = z.object({
  payload: createSecretFreeJsonSchema()
    .refine((value) => JSON.stringify(value).length <= 8_192, "Evidence is too large")
    .refine(isDurableJson, "Evidence must not contain external content or provider policy"),
  type: z.string().trim().min(1).max(100)
});
export type ToolEvidence = z.infer<typeof evidenceSchema>;

export const untrustedTextSchema = z.object({
  text: z.string().max(10_000),
  trust: z.literal("untrusted_external"),
  truncated: z.boolean()
});
export type UntrustedText = z.infer<typeof untrustedTextSchema>;

export type ToolStatus = "success" | "failed" | "unknown";

export type ToolResult<T> = {
  status: ToolStatus;
  data?: T;
  evidence?: ToolEvidence[];
  externalId?: string;
  retryable: boolean;
  failureClass?: FailureClass;
};

export type RetryPolicy = Readonly<{
  maxAttempts: number;
  retryableFailureClasses: readonly FailureClass[];
}>;

export type VerificationResult<T> =
  | { status: "exists"; data: T; evidence?: ToolEvidence[]; externalId?: string }
  | { status: "absent" }
  | { status: "unknown"; failureClass?: FailureClass };

export type ToolExecutionContext = {
  operationKey?: string;
  reportSideEffectStarted: () => void;
  runId: string;
  signal: AbortSignal;
};

export interface ToolDefinition<Input, Output> {
  readonly execute: (
    input: Input,
    context: ToolExecutionContext
  ) => Promise<ToolResult<Output>>;
  readonly idempotencyKey?: (input: Input) => string;
  readonly inputSchema: ZodType<Input>;
  readonly integration: "browser" | "google" | "none";
  readonly name: string;
  readonly outputSchema: ZodType<Output>;
  readonly permission: PermissionClass;
  readonly retryPolicy: RetryPolicy;
  readonly safeInputSummary: (input: Input) => JsonObject;
  readonly safeOutputSummary: (output: Output) => JsonObject;
  readonly sideEffect: "read_only" | "reversible" | "consequential";
  readonly timeoutMs: number;
  readonly verify?: (
    input: Input,
    context: ToolExecutionContext
  ) => Promise<VerificationResult<Output>>;
}

export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>
): ToolDefinition<Input, Output> {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(definition.name)) {
    throw new Error(`Invalid stable tool name: ${definition.name}`);
  }
  if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0) {
    throw new Error(`Tool ${definition.name} requires a positive integer timeout`);
  }
  if (!Number.isInteger(definition.retryPolicy.maxAttempts) || definition.retryPolicy.maxAttempts <= 0) {
    throw new Error(`Tool ${definition.name} requires at least one attempt`);
  }
  if (definition.sideEffect === "consequential" && !definition.idempotencyKey) {
    throw new Error(`Consequential tool ${definition.name} requires an idempotency key`);
  }
  return Object.freeze(definition);
}

export function asUntrustedText(value: string, maximum = 10_000): UntrustedText {
  const text = value.slice(0, maximum);
  return { text, trust: "untrusted_external", truncated: text.length < value.length };
}

export function safeSummarySchema(knownSecrets: readonly string[] = []) {
  return createSecretFreeJsonSchema(knownSecrets)
    .refine((value) => JSON.stringify(value).length <= 4_096, "Tool summary is too large")
    .refine(isDurableJson, "Tool summary must not contain external content or provider policy");
}

export function genericInputSummary(input: unknown): JsonObject {
  const parsed = jsonObjectSchema.safeParse(input);
  if (!parsed.success) {
    return { inputType: Array.isArray(input) ? "array" : typeof input };
  }
  return { fields: Object.keys(parsed.data).sort().slice(0, 20) };
}

export class ToolExecutionError extends Error {
  readonly failureClass: FailureClass;
  readonly retryable: boolean;

  constructor(failureClass: FailureClass, retryable: boolean) {
    super(failureClass);
    this.name = "ToolExecutionError";
    this.failureClass = failureClass;
    this.retryable = retryable;
  }
}
