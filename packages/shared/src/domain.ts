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

export const developmentRoleSchema = z.enum(["implementer", "reviewer"]);
export type DevelopmentRole = z.infer<typeof developmentRoleSchema>;

export const developmentTaskStatusSchema = z.enum([
  "ready",
  "preparing",
  "implementing",
  "testing",
  "candidate_ready",
  "fix_required",
  "approved_candidate",
  "needs_human",
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

export const developmentReviewStatusSchema = z.enum([
  "preparing",
  "reviewing",
  "finalizing",
  "interrupted",
  "succeeded",
  "failed"
]);
export type DevelopmentReviewStatus = z.infer<typeof developmentReviewStatusSchema>;

export const developmentReviewCleanupStatusSchema = z.enum(["pending", "failed", "succeeded"]);
export type DevelopmentReviewCleanupStatus = z.infer<
  typeof developmentReviewCleanupStatusSchema
>;

export const developmentReviewEventKindSchema = z.enum([
  "transition",
  "harness",
  "tool",
  "check",
  "integrity",
  "cleanup",
  "finalization"
]);
export type DevelopmentReviewEventKind = z.infer<typeof developmentReviewEventKindSchema>;

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

export const developmentScopedPathSchema = z.union([
  z.literal("."),
  workspaceRelativePathSchema
]);

export const developmentImplementerContextPolicySchema = z
  .object({
    allowedPaths: z.array(developmentScopedPathSchema).min(1).max(64),
    forbiddenPaths: z.array(developmentScopedPathSchema).max(64),
    relevantPaths: z.array(workspaceRelativePathSchema).max(64)
  })
  .strict();
export type DevelopmentImplementerContextPolicy = z.infer<
  typeof developmentImplementerContextPolicySchema
>;

export const developmentReviewerContextPolicySchema = z
  .object({
    forbiddenPaths: z.array(developmentScopedPathSchema).max(64),
    readablePaths: z.array(developmentScopedPathSchema).min(1).max(64),
    relevantPaths: z.array(workspaceRelativePathSchema).max(64)
  })
  .strict();
export type DevelopmentReviewerContextPolicy = z.infer<
  typeof developmentReviewerContextPolicySchema
>;

export const developmentCheckSchema = z.object({
  arguments: z.array(z.string().max(500)).max(32).default([]),
  executable: z.enum(["node", "pnpm"]),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1_000),
  workingDirectory: workspaceRelativePathSchema.optional()
});

export const developmentAcceptanceCriterionIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);

export const developmentAcceptanceCriterionSchema = z.object({
  check: developmentCheckSchema,
  description: z.string().trim().min(1).max(2_000),
  id: developmentAcceptanceCriterionIdSchema
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

export const developmentArchitectureReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(
    /^[^#]+#[a-z0-9][a-z0-9-]{0,199}$/,
    "Architecture reference must identify an authority heading"
  )
  .refine((reference) => {
    const separator = reference.indexOf("#");
    const path = reference.slice(0, separator);
    const parsed = workspaceRelativePathSchema.safeParse(path);
    return parsed.success && parsed.data === path;
  }, "Architecture reference must use a normalized workspace-relative authority path");

export const developmentReviewFindingSchema = z
  .object({
    acceptanceCriterionId: developmentAcceptanceCriterionIdSchema,
    architectureReference: developmentArchitectureReferenceSchema,
    category: z.enum([
      "acceptance",
      "architecture",
      "correctness",
      "maintainability",
      "scope",
      "security",
      "testing"
    ]),
    finding: z.string().trim().min(1).max(4_000),
    relevantPath: workspaceRelativePathSchema.optional(),
    requiredCorrection: z.string().trim().min(1).max(4_000),
    severity: z.enum(["critical", "high", "medium", "low"])
  })
  .strict();
export type DevelopmentReviewFinding = z.infer<typeof developmentReviewFindingSchema>;

export const developmentNeedsHumanReasonSchema = z.enum([
  "acceptance_ambiguity",
  "authority_change_required",
  "scope_expansion_required",
  "architecture_conflict",
  "security_boundary_change",
  "consequential_approval_required",
  "authority_invalidated",
  "candidate_binding_invalid",
  "context_unavailable",
  "policy_missing",
  "execution_budget_exhausted",
  "fix_iteration_exhausted",
  "infrastructure_retry_exhausted",
  "deterministic_test_failure",
  "reviewer_failure",
  "non_convergence",
  "durable_integrity_failure",
  "minor_only_rejection"
]);
export type DevelopmentNeedsHumanReason = z.infer<
  typeof developmentNeedsHumanReasonSchema
>;

export const developmentReviewResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("APPROVE"),
      findings: z.array(developmentReviewFindingSchema).length(0)
    })
    .strict(),
  z
    .object({
      decision: z.literal("REQUEST_CHANGES"),
      findings: z.array(developmentReviewFindingSchema).min(1).max(64)
    })
    .strict()
]);
export type DevelopmentReviewResult = z.infer<typeof developmentReviewResultSchema>;

export const developmentBudgetSchema = z
  .object({
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
  })
  .strict();
export type DevelopmentBudget = z.infer<typeof developmentBudgetSchema>;

export const developmentUsageSchema = z
  .object({
    commandMs: z.number().int().nonnegative(),
    commandOutputBytes: z.number().int().nonnegative(),
    costUsdMicros: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    modelInvocations: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative()
  })
  .strict();
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

export const developmentContextManifestSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            blobId: gitObjectIdSchema,
            bytes: z.number().int().nonnegative(),
            path: workspaceRelativePathSchema,
            source: z.enum(["authority", "repository"])
          })
          .strict()
      )
      .max(256),
    totalBytes: z.number().int().nonnegative()
  })
  .strict();
export type DevelopmentContextManifest = z.infer<typeof developmentContextManifestSchema>;

export const developmentReviewerContextManifestSchema = developmentContextManifestSchema.extend({
  authorityReferences: z
    .array(developmentArchitectureReferenceSchema)
    .min(1)
    .max(512)
    .refine(
      (references) => new Set(references).size === references.length,
      "Reviewer authority references must be unique"
    )
});
export type DevelopmentReviewerContextManifest = z.infer<
  typeof developmentReviewerContextManifestSchema
>;

const developmentTaskTransitions: Readonly<
  Record<DevelopmentTaskStatus, readonly DevelopmentTaskStatus[]>
> = {
  approved_candidate: [],
  blocked: [],
  cancelled: [],
  candidate_ready: ["approved_candidate", "fix_required", "needs_human", "blocked"],
  failed: [],
  fix_required: ["preparing", "needs_human", "blocked", "cancelled"],
  implementing: ["testing", "preparing", "needs_human", "blocked", "failed", "cancelled"],
  needs_human: [],
  preparing: ["implementing", "needs_human", "blocked", "failed", "cancelled"],
  ready: ["preparing", "blocked", "cancelled"],
  testing: ["candidate_ready", "preparing", "needs_human", "blocked", "failed", "cancelled"]
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
