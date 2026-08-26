import { randomUUID } from "node:crypto";
import {
  automationRuns,
  automations,
  createDatabase,
  createRepositories,
  evidence,
  idempotencyRecords,
  migrateDatabase,
  toolCalls,
  type Database
} from "@personal-agent/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createDatabaseToolPersistence,
  createToolGateway,
  defineTool,
  ToolExecutionError,
  ToolRegistry,
  type AnyToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
  type VerificationResult
} from "../src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for PostgreSQL tool integration tests");
if (!new URL(databaseUrl).pathname.slice(1).endsWith("_test")) throw new Error("PostgreSQL integration tests require a database name ending in _test");

let database: Database;
let pool: ReturnType<typeof createDatabase>["pool"];
let closeDatabase: () => Promise<void>;

beforeAll(async () => {
  const reset = createDatabase(databaseUrl);
  await reset.pool.query("drop schema public cascade");
  await reset.pool.query("drop schema if exists drizzle cascade");
  await reset.pool.query("create schema public");
  await reset.close();
  await migrateDatabase(databaseUrl, new URL("../../db/migrations", import.meta.url).pathname);
  const connection = createDatabase(databaseUrl);
  database = connection.database;
  pool = connection.pool;
  closeDatabase = connection.close;
});

beforeEach(async () => { await pool.query("truncate table automations cascade"); });
afterAll(async () => { await closeDatabase(); });

async function runFixture() {
  const repositories = createRepositories(database);
  const automation = await repositories.createAutomation({
    completionMode: "continue", goal: "Tool gateway fixture", modelProfile: "balanced", name: randomUUID(),
    nextRunAt: new Date("2026-08-26T00:00:00Z"), schedule: "0 0 * * *", timezone: "UTC", toolPolicy: "course-registration"
  });
  return repositories.createAutomationRun({ automationId: automation.id, availableAt: new Date(), modelProfile: "balanced", status: "running", trigger: "manual", workflowPhase: "gateway" });
}

const inputSchema = z.object({ operationKey: z.string().optional(), value: z.string() });
const outputSchema = z.object({ value: z.string() });
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

function definition(options: {
  execute: (input: Input, context: ToolExecutionContext) => Promise<ToolResult<Output>>;
  maxAttempts?: number;
  integration?: "browser" | "google";
  name?: string;
  sideEffect?: "read_only" | "consequential";
  timeoutMs?: number;
  verify?: (input: Input, context: ToolExecutionContext) => Promise<VerificationResult<Output>>;
}): AnyToolDefinition {
  const sideEffect = options.sideEffect ?? "read_only";
  return defineTool({
    execute: options.execute,
    ...(sideEffect === "consequential" ? { idempotencyKey: (input: Input) => `fixture:${input.operationKey!}` } : {}),
    inputSchema,
    integration: options.integration ?? "browser",
    name: options.name ?? "browser.open",
    outputSchema,
    permission: sideEffect === "consequential" ? "external_write" : "external_read",
    retryPolicy: { maxAttempts: options.maxAttempts ?? 1, retryableFailureClasses: ["timeout", "transport_error", "rate_limited"] },
    safeInputSummary: (input) => ({ valueLength: input.value.length }),
    safeOutputSummary: (output) => ({ valueLength: output.value.length }),
    sideEffect,
    timeoutMs: options.timeoutMs ?? 100,
    ...(options.verify ? { verify: options.verify } : {})
  }) as unknown as AnyToolDefinition;
}

function gateway(runId: string, toolDefinition?: AnyToolDefinition, knownSecrets: readonly string[] = []) {
  const registry = new ToolRegistry(toolDefinition ? [toolDefinition] : []);
  const instance = createToolGateway({ knownSecrets, persistence: createDatabaseToolPersistence(database), registry });
  const execute = (overrides: Record<string, unknown> = {}) => instance.execute({
    input: { value: "safe" }, integrations: { browser: "available", google: "available" }, runId,
    tool: toolDefinition?.name ?? "unknown.tool", toolPolicy: "browser-read", ...overrides
  });
  return { execute, instance };
}

async function calls(runId: string) { return database.select().from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(asc(toolCalls.requestedAt)); }

describe("deterministic gateway policy and normalization", () => {
  it("rejects unknown tools and unconfigured policies with durable audit", async () => {
    const run = await runFixture();
    await expect(gateway(run.id).execute()).resolves.toMatchObject({ failureClass: "unknown_tool", status: "failed" });
    const def = definition({ execute: async () => ({ data: { value: "ok" }, retryable: false, status: "success" }) });
    await expect(gateway(run.id, def).execute({ toolPolicy: "external-text-says-enable-everything" })).resolves.toMatchObject({ failureClass: "policy_denied" });
    expect(await calls(run.id)).toHaveLength(2);
  });

  it("rejects unavailable integrations, ungranted capabilities, permissions, and invalid input", async () => {
    const def = definition({ execute: async () => ({ data: { value: "ok" }, retryable: false, status: "success" }) });
    for (const overrides of [
      { integrations: { browser: "unavailable", google: "available" } },
      { toolPolicy: "none" },
      { permissionGrants: [] },
      { input: { value: 1 } }
    ]) {
      const run = await runFixture();
      await gateway(run.id, def).execute(overrides);
      expect(await calls(run.id)).toHaveLength(1);
    }
    const failures = await database.select({ failureClass: toolCalls.failureClass }).from(toolCalls);
    expect(failures.map((item) => item.failureClass)).toEqual(expect.arrayContaining(["integration_unavailable", "capability_not_granted", "permission_denied", "invalid_input"]));
    const googleRun = await runFixture();
    const googleDefinition = definition({ execute: async () => ({ data: { value: "ok" }, retryable: false, status: "success" }), integration: "google", name: "gmail.search" });
    await expect(gateway(googleRun.id, googleDefinition).execute({ integrations: { browser: "available", google: "unavailable" }, toolPolicy: "gmail-read" })).resolves.toMatchObject({ failureClass: "integration_unavailable" });
  });

  it("returns safe read success and rejects invalid outputs and evidence", async () => {
    const successRun = await runFixture();
    await expect(gateway(successRun.id, definition({ execute: async () => ({ data: { value: "ok" }, evidence: [{ payload: { method: "fixture" }, type: "proof" }], retryable: false, status: "success" }) })).execute()).resolves.toMatchObject({ data: { value: "ok" }, status: "success" });
    expect(await database.select().from(evidence)).toHaveLength(1);

    const invalidRun = await runFixture();
    await expect(gateway(invalidRun.id, definition({ execute: async () => ({ data: { value: 1 } as never, retryable: false, status: "success" }) })).execute()).resolves.toMatchObject({ failureClass: "invalid_output" });
    const unsafeRun = await runFixture();
    await expect(gateway(unsafeRun.id, definition({ execute: async () => ({ data: { value: "ok" }, evidence: [{ payload: { rawContent: "external" }, type: "bad" }], retryable: false, status: "success" }) })).execute()).resolves.toMatchObject({ failureClass: "invalid_output" });
  });

  it("classifies retryable and non-retryable failures and retries only policy-safe classes", async () => {
    let attempts = 0;
    const run = await runFixture();
    const def = definition({ maxAttempts: 2, execute: async () => { attempts += 1; if (attempts === 1) throw new ToolExecutionError("transport_error", true); return { data: { value: "recovered" }, retryable: false, status: "success" }; } });
    await expect(gateway(run.id, def).execute()).resolves.toMatchObject({ data: { value: "recovered" } });
    expect(await calls(run.id)).toHaveLength(2);

    const deniedRun = await runFixture();
    await expect(gateway(deniedRun.id, definition({ maxAttempts: 2, execute: async () => ({ failureClass: "policy_denied", retryable: false, status: "failed" }) })).execute()).resolves.toMatchObject({ failureClass: "policy_denied" });
    expect(await calls(deniedRun.id)).toHaveLength(1);
  });

  it("normalizes raw exceptions, malformed statuses, and success without output", async () => {
    const raw = await runFixture();
    await expect(gateway(raw.id, definition({ execute: async () => { throw new Error("unsafe provider detail"); } })).execute()).resolves.toMatchObject({ failureClass: "transport_error" });
    const status = await runFixture();
    await expect(gateway(status.id, definition({ execute: async () => ({ retryable: false, status: "maybe" } as never) })).execute()).resolves.toMatchObject({ failureClass: "invalid_output" });
    const missing = await runFixture();
    await expect(gateway(missing.id, definition({ execute: async () => ({ retryable: false, status: "success" } as never) })).execute()).resolves.toMatchObject({ failureClass: "invalid_output" });
    const noClass = await runFixture();
    await expect(gateway(noClass.id, definition({ execute: async () => ({ retryable: false, status: "failed" }) })).execute()).resolves.toMatchObject({ status: "failed" });
    const external = await runFixture();
    await expect(gateway(external.id, definition({ execute: async () => ({ data: { value: "ok" }, externalId: "external", retryable: false, status: "success" }) })).execute()).resolves.toMatchObject({ externalId: "external" });
    const emptyName = await runFixture();
    const noDefaults = createToolGateway({ persistence: createDatabaseToolPersistence(database), registry: new ToolRegistry([]) });
    await noDefaults.execute({ input: [], integrations: { browser: "available", google: "available" }, runId: emptyName.id, tool: "", toolPolicy: "none" });
    expect((await calls(emptyName.id))[0]?.tool).toBe("invalid.tool_name");
    const malformed = { ...definition({ execute: async () => ({ data: { value: "unused" }, retryable: false, status: "success" }) }), retryPolicy: { maxAttempts: 0, retryableFailureClasses: [] } } as unknown as AnyToolDefinition;
    const malformedRun = await runFixture();
    await expect(gateway(malformedRun.id, malformed).execute()).rejects.toThrow("retry loop exhausted");
  });

  it("distinguishes timeout before a side effect from timeout after a possible side effect", async () => {
    const before = await runFixture();
    await expect(gateway(before.id, definition({ execute: async () => new Promise(() => undefined), timeoutMs: 5 })).execute()).resolves.toMatchObject({ failureClass: "timeout", status: "failed" });

    const after = await runFixture();
    const submit = definition({ execute: async (_input, context) => { context.reportSideEffectStarted(); return new Promise(() => undefined); }, name: "browser.submit", sideEffect: "consequential", timeoutMs: 5, verify: async () => ({ status: "unknown" }) });
    await expect(gateway(after.id, submit).execute({ input: { operationKey: "timeout", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "unknown" });
    await expect(database.select().from(automationRuns).where(eq(automationRuns.id, after.id))).resolves.toMatchObject([{ status: "verifying" }]);
    await expect(database.select().from(idempotencyRecords)).resolves.toMatchObject([{ state: "unknown" }]);
    const thrown = await runFixture();
    const thrownSubmit = definition({ execute: async (_input, executionContext) => { executionContext.reportSideEffectStarted(); throw new ToolExecutionError("transport_error", true); }, name: "browser.submit", sideEffect: "consequential", verify: async (_input, verificationContext) => { verificationContext.reportSideEffectStarted(); return { status: "unknown" }; } });
    await expect(gateway(thrown.id, thrownSubmit).execute({ input: { operationKey: "thrown", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "unknown" });

    let executions = 0;
    const stillRunning = await runFixture();
    const delayedSubmit = definition({
      execute: async (_input, executionContext) => {
        executions += 1;
        executionContext.reportSideEffectStarted();
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return { data: { value: "late-success" }, retryable: false, status: "success" };
      },
      maxAttempts: 2,
      name: "browser.submit",
      sideEffect: "consequential",
      timeoutMs: 5,
      verify: async () => ({ status: "absent" })
    });
    await expect(gateway(stillRunning.id, delayedSubmit).execute({ input: { operationKey: "still-running", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "unknown" });
    expect(executions).toBe(1);
  });
});

describe("consequential idempotency and verification", () => {
  const input = { operationKey: "same-operation", value: "safe" };
  const request = { input, toolPolicy: "course-registration" };

  it("does not repeat a verified-existing side effect", async () => {
    let executions = 0;
    const run = await runFixture();
    const def = definition({ execute: async () => { executions += 1; return { failureClass: "timeout", retryable: false, status: "unknown" }; }, name: "browser.submit", sideEffect: "consequential", verify: async () => ({ data: { value: "existing" }, evidence: [{ payload: { externalId: "one" }, type: "confirmation" }], externalId: "one", status: "exists" }) });
    const tool = gateway(run.id, def);
    await expect(tool.execute(request)).resolves.toMatchObject({ data: { value: "existing" }, status: "success" });
    await expect(tool.execute(request)).resolves.toMatchObject({ data: { value: "existing" }, status: "success" });
    expect(executions).toBe(1);
    expect((await database.select().from(idempotencyRecords))[0]?.state).toBe("confirmed");
    expect(await calls(run.id)).toHaveLength(3);
    expect(await database.select().from(evidence)).toHaveLength(2);
  });

  it("retries a verified-absent outcome only when retry policy allows", async () => {
    let executions = 0;
    const run = await runFixture();
    const def = definition({ maxAttempts: 2, execute: async () => { executions += 1; return executions === 1 ? { failureClass: "timeout", retryable: false, status: "unknown" } : { data: { value: "created" }, retryable: false, status: "success" }; }, name: "browser.submit", sideEffect: "consequential", verify: async () => ({ status: "absent" }) });
    await expect(gateway(run.id, def).execute(request)).resolves.toMatchObject({ data: { value: "created" } });
    expect(executions).toBe(2);
    expect(await calls(run.id)).toHaveLength(2);
  });

  it("blocks concurrent duplicate execution attempts in PostgreSQL", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const run = await runFixture();
    const def = definition({ execute: async (_input, context) => { context.reportSideEffectStarted(); started(); await held; return { data: { value: "created" }, retryable: false, status: "success" }; }, name: "browser.submit", sideEffect: "consequential", verify: async () => ({ status: "absent" }) });
    const tool = gateway(run.id, def);
    const first = tool.execute(request);
    await didStart;
    await expect(tool.execute(request)).resolves.toMatchObject({ failureClass: "duplicate_in_progress", status: "unknown" });
    release();
    await expect(first).resolves.toMatchObject({ status: "success" });
    expect((await database.select().from(idempotencyRecords))).toHaveLength(1);
  });

  it("redacts secrets in persisted summaries and validates evidence linkage", async () => {
    const canary = "CANARY_TOOL_SECRET";
    const run = await runFixture();
    const def = defineTool({
      execute: async () => ({ data: { value: "safe" }, evidence: [{ payload: { method: "safe" }, type: "proof" }], retryable: false, status: "success" as const }),
      inputSchema, integration: "browser" as const, name: "browser.open", outputSchema, permission: "external_read" as const, retryPolicy: { maxAttempts: 1, retryableFailureClasses: [] },
      safeInputSummary: () => ({ authorization: canary }), safeOutputSummary: () => ({ secret: canary }), sideEffect: "read_only" as const, timeoutMs: 100
    }) as unknown as AnyToolDefinition;
    await gateway(run.id, def, [canary]).execute({ input: { value: canary } });
    const [call] = await calls(run.id);
    expect(call?.inputSummary).not.toContain(canary);
    expect(call?.outputSummary).not.toContain(canary);
    const [proof] = await database.select().from(evidence);
    expect(proof?.toolCallId).toBe(call?.id);
    expect(proof?.runId).toBe(run.id);
  });

  it("keeps unverifiable, malformed, and failed consequential outcomes safe", async () => {
    const cases: Array<{ execute?: () => Promise<ToolResult<Output>>; verify?: () => Promise<VerificationResult<Output>> }> = [
      {},
      { verify: async () => { throw new Error("verification transport"); } },
      { verify: async () => new Promise(() => undefined) },
      { verify: async () => ({ data: { value: 1 } as never, status: "exists" }) },
      { verify: async () => ({ data: { value: "ok" }, evidence: [{ payload: { rawContent: "unsafe" }, type: "bad" }], status: "exists" }) }
    ];
    for (const [index, item] of cases.entries()) {
      const run = await runFixture();
      const def = definition({ execute: item.execute ?? (async () => ({ failureClass: "timeout", retryable: false, status: "unknown" })), name: "browser.submit", sideEffect: "consequential", ...(item.verify ? { verify: item.verify } : {}) });
      await expect(gateway(run.id, def).execute({ input: { operationKey: `unsafe-${index}`, value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "unknown" });
    }
    const failedRun = await runFixture();
    const failedDef = definition({ execute: async () => ({ failureClass: "policy_denied", retryable: false, status: "failed" }), name: "browser.submit", sideEffect: "consequential", verify: async () => ({ status: "absent" }) });
    await expect(gateway(failedRun.id, failedDef).execute({ input: { operationKey: "failed", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "failed" });
  });

  it("resolves pre-existing unknown and confirmed reservations through verification", async () => {
    const unknownRun = await runFixture();
    const repositories = createRepositories(database);
    await repositories.createIdempotencyRecord({ key: "fixture:existing-unknown", runId: unknownRun.id, scope: "browser.submit", state: "unknown" });
    const existing = definition({ execute: async () => ({ data: { value: "should-not-run" }, retryable: false, status: "success" }), name: "browser.submit", sideEffect: "consequential", verify: async () => ({ data: { value: "existing" }, status: "exists" }) });
    await expect(gateway(unknownRun.id, existing).execute({ input: { operationKey: "existing-unknown", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ data: { value: "existing" } });

    const absentRun = await runFixture();
    await repositories.createIdempotencyRecord({ key: "fixture:existing-absent", runId: absentRun.id, scope: "browser.submit", state: "unknown" });
    const absent = definition({ execute: async () => ({ data: { value: "created" }, retryable: false, status: "success" }), name: "browser.submit", sideEffect: "consequential", verify: async () => ({ status: "absent" }) });
    await expect(gateway(absentRun.id, absent).execute({ input: { operationKey: "existing-absent", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ data: { value: "created" } });

    const confirmedRun = await runFixture();
    await repositories.createIdempotencyRecord({ key: "fixture:confirmed-absent", runId: confirmedRun.id, scope: "browser.submit", state: "confirmed" });
    await expect(gateway(confirmedRun.id, absent).execute({ input: { operationKey: "confirmed-absent", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ failureClass: "verification_failed", status: "unknown" });

    for (const [operationKey, verification] of [
      ["unknown-explicit", { failureClass: "transport_error", status: "unknown" }],
      ["unknown-default", { status: "unknown" }]
    ] as const) {
      const unresolvedRun = await runFixture();
      await repositories.createIdempotencyRecord({ key: `fixture:${operationKey}`, runId: unresolvedRun.id, scope: "browser.submit", state: "unknown" });
      const unresolved = definition({ execute: async () => ({ data: { value: "never" }, retryable: false, status: "success" }), name: "browser.submit", sideEffect: "consequential", verify: async () => verification });
      await expect(gateway(unresolvedRun.id, unresolved).execute({ input: { operationKey, value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "unknown" });
    }
  });

  it("allows only one caller to claim an unknown reservation verified absent", async () => {
    const run = await runFixture();
    await createRepositories(database).createIdempotencyRecord({ key: "fixture:claim-race", runId: run.id, scope: "browser.submit", state: "unknown" });
    let releases = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const def = definition({ execute: async () => ({ data: { value: "created" }, retryable: false, status: "success" }), name: "browser.submit", sideEffect: "consequential", verify: async () => { releases += 1; if (releases === 2) release(); await held; return { status: "absent" }; } });
    const tool = gateway(run.id, def);
    const results = await Promise.all([
      tool.execute({ input: { operationKey: "claim-race", value: "safe" }, toolPolicy: "course-registration" }),
      tool.execute({ input: { operationKey: "claim-race", value: "safe" }, toolPolicy: "course-registration" })
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["success", "unknown"]);
  });

  it("does not retry an unknown result when another caller wins the retry claim", async () => {
    const run = await runFixture();
    const base = createDatabaseToolPersistence(database);
    const persistence = {
      ...base,
      transitionIdempotency: async (input: Parameters<typeof base.transitionIdempotency>[0]) =>
        input.expected === "unknown" && input.state === "reserved" ? false : base.transitionIdempotency(input)
    };
    const def = definition({ maxAttempts: 2, execute: async () => ({ failureClass: "timeout", retryable: false, status: "unknown" }), name: "browser.submit", sideEffect: "consequential", verify: async () => ({ status: "absent" }) });
    const instance = createToolGateway({ persistence, registry: new ToolRegistry([def]) });
    await expect(instance.execute({ input: { operationKey: "lost-claim", value: "safe" }, integrations: { browser: "available", google: "available" }, runId: run.id, tool: "browser.submit", toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "unknown" });
  });

  it("uses default retry classifications when adapters omit a failure class", async () => {
    let attempts = 0;
    const run = await runFixture();
    const read = definition({ maxAttempts: 2, execute: async () => { attempts += 1; return attempts === 1 ? { retryable: true, status: "failed" } : { data: { value: "ok" }, retryable: false, status: "success" }; } });
    await expect(gateway(run.id, read).execute()).resolves.toMatchObject({ data: { value: "ok" } });
    const unknownRun = await runFixture();
    let unknownAttempts = 0;
    const submit = definition({ maxAttempts: 2, execute: async () => { unknownAttempts += 1; return unknownAttempts === 1 ? { retryable: false, status: "unknown" } : { data: { value: "ok" }, retryable: false, status: "success" }; }, name: "browser.submit", sideEffect: "consequential", verify: async () => ({ status: "absent" }) });
    await expect(gateway(unknownRun.id, submit).execute({ input: { operationKey: "default-class", value: "safe" }, toolPolicy: "course-registration" })).resolves.toMatchObject({ status: "unknown" });
  });

  it("normalizes verified existence without an optional external identifier", async () => {
    const run = await runFixture();
    const submit = definition({ execute: async () => ({ failureClass: "timeout", retryable: false, status: "unknown" }), name: "browser.submit", sideEffect: "consequential", verify: async () => ({ data: { value: "verified" }, status: "exists" }) });
    await expect(gateway(run.id, submit).execute({ input: { operationKey: "verified-no-id", value: "safe" }, toolPolicy: "course-registration" })).resolves.toEqual({ data: { value: "verified" }, evidence: [], retryable: false, status: "success" });
  });

  it("exposes only definitions resolved for the run and never expands from external text", async () => {
    const run = await runFixture();
    const def = definition({ execute: async () => ({ data: { value: "ok" }, retryable: false, status: "success" }) });
    const tool = gateway(run.id, def);
    expect(tool.instance.resolveDefinitions("browser-read", { browser: "available", google: "available" }).map((item) => item.name)).toEqual(["browser.open"]);
    expect(tool.instance.resolveDefinitions("browser-read", { browser: "unavailable", google: "available" })).toEqual([]);
    expect(tool.instance.resolveDefinitions("none", { browser: "available", google: "available" })).toEqual([]);
    expect(new Set((await database.select().from(automations)).map((item) => item.toolPolicy))).not.toContain("calendar-delete");
  });

  it("handles persistence lookups and rejects lifecycle writes for missing runs", async () => {
    const run = await runFixture();
    const persistence = createDatabaseToolPersistence(database);
    await expect(persistence.readIdempotency("missing", "missing")).resolves.toBeUndefined();
    await persistence.reserveIdempotency({ key: "lookup", now: new Date(), runId: run.id, scope: "fixture.tool" });
    await expect(persistence.readIdempotency("fixture.tool", "lookup")).resolves.toMatchObject({ state: "reserved" });
    const missing = "00000000-0000-4000-8000-000000000099";
    await expect(persistence.markConsequentialPending({ idempotencyKey: "key", now: new Date(), runId: missing, tool: "browser.submit" })).rejects.toThrow("lease is not current");
    await expect(persistence.markConsequentialOutcome({ idempotencyKey: "key", now: new Date(), outcome: "unknown", runId: missing, tool: "browser.submit" })).rejects.toThrow("lease is not current");
  });

  it("fences consequential writes with the current worker lease", async () => {
    const run = await runFixture();
    const now = new Date();
    await database
      .update(automationRuns)
      .set({
        claimedAt: now,
        claimedBy: "current-worker",
        leaseExpiresAt: new Date(now.getTime() + 60_000)
      })
      .where(eq(automationRuns.id, run.id));
    const submit = definition({
      execute: async () => ({ data: { value: "created" }, retryable: false, status: "success" }),
      name: "browser.submit",
      sideEffect: "consequential",
      verify: async () => ({ status: "absent" })
    });
    await expect(gateway(run.id, submit).execute({
      input: { operationKey: "stale", value: "safe" },
      toolPolicy: "course-registration",
      workerId: "stale-worker"
    })).rejects.toThrow("lease is not current");
    await expect(gateway(run.id, submit).execute({
      input: { operationKey: "current", value: "safe" },
      toolPolicy: "course-registration",
      workerId: "current-worker"
    })).resolves.toMatchObject({ status: "success" });
  });
});
