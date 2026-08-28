import type {
  DevelopmentAcceptanceCriteria,
  DevelopmentBudget,
  DevelopmentContextManifest,
  DevelopmentUsage,
  JsonObject
} from "@personal-agent/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

const timestampColumn = (name: string) => timestamp(name, { mode: "date", withTimezone: true });

export const commandRequests = pgTable(
  "command_requests",
  {
    id: uuid().primaryKey(),
    content: text().notNull(),
    status: text().notNull(),
    intentType: text("intent_type"),
    structuredResult: jsonb("structured_result").$type<JsonObject>(),
    errorSummary: text("error_summary"),
    claimedBy: text("claimed_by"),
    claimedAt: timestampColumn("claimed_at"),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    updatedAt: timestampColumn("updated_at").defaultNow().notNull(),
    completedAt: timestampColumn("completed_at")
  },
  (table) => [
    check(
      "command_requests_status_check",
      sql`${table.status} in ('pending', 'processing', 'needs_input', 'completed', 'failed')`
    ),
    check(
      "command_requests_intent_type_check",
      sql`${table.intentType} is null or ${table.intentType} in ('query', 'action', 'automation_create', 'automation_update', 'planning_discussion', 'product_change', 'development_fix', 'system_command')`
    ),
    check(
      "command_requests_structured_result_object_check",
      sql`${table.structuredResult} is null or jsonb_typeof(${table.structuredResult}) = 'object'`
    ),
    check(
      "command_requests_claim_fields_check",
      sql`(${table.claimedBy} is null and ${table.claimedAt} is null and ${table.leaseExpiresAt} is null) or (${table.claimedBy} is not null and ${table.claimedAt} is not null and ${table.leaseExpiresAt} is not null)`
    ),
    index("command_requests_claim_idx").on(table.status, table.createdAt)
  ]
);

export const automations = pgTable(
  "automations",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    goal: text().notNull(),
    schedule: text().notNull(),
    timezone: text().default("Asia/Hong_Kong").notNull(),
    enabled: boolean().default(true).notNull(),
    modelProfile: text("model_profile").notNull(),
    toolPolicy: text("tool_policy").notNull(),
    completionMode: text("completion_mode").notNull(),
    nextRunAt: timestampColumn("next_run_at").notNull(),
    lastRunAt: timestampColumn("last_run_at"),
    version: integer().default(1).notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    updatedAt: timestampColumn("updated_at").defaultNow().notNull()
  },
  (table) => [
    check(
      "automations_model_profile_check",
      sql`${table.modelProfile} in ('fast', 'balanced', 'reasoning')`
    ),
    check(
      "automations_schedule_check",
      sql`${table.schedule} ~ '^[^[:space:]]+([[:space:]]+[^[:space:]]+){4}$'`
    ),
    check(
      "automations_completion_mode_check",
      sql`${table.completionMode} in ('continue', 'stop_after_success')`
    ),
    check("automations_version_check", sql`${table.version} > 0`),
    index("automations_due_idx").on(table.enabled, table.nextRunAt)
  ]
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "restrict", onUpdate: "restrict" }),
    trigger: text().notNull(),
    scheduledFor: timestampColumn("scheduled_for"),
    status: text().notNull(),
    workflowPhase: text("workflow_phase").notNull(),
    checkpoint: jsonb().$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    attempt: integer().default(0).notNull(),
    availableAt: timestampColumn("available_at").notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: timestampColumn("claimed_at"),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    modelProfile: text("model_profile").notNull(),
    resultSummary: text("result_summary"),
    errorSummary: text("error_summary"),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    updatedAt: timestampColumn("updated_at").defaultNow().notNull(),
    startedAt: timestampColumn("started_at"),
    completedAt: timestampColumn("completed_at")
  },
  (table) => [
    check(
      "automation_runs_trigger_check",
      sql`${table.trigger} in ('scheduled', 'manual', 'command')`
    ),
    check(
      "automation_runs_scheduled_for_check",
      sql`(${table.trigger} = 'scheduled' and ${table.scheduledFor} is not null) or (${table.trigger} <> 'scheduled' and ${table.scheduledFor} is null)`
    ),
    check(
      "automation_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled')`
    ),
    check(
      "automation_runs_checkpoint_object_check",
      sql`jsonb_typeof(${table.checkpoint}) = 'object'`
    ),
    check("automation_runs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "automation_runs_model_profile_check",
      sql`${table.modelProfile} in ('fast', 'balanced', 'reasoning')`
    ),
    check(
      "automation_runs_claim_fields_check",
      sql`(${table.claimedBy} is null and ${table.claimedAt} is null and ${table.leaseExpiresAt} is null) or (${table.claimedBy} is not null and ${table.claimedAt} is not null and ${table.leaseExpiresAt} is not null)`
    ),
    uniqueIndex("automation_runs_automation_scheduled_for_uidx").on(
      table.automationId,
      table.scheduledFor
    ),
    uniqueIndex("automation_runs_one_active_uidx")
      .on(table.automationId)
      .where(
        sql`${table.status} in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human')`
      ),
    index("automation_runs_claim_idx").on(table.status, table.availableAt),
    index("automation_runs_lease_expiry_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.leaseExpiresAt} is not null`),
    unique("automation_runs_id_automation_id_unique").on(table.id, table.automationId)
  ]
);

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "restrict", onUpdate: "restrict" }),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    payload: jsonb().$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull()
  },
  (table) => [
    check("run_events_payload_object_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check(
      "run_events_from_status_check",
      sql`${table.fromStatus} is null or ${table.fromStatus} in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled')`
    ),
    check(
      "run_events_to_status_check",
      sql`${table.toStatus} is null or ${table.toStatus} in ('queued', 'running', 'verifying', 'retry_wait', 'needs_human', 'succeeded', 'failed', 'blocked', 'cancelled')`
    )
  ]
);

export const modelInvocations = pgTable(
  "model_invocations",
  {
    id: uuid().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "restrict", onUpdate: "restrict" }),
    role: text().notNull(),
    modelProfile: text("model_profile").notNull(),
    executionModelId: text("execution_model_id").notNull(),
    status: text().notNull(),
    latencyMs: integer("latency_ms"),
    usage: jsonb().$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    schemaOutcome: text("schema_outcome").notNull(),
    summary: text(),
    startedAt: timestampColumn("started_at").defaultNow().notNull(),
    completedAt: timestampColumn("completed_at")
  },
  (table) => [
    check(
      "model_invocations_role_check",
      sql`${table.role} in ('intent_router', 'extractor', 'general', 'planner', 'verification')`
    ),
    check(
      "model_invocations_model_profile_check",
      sql`${table.modelProfile} in ('fast', 'balanced', 'reasoning')`
    ),
    check(
      "model_invocations_status_check",
      sql`${table.status} in ('started', 'succeeded', 'failed')`
    ),
    check(
      "model_invocations_latency_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`
    ),
    check("model_invocations_usage_object_check", sql`jsonb_typeof(${table.usage}) = 'object'`),
    check(
      "model_invocations_schema_outcome_check",
      sql`${table.schemaOutcome} in ('not_requested', 'valid', 'invalid')`
    )
  ]
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "restrict", onUpdate: "restrict" }),
    tool: text().notNull(),
    attempt: integer().notNull(),
    status: text().notNull(),
    sideEffectClass: text("side_effect_class").notNull(),
    idempotencyKey: text("idempotency_key"),
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    externalId: text("external_id"),
    failureClass: text("failure_class"),
    requestedAt: timestampColumn("requested_at").defaultNow().notNull(),
    completedAt: timestampColumn("completed_at")
  },
  (table) => [
    check("tool_calls_attempt_check", sql`${table.attempt} > 0`),
    check("tool_calls_status_check", sql`${table.status} in ('success', 'failed', 'unknown')`),
    check(
      "tool_calls_side_effect_class_check",
      sql`${table.sideEffectClass} in ('read_only', 'reversible', 'consequential')`
    ),
    unique("tool_calls_id_run_id_unique").on(table.id, table.runId)
  ]
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "restrict", onUpdate: "restrict" }),
    scope: text().notNull(),
    key: text().notNull(),
    state: text().notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    updatedAt: timestampColumn("updated_at").defaultNow().notNull()
  },
  (table) => [
    check(
      "idempotency_records_state_check",
      sql`${table.state} in ('reserved', 'confirmed', 'unknown')`
    ),
    unique("idempotency_records_scope_key_unique").on(table.scope, table.key)
  ]
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid().primaryKey(),
    runId: uuid("run_id").notNull(),
    toolCallId: uuid("tool_call_id"),
    evidenceType: text("evidence_type").notNull(),
    payload: jsonb().$type<JsonObject>().notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull()
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [automationRuns.id],
      name: "evidence_run_id_automation_runs_id_fk"
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.toolCallId, table.runId],
      foreignColumns: [toolCalls.id, toolCalls.runId],
      name: "evidence_tool_call_run_fk"
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("evidence_payload_object_check", sql`jsonb_typeof(${table.payload}) = 'object'`)
  ]
);

export const developmentTasks = pgTable(
  "development_tasks",
  {
    id: uuid().primaryKey(),
    title: text().notNull(),
    approvedSpec: text("approved_spec").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<DevelopmentAcceptanceCriteria>().notNull(),
    status: text().notNull(),
    baseCommit: text("base_commit").notNull(),
    maxAttempts: integer("max_attempts").default(1).notNull(),
    approvedAt: timestampColumn("approved_at").notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    updatedAt: timestampColumn("updated_at").defaultNow().notNull()
  },
  (table) => [
    check(
      "development_tasks_status_check",
      sql`${table.status} in ('ready', 'preparing', 'implementing', 'testing', 'candidate_ready', 'blocked', 'failed', 'cancelled')`
    ),
    check(
      "development_tasks_base_commit_check",
      sql`${table.baseCommit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`
    ),
    check("development_tasks_max_attempts_check", sql`${table.maxAttempts} = 1`),
    check(
      "development_tasks_acceptance_criteria_array_check",
      sql`jsonb_typeof(${table.acceptanceCriteria}) = 'array' and jsonb_array_length(${table.acceptanceCriteria}) > 0`
    ),
    index("development_tasks_claim_idx").on(table.status, table.createdAt)
  ]
);

export const developmentAttempts = pgTable(
  "development_attempts",
  {
    id: uuid().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => developmentTasks.id, { onDelete: "restrict", onUpdate: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    role: text().notNull(),
    status: text().notNull(),
    harnessAdapter: text("harness_adapter").notNull(),
    modelProfile: text("model_profile").notNull(),
    baseCommit: text("base_commit").notNull(),
    candidateCommit: text("candidate_commit"),
    candidateRef: text("candidate_ref"),
    sandboxId: text("sandbox_id").notNull(),
    contextManifest: jsonb("context_manifest").$type<DevelopmentContextManifest>(),
    contextDigest: text("context_digest"),
    budget: jsonb().$type<DevelopmentBudget>().notNull(),
    usage: jsonb().$type<DevelopmentUsage>().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    leaseGeneration: integer("lease_generation").default(1).notNull(),
    failureClass: text("failure_class"),
    safeSummary: text("safe_summary"),
    startedAt: timestampColumn("started_at").notNull(),
    completedAt: timestampColumn("completed_at"),
    createdAt: timestampColumn("created_at").defaultNow().notNull(),
    updatedAt: timestampColumn("updated_at").defaultNow().notNull()
  },
  (table) => [
    unique("development_attempts_task_number_unique").on(table.taskId, table.attemptNumber),
    check("development_attempts_number_check", sql`${table.attemptNumber} = 1`),
    check("development_attempts_role_check", sql`${table.role} = 'implementer'`),
    check(
      "development_attempts_status_check",
      sql`${table.status} in ('preparing', 'implementing', 'testing', 'capturing_candidate', 'succeeded', 'interrupted', 'failed', 'cancelled')`
    ),
    check("development_attempts_harness_check", sql`${table.harnessAdapter} = 'pi'`),
    check(
      "development_attempts_model_profile_check",
      sql`${table.modelProfile} in ('fast', 'balanced', 'reasoning')`
    ),
    check(
      "development_attempts_base_commit_check",
      sql`${table.baseCommit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`
    ),
    check(
      "development_attempts_candidate_commit_check",
      sql`${table.candidateCommit} is null or ${table.candidateCommit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`
    ),
    check(
      "development_attempts_candidate_pair_check",
      sql`(${table.candidateCommit} is null and ${table.candidateRef} is null) or (${table.candidateCommit} is not null and ${table.candidateRef} is not null)`
    ),
    check(
      "development_attempts_succeeded_candidate_check",
      sql`(${table.status} = 'succeeded') = (${table.candidateCommit} is not null)`
    ),
    check(
      "development_attempts_context_pair_check",
      sql`(${table.contextManifest} is null and ${table.contextDigest} is null) or (${table.contextManifest} is not null and ${table.contextDigest} is not null)`
    ),
    check(
      "development_attempts_context_manifest_object_check",
      sql`${table.contextManifest} is null or jsonb_typeof(${table.contextManifest}) = 'object'`
    ),
    check(
      "development_attempts_context_digest_check",
      sql`${table.contextDigest} is null or ${table.contextDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check("development_attempts_budget_object_check", sql`jsonb_typeof(${table.budget}) = 'object'`),
    check("development_attempts_usage_object_check", sql`jsonb_typeof(${table.usage}) = 'object'`),
    check(
      "development_attempts_lease_fields_check",
      sql`(${table.leaseOwner} is null and ${table.leaseExpiresAt} is null) or (${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)`
    ),
    check("development_attempts_lease_generation_check", sql`${table.leaseGeneration} > 0`),
    check(
      "development_attempts_completion_check",
      sql`(${table.status} in ('succeeded', 'failed', 'cancelled') and ${table.completedAt} is not null) or (${table.status} not in ('succeeded', 'failed', 'cancelled') and ${table.completedAt} is null)`
    ),
    index("development_attempts_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.leaseExpiresAt} is not null`)
  ]
);

export const developmentAttemptEvents = pgTable(
  "development_attempt_events",
  {
    id: uuid().primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => developmentAttempts.id, { onDelete: "restrict", onUpdate: "restrict" }),
    sequence: integer().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    safeMetadata: jsonb("safe_metadata").$type<JsonObject>().notNull(),
    createdAt: timestampColumn("created_at").defaultNow().notNull()
  },
  (table) => [
    unique("development_attempt_events_attempt_sequence_unique").on(table.attemptId, table.sequence),
    check("development_attempt_events_sequence_check", sql`${table.sequence} > 0`),
    check(
      "development_attempt_events_kind_check",
      sql`${table.kind} in ('transition', 'harness', 'tool', 'test', 'git', 'budget', 'teardown')`
    ),
    check(
      "development_attempt_events_status_check",
      sql`${table.status} in ('started', 'success', 'failed', 'unknown', 'blocked')`
    ),
    check(
      "development_attempt_events_metadata_object_check",
      sql`jsonb_typeof(${table.safeMetadata}) = 'object'`
    )
  ]
);
