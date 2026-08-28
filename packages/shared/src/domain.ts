import { z } from "zod";

export const modelProfileSchema = z.enum(["fast", "balanced", "reasoning"]);
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const toolPolicySchema = z.enum([
  "none",
  "browser-read",
  "browser-interact",
  "gmail-read",
  "calendar-read",
  "calendar-write",
  "course-registration"
]);
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

export const completionModeSchema = z.enum(["continue", "stop_after_success"]);

export const commandStatusSchema = z.enum([
  "pending",
  "processing",
  "needs_input",
  "completed",
  "failed"
]);

export const intentTypeSchema = z.enum([
  "query",
  "action",
  "automation_create",
  "automation_update",
  "planning_discussion",
  "product_change",
  "development_fix",
  "system_command"
]);

export const automationRunStatusSchema = z.enum([
  "queued",
  "running",
  "verifying",
  "retry_wait",
  "needs_human",
  "succeeded",
  "failed",
  "blocked",
  "cancelled"
]);
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;

const automationRunTransitions: Readonly<
  Record<AutomationRunStatus, readonly AutomationRunStatus[]>
> = {
  blocked: [],
  cancelled: [],
  failed: [],
  needs_human: ["queued"],
  queued: ["running"],
  retry_wait: ["queued"],
  running: [
    "succeeded",
    "verifying",
    "retry_wait",
    "needs_human",
    "failed",
    "blocked",
    "cancelled"
  ],
  succeeded: [],
  verifying: ["succeeded", "retry_wait", "blocked"]
};

export function canTransitionAutomationRun(
  from: AutomationRunStatus,
  to: AutomationRunStatus
): boolean {
  return automationRunTransitions[from].includes(to);
}

export const automationRunTriggerSchema = z.enum(["scheduled", "manual", "command"]);
export const toolStatusSchema = z.enum(["success", "failed", "unknown"]);
export const idempotencyStateSchema = z.enum(["reserved", "confirmed", "unknown"]);
export const sideEffectClassSchema = z.enum(["read_only", "reversible", "consequential"]);

export const developmentRoleSchema = z.literal("implementer");
export type DevelopmentRole = z.infer<typeof developmentRoleSchema>;

export const developmentTaskStatusSchema = z.enum([
  "ready",
  "preparing",
  "implementing",
  "testing",
  "candidate_ready",
  "blocked",
  "failed",
  "cancelled"
]);
export type DevelopmentTaskStatus = z.infer<typeof developmentTaskStatusSchema>;

export const developmentAttemptStatusSchema = z.enum([
  "preparing",
  "implementing",
  "testing",
  "capturing_candidate",
  "succeeded",
  "interrupted",
  "failed",
  "cancelled"
]);
export type DevelopmentAttemptStatus = z.infer<typeof developmentAttemptStatusSchema>;

export const developmentEventStatusSchema = z.enum([
  "started",
  "success",
  "failed",
  "unknown",
  "blocked"
]);
export type DevelopmentEventStatus = z.infer<typeof developmentEventStatusSchema>;

export const developmentAttemptEventKindSchema = z.enum([
  "transition",
  "harness",
  "tool",
  "test",
  "git",
  "budget",
  "teardown"
]);
export type DevelopmentAttemptEventKind = z.infer<typeof developmentAttemptEventKindSchema>;

export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const workspaceRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Path must be normalized and workspace-relative"
  );

export const developmentCheckSchema = z.object({
  arguments: z.array(z.string().max(500)).max(32).default([]),
  executable: z.enum(["node", "pnpm"]),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1_000),
  workingDirectory: workspaceRelativePathSchema.optional()
});

export const developmentAcceptanceCriterionSchema = z.object({
  check: developmentCheckSchema,
  description: z.string().trim().min(1).max(2_000),
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)
});

export const developmentAcceptanceCriteriaSchema = z
  .array(developmentAcceptanceCriterionSchema)
  .min(1)
  .max(32)
  .refine(
    (criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length,
    "Acceptance criterion IDs must be unique"
  );
export type DevelopmentAcceptanceCriteria = z.infer<
  typeof developmentAcceptanceCriteriaSchema
>;

export const developmentBudgetSchema = z.object({
  maxCommandMs: z.number().int().positive().max(30 * 60 * 1_000),
  maxCommandOutputBytes: z.number().int().positive().max(10_000_000),
  maxContextBytes: z.number().int().positive().max(2_000_000),
  maxCostUsdMicros: z.number().int().nonnegative(),
  maxDiffBytes: z.number().int().positive().max(100_000_000),
  maxModelInvocations: z.number().int().positive().max(20),
  maxTokens: z.number().int().positive().max(10_000_000),
  maxToolCalls: z.number().int().positive().max(10_000),
  maxWallClockMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
  maxWorkspaceBytes: z.number().int().positive().max(2_000_000_000)
});
export type DevelopmentBudget = z.infer<typeof developmentBudgetSchema>;

export const developmentUsageSchema = z.object({
  commandMs: z.number().int().nonnegative(),
  commandOutputBytes: z.number().int().nonnegative(),
  costUsdMicros: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  modelInvocations: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative()
});
export type DevelopmentUsage = z.infer<typeof developmentUsageSchema>;

export const emptyDevelopmentUsage = (): DevelopmentUsage => ({
  commandMs: 0,
  commandOutputBytes: 0,
  costUsdMicros: 0,
  inputTokens: 0,
  modelInvocations: 0,
  outputTokens: 0,
  toolCalls: 0
});

export const developmentContextManifestSchema = z.object({
  entries: z
    .array(
      z.object({
        blobId: gitObjectIdSchema,
        bytes: z.number().int().nonnegative(),
        path: workspaceRelativePathSchema,
        source: z.enum(["authority", "repository"])
      })
    )
    .max(256),
  totalBytes: z.number().int().nonnegative()
});
export type DevelopmentContextManifest = z.infer<typeof developmentContextManifestSchema>;

const developmentTaskTransitions: Readonly<
  Record<DevelopmentTaskStatus, readonly DevelopmentTaskStatus[]>
> = {
  blocked: [],
  cancelled: [],
  candidate_ready: [],
  failed: [],
  implementing: ["testing", "blocked", "failed", "cancelled"],
  preparing: ["implementing", "blocked", "failed", "cancelled"],
  ready: ["preparing", "blocked", "cancelled"],
  testing: ["candidate_ready", "blocked", "failed", "cancelled"]
};

const developmentAttemptTransitions: Readonly<
  Record<DevelopmentAttemptStatus, readonly DevelopmentAttemptStatus[]>
> = {
  cancelled: [],
  capturing_candidate: ["succeeded", "failed", "cancelled"],
  failed: [],
  implementing: ["testing", "interrupted", "failed", "cancelled"],
  interrupted: ["preparing", "failed", "cancelled"],
  preparing: ["implementing", "interrupted", "failed", "cancelled"],
  succeeded: [],
  testing: ["capturing_candidate", "interrupted", "failed", "cancelled"]
};

export function canTransitionDevelopmentTask(
  from: DevelopmentTaskStatus,
  to: DevelopmentTaskStatus
): boolean {
  return developmentTaskTransitions[from].includes(to);
}

export function canTransitionDevelopmentAttempt(
  from: DevelopmentAttemptStatus,
  to: DevelopmentAttemptStatus
): boolean {
  return developmentAttemptTransitions[from].includes(to);
}

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);
