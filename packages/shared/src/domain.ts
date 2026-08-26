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
