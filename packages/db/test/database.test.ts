import { randomUUID } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRepositories,
  migrateDatabase,
  automationRuns,
  developmentAttemptEvents,
  developmentAttempts,
  developmentReviewEvents,
  developmentReviews,
  developmentTasks,
  idempotencyRecords,
  modelInvocations,
  runEvents,
  toolCalls,
  type Database
} from "../src/index";
import { migrateFromEnvironment } from "../src/migrate-cli";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
}

const databaseName = new URL(databaseUrl).pathname.slice(1);

if (!databaseName.endsWith("_test")) {
  throw new Error("PostgreSQL integration tests require a database name ending in _test");
}

let database: Database;
let pool: Pool;
let closeDatabase: () => Promise<void>;

beforeAll(async () => {
  const resetPool = new Pool({ connectionString: databaseUrl });
  await resetPool.query("drop schema public cascade");
  await resetPool.query("drop schema if exists drizzle cascade");
  await resetPool.query("create schema public");
  await resetPool.end();

  await migrateFromEnvironment({ DATABASE_URL: databaseUrl });
  await migrateDatabase(databaseUrl, new URL("../migrations", import.meta.url).pathname);

  const connection = createDatabase(databaseUrl);
  database = connection.database;
  pool = connection.pool;
  closeDatabase = connection.close;
});

afterAll(async () => {
  if (closeDatabase) {
    await closeDatabase();
  }
});

async function expectDatabaseRejection(statement: string, parameters: unknown[]): Promise<void> {
  await expect(pool.query(statement, parameters)).rejects.toBeDefined();
}

describe("clean PostgreSQL migrations", () => {
  it("creates the complete Milestone 2 schema with application UUIDs and timestamptz", async () => {
    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "automation_runs",
      "automations",
      "command_requests",
      "development_attempt_events",
      "development_attempts",
      "development_review_events",
      "development_reviews",
      "development_tasks",
      "evidence",
      "idempotency_records",
      "model_invocations",
      "run_events",
      "tool_calls"
    ]);

    const idColumns = await pool.query<{ column_default: string | null }>(
      "select column_default from information_schema.columns where table_schema = 'public' and column_name = 'id'"
    );
    expect(idColumns.rows).toHaveLength(13);
    expect(idColumns.rows.every((row) => row.column_default === null)).toBe(true);

    const timestampTypes = await pool.query<{ data_type: string }>(
      "select distinct data_type from information_schema.columns where table_schema = 'public' and column_name like '%_at'"
    );
    expect(timestampTypes.rows).toEqual([{ data_type: "timestamp with time zone" }]);

    for (const table of [automationRuns, runEvents, modelInvocations, toolCalls, idempotencyRecords]) {
      const foreignKeys = getTableConfig(table).foreignKeys;
      expect(foreignKeys).toHaveLength(1);
      expect(foreignKeys[0]?.reference().foreignColumns).toHaveLength(1);
    }
    expect(getTableConfig(developmentAttempts).foreignKeys[0]?.reference().foreignColumns).toHaveLength(1);
    expect(getTableConfig(developmentAttemptEvents).foreignKeys[0]?.reference().foreignColumns).toHaveLength(1);
    expect(getTableConfig(developmentReviews).foreignKeys).toHaveLength(2);
    expect(getTableConfig(developmentReviews).foreignKeys.map((key) => key.reference().foreignColumns)).toEqual([[developmentTasks.id], [developmentAttempts.id]]);
    expect(getTableConfig(developmentReviewEvents).foreignKeys[0]?.reference().foreignColumns).toHaveLength(1);
  });
});

describe("repositories", () => {
  const canary = "CANARY_SECRET_VALUE";

  it("creates and retrieves validated commands, automations, and runs", async () => {
    const repositories = createRepositories(database, [canary]);
    const defaultRepositories = createRepositories(database);
    const defaultCommand = await defaultRepositories.createCommandRequest({ content: "Safe default" });
    expect(defaultCommand.status).toBe("pending");

    const command = await repositories.createCommandRequest({
      content: "Create a safe automation",
      errorSummary: `Failed with ${canary}`,
      intentType: "automation_create",
      status: "needs_input",
      structuredResult: { reason: "schedule missing" }
    });
    expect(command.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(command.errorSummary).toBe("Failed with [REDACTED]");
    await expect(repositories.getCommandRequest(command.id)).resolves.toEqual(command);
    await expect(repositories.getCommandRequest(randomUUID())).resolves.toBeUndefined();

    const nextRunAt = new Date("2026-08-26T01:00:00.000Z");
    const automation = await repositories.createAutomation({
      completionMode: "continue",
      goal: "Produce a bounded daily summary",
      modelProfile: "balanced",
      name: "Daily summary",
      nextRunAt,
      schedule: "0 9 * * *",
      toolPolicy: "read-only"
    });
    expect(automation.timezone).toBe("Asia/Hong_Kong");
    expect(automation.enabled).toBe(true);
    await expect(repositories.getAutomation(automation.id)).resolves.toEqual(automation);
    await expect(repositories.getAutomation(randomUUID())).resolves.toBeUndefined();

    const manualRun = await repositories.createAutomationRun({
      automationId: automation.id,
      availableAt: nextRunAt,
      modelProfile: "balanced",
      trigger: "manual",
      workflowPhase: "created"
    });
    expect(manualRun.checkpoint).toEqual({});
    expect(manualRun.status).toBe("queued");
    await expect(repositories.getAutomationRun(manualRun.id)).resolves.toEqual(manualRun);
    await expect(repositories.getAutomationRun(randomUUID())).resolves.toBeUndefined();

    const lastRunAt = new Date("2026-08-25T01:00:00.000Z");
    const completedAutomation = await repositories.createAutomation({
      completionMode: "stop_after_success",
      enabled: false,
      goal: "Run once",
      lastRunAt,
      modelProfile: "reasoning",
      name: "One shot",
      nextRunAt,
      schedule: "30 18 * * 1",
      timezone: "UTC",
      toolPolicy: "none"
    });
    expect(completedAutomation).toMatchObject({ enabled: false, lastRunAt, timezone: "UTC" });

    const scheduledRun = await repositories.createAutomationRun({
      attempt: 2,
      automationId: completedAutomation.id,
      availableAt: nextRunAt,
      checkpoint: { candidate: "safe" },
      errorSummary: `error ${canary}`,
      modelProfile: "reasoning",
      resultSummary: `result ${canary}`,
      scheduledFor: nextRunAt,
      status: "succeeded",
      trigger: "scheduled",
      workflowPhase: "complete"
    });
    expect(scheduledRun.errorSummary).toBe("error [REDACTED]");
    expect(scheduledRun.resultSummary).toBe("result [REDACTED]");
  });

  it("records only safe audit, idempotency, and evidence data", async () => {
    const repositories = createRepositories(database, [canary]);
    const automation = await repositories.createAutomation({
      completionMode: "continue",
      goal: "Audit repository behavior",
      modelProfile: "fast",
      name: "Audit test",
      nextRunAt: new Date("2026-08-26T00:00:00.000Z"),
      schedule: "0 8 * * *",
      timezone: "Asia/Hong_Kong",
      toolPolicy: "read-only"
    });
    const run = await repositories.createAutomationRun({
      automationId: automation.id,
      availableAt: new Date("2026-08-26T00:00:00.000Z"),
      modelProfile: "fast",
      status: "succeeded",
      trigger: "command",
      workflowPhase: "complete"
    });

    const emptyEvent = await repositories.appendRunEvent({ eventType: "created", runId: run.id });
    expect(emptyEvent).toMatchObject({ fromStatus: null, payload: {}, toStatus: null });
    const event = await repositories.appendRunEvent({
      eventType: "completed",
      fromStatus: "running",
      payload: { reason: "verified" },
      runId: run.id,
      toStatus: "succeeded"
    });
    expect(event.payload).toEqual({ reason: "verified" });

    const startedInvocation = await repositories.recordModelInvocation({
      executionModelId: "provider-runtime-id",
      modelProfile: "fast",
      role: "general",
      runId: run.id,
      schemaOutcome: "not_requested",
      status: "started"
    });
    expect(startedInvocation).toMatchObject({ latencyMs: null, summary: null, usage: {} });
    const completedAt = new Date("2026-08-26T00:00:02.000Z");
    const invocation = await repositories.recordModelInvocation({
      completedAt,
      executionModelId: "provider-runtime-id",
      latencyMs: 25,
      modelProfile: "fast",
      role: "general",
      runId: run.id,
      schemaOutcome: "valid",
      startedAt: new Date("2026-08-26T00:00:01.000Z"),
      status: "succeeded",
      summary: `safe result ${canary}`,
      usage: { input_tokens: 10, output_tokens: 2 }
    });
    expect(invocation.summary).toBe("safe result [REDACTED]");

    const readCall = await repositories.recordToolCall({
      attempt: 1,
      runId: run.id,
      sideEffectClass: "read_only",
      status: "success",
      tool: "fixture.read"
    });
    expect(readCall).toMatchObject({ inputSummary: null, outputSummary: null });
    const toolCall = await repositories.recordToolCall({
      attempt: 2,
      completedAt,
      externalId: "external-123",
      failureClass: "timeout",
      idempotencyKey: "calendar:event-123",
      inputSummary: `input ${canary}`,
      outputSummary: `output ${canary}`,
      requestedAt: new Date("2026-08-26T00:00:01.000Z"),
      runId: run.id,
      sideEffectClass: "consequential",
      status: "unknown",
      tool: "calendar.create"
    });
    expect(toolCall.inputSummary).toBe("input [REDACTED]");
    expect(toolCall.outputSummary).toBe("output [REDACTED]");

    const idempotency = await repositories.createIdempotencyRecord({
      key: "event-123",
      runId: run.id,
      scope: "calendar.create",
      state: "unknown"
    });
    expect(idempotency.state).toBe("unknown");

    const runEvidence = await repositories.addEvidence({
      evidenceType: "workflow_state",
      payload: { state: "complete" },
      runId: run.id
    });
    expect(runEvidence.toolCallId).toBeNull();
    const toolEvidence = await repositories.addEvidence({
      evidenceType: "external_identifier",
      payload: { external_id: "external-123" },
      runId: run.id,
      toolCallId: toolCall.id
    });
    expect(toolEvidence.toolCallId).toBe(toolCall.id);
  });

  it("rejects invalid or unsafe repository input before persistence", async () => {
    const repositories = createRepositories(database, [canary]);
    const automation = await repositories.createAutomation({
      completionMode: "continue",
      goal: "Validation parent",
      modelProfile: "balanced",
      name: "Validation",
      nextRunAt: new Date(),
      schedule: "0 0 * * *",
      timezone: "UTC",
      toolPolicy: "none"
    });

    await expect(
      repositories.createCommandRequest({ content: `Persist ${canary}` })
    ).rejects.toThrow("Secret material is not allowed");
    await expect(
      repositories.createCommandRequest({
        content: "safe",
        structuredResult: { prompt: "full prompt" }
      })
    ).rejects.toThrow("Prompts, transcripts, external content, and provider model IDs are not durable data");
    await expect(
      repositories.createCommandRequest({
        content: "safe",
        structuredResult: { selected: "gpt-5.6-provider" }
      })
    ).rejects.toThrow("Prompts, transcripts, external content, and provider model IDs are not durable data");
    await expect(
      repositories.createCommandRequest({
        content: "safe",
        structuredResult: { value: "x".repeat(33_000) }
      })
    ).rejects.toThrow("Durable JSON is too large");
    await expect(
      repositories.createAutomation({
        completionMode: "continue",
        goal: "invalid schedule",
        modelProfile: "fast",
        name: "Invalid",
        nextRunAt: new Date(),
        schedule: "0 0 * *",
        timezone: "UTC",
        toolPolicy: "none"
      })
    ).rejects.toThrow("Schedule must have exactly five fields");
    await expect(
      repositories.createAutomation({
        completionMode: "continue",
        goal: "invalid timezone",
        modelProfile: "fast",
        name: "Invalid",
        nextRunAt: new Date(),
        schedule: "0 0 * * *",
        timezone: "Mars/Olympus_Mons",
        toolPolicy: "none"
      })
    ).rejects.toThrow("Timezone must be a valid IANA timezone");
    await expect(
      repositories.createAutomationRun({
        automationId: automation.id,
        availableAt: new Date(),
        modelProfile: "balanced",
        trigger: "scheduled",
        workflowPhase: "created"
      })
    ).rejects.toThrow("Scheduled runs require scheduledFor");
    await expect(
      repositories.createAutomationRun({
        automationId: automation.id,
        availableAt: new Date(),
        modelProfile: "balanced",
        scheduledFor: new Date(),
        trigger: "manual",
        workflowPhase: "created"
      })
    ).rejects.toThrow("Scheduled runs require scheduledFor");
  });
});

describe("database invariants", () => {
  async function createAutomationAndRun(status = "succeeded") {
    const repositories = createRepositories(database);
    const automation = await repositories.createAutomation({
      completionMode: "continue",
      goal: "Constraint fixture",
      modelProfile: "fast",
      name: `Constraint ${randomUUID()}`,
      nextRunAt: new Date("2026-08-26T00:00:00.000Z"),
      schedule: "0 8 * * *",
      timezone: "UTC",
      toolPolicy: "none"
    });
    const run = await repositories.createAutomationRun({
      automationId: automation.id,
      availableAt: new Date("2026-08-26T00:00:00.000Z"),
      modelProfile: "fast",
      status: status as "queued" | "succeeded",
      trigger: "manual",
      workflowPhase: "fixture"
    });
    return { automation, repositories, run };
  }

  it("deduplicates scheduled runs and excludes overlapping active runs", async () => {
    const { automation, repositories } = await createAutomationAndRun();
    const scheduledFor = new Date("2026-08-26T03:00:00.000Z");
    await repositories.createAutomationRun({
      automationId: automation.id,
      availableAt: scheduledFor,
      modelProfile: "fast",
      scheduledFor,
      status: "succeeded",
      trigger: "scheduled",
      workflowPhase: "complete"
    });
    await expect(
      repositories.createAutomationRun({
        automationId: automation.id,
        availableAt: scheduledFor,
        modelProfile: "fast",
        scheduledFor,
        status: "failed",
        trigger: "scheduled",
        workflowPhase: "failed"
      })
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    const active = await createAutomationAndRun("queued");
    await expect(
      active.repositories.createAutomationRun({
        automationId: active.automation.id,
        availableAt: new Date(),
        modelProfile: "fast",
        status: "running",
        trigger: "manual",
        workflowPhase: "running"
      })
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("enforces restrictive history links and evidence-to-run consistency", async () => {
    const first = await createAutomationAndRun();
    const second = await createAutomationAndRun();
    const toolCall = await first.repositories.recordToolCall({
      attempt: 1,
      runId: first.run.id,
      sideEffectClass: "read_only",
      status: "success",
      tool: "fixture.read"
    });

    await expect(
      second.repositories.addEvidence({
        evidenceType: "invalid_cross_run",
        payload: { safe: true },
        runId: second.run.id,
        toolCallId: toolCall.id
      })
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expectDatabaseRejection("delete from automations where id = $1", [first.automation.id]);
  });

  it("keeps run events append-only", async () => {
    const fixture = await createAutomationAndRun();
    const event = await fixture.repositories.appendRunEvent({
      eventType: "fixture",
      payload: { safe: true },
      runId: fixture.run.id
    });

    await expectDatabaseRejection("update run_events set event_type = 'changed' where id = $1", [event.id]);
    await expectDatabaseRejection("delete from run_events where id = $1", [event.id]);
  });

  it("enforces checks and unique idempotency in PostgreSQL", async () => {
    const fixture = await createAutomationAndRun();
    await fixture.repositories.createIdempotencyRecord({
      key: "same-key",
      runId: fixture.run.id,
      scope: "same-scope",
      state: "reserved"
    });
    await expect(
      fixture.repositories.createIdempotencyRecord({
        key: "same-key",
        runId: fixture.run.id,
        scope: "same-scope",
        state: "confirmed"
      })
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    await expectDatabaseRejection(
      "insert into command_requests (id, content, status, structured_result) values ($1, 'safe', 'pending', '[]'::jsonb)",
      [randomUUID()]
    );
    await expectDatabaseRejection(
      "insert into automations (id, name, goal, schedule, timezone, model_profile, tool_policy, completion_mode, next_run_at) values ($1, 'bad', 'bad', '0 0 * *', 'UTC', 'provider-specific', 'none', 'forever', now())",
      [randomUUID()]
    );
    await expectDatabaseRejection(
      "insert into automation_runs (id, automation_id, trigger, status, workflow_phase, checkpoint, available_at, model_profile, claimed_by) values ($1, $2, 'scheduled', 'queued', 'bad', '{}'::jsonb, now(), 'fast', 'worker')",
      [randomUUID(), fixture.automation.id]
    );

    const constraints = await pool.query<{ constraint_name: string }>(
      "select constraint_name from information_schema.table_constraints where table_schema = 'public' and constraint_type in ('CHECK', 'FOREIGN KEY', 'UNIQUE')"
    );
    const names = new Set(constraints.rows.map((row) => row.constraint_name));
    expect(names.has("automation_runs_status_check")).toBe(true);
    expect(names.has("model_invocations_usage_object_check")).toBe(true);
    expect(names.has("tool_calls_side_effect_class_check")).toBe(true);
    expect(names.has("evidence_payload_object_check")).toBe(true);
  });
});
