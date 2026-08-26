import { randomUUID } from "node:crypto";
import {
  automationRuns,
  commandRequests,
  createDatabase,
  createRepositories,
  migrateDatabase,
  type Database
} from "@personal-agent/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApi, publicError, respond } from "../src/server/http";
import {
  ApplicationError,
  createProductService,
  readWorkerHealth
} from "../src/server/product";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for app integration tests");
if (!new URL(databaseUrl).pathname.slice(1).endsWith("_test")) {
  throw new Error("App integration tests require a database name ending in _test");
}

let database: Database;
let pool: ReturnType<typeof createDatabase>["pool"];
let closeDatabase: () => Promise<void>;
const now = new Date("2026-08-26T08:00:00.000Z");

beforeAll(async () => {
  const reset = createDatabase(databaseUrl);
  await reset.pool.query("drop schema public cascade");
  await reset.pool.query("drop schema if exists drizzle cascade");
  await reset.pool.query("create schema public");
  await reset.close();
  await migrateDatabase(
    databaseUrl,
    new URL("../../../packages/db/migrations", import.meta.url).pathname
  );
  const connection = createDatabase(databaseUrl);
  database = connection.database;
  pool = connection.pool;
  closeDatabase = connection.close;
});

beforeEach(async () => {
  await pool.query("truncate table command_requests, automations cascade");
});

afterAll(async () => closeDatabase());

function service(overrides: Parameters<typeof createProductService>[1] = {}) {
  return createProductService(database, { clock: () => now, ...overrides });
}

function jsonRequest(path: string, method: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
    method
  });
}

const validAutomation = {
  completionMode: "continue",
  enabled: true,
  goal: "Check the fixture safely",
  modelProfile: "balanced",
  name: "Fixture automation",
  schedule: "0 9 * * *",
  timezone: "Asia/Hong_Kong",
  toolPolicy: "browser-read"
};

describe("command and automation HTTP boundaries", () => {
  it("creates and retrieves a validated durable command", async () => {
    const api = createHttpApi(service());
    const created = await api.createCommand(jsonRequest("/api/commands", "POST", {
      content: "  Check the course page  "
    }));
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; content: string; status: string };
    expect(body).toMatchObject({ content: "Check the course page", status: "pending" });

    const fetched = await api.getCommand(
      new Request(`http://localhost/api/commands/${body.id}`),
      body.id
    );
    expect(await fetched.json()).toMatchObject({ id: body.id, status: "pending" });
    const [stored] = await database.select().from(commandRequests);
    expect(stored).toMatchObject({ content: "Check the course page", structuredResult: null });
  });

  it("rejects invalid, credential-bearing, malformed, and database-shaped commands safely", async () => {
    const api = createHttpApi(service());
    for (const request of [
      jsonRequest("/api/commands", "POST", { content: "" }),
      jsonRequest("/api/commands", "POST", { content: "sk-abcdefghijklmnop" }),
      jsonRequest("/api/commands", "POST", { content: "safe", status: "completed" }),
      new Request("http://localhost/api/commands", { body: "{", method: "POST" }),
      new Request("http://localhost/api/commands", { method: "POST" })
    ]) {
      const response = await api.createCommand(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: expect.any(String) }
      });
    }
    expect(await database.select().from(commandRequests)).toHaveLength(0);
  });

  it("creates, lists, reads, and updates only approved automation fields", async () => {
    const product = service();
    const api = createHttpApi(product);
    const createdResponse = await api.createAutomation(
      jsonRequest("/api/automations", "POST", validAutomation)
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; nextRunAt: string; version: number };
    expect(created.version).toBe(1);
    expect(created.nextRunAt).toBe("2026-08-27T01:00:00.000Z");

    const listed = await api.listAutomations(new Request("http://localhost/api/automations?limit=1&offset=0"));
    expect(await listed.json()).toMatchObject({ items: [{ id: created.id }], page: { count: 1 } });
    const updatedResponse = await api.updateAutomation(
      jsonRequest(`/api/automations/${created.id}`, "PATCH", {
        ...validAutomation,
        enabled: false,
        goal: "Updated safe goal",
        name: "Updated automation",
        schedule: "30 10 * * *",
        timezone: "UTC",
        version: 1
      }),
      created.id
    );
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json() as { enabled: boolean; nextRunAt: string; version: number };
    expect(updated).toMatchObject({ enabled: false, version: 2 });
    expect(updated.nextRunAt).toBe("2026-08-26T10:30:00.000Z");

    const reenabled = await product.updateAutomation(created.id, { enabled: true, version: 2 });
    expect(reenabled).toMatchObject({ enabled: true, version: 3 });
    const renamed = await product.updateAutomation(created.id, { name: "Partial edit", version: 3 });
    expect(renamed).toMatchObject({ name: "Partial edit", version: 4 });
    expect(renamed.nextRunAt).toBe(reenabled.nextRunAt);

    const defaults = await product.createAutomation({
      completionMode: "stop_after_success",
      goal: "Defaults",
      modelProfile: "fast",
      name: "Defaults",
      schedule: "0 0 * * *",
      toolPolicy: "none"
    });
    expect(defaults).toMatchObject({ enabled: true, timezone: "Asia/Hong_Kong" });
    await expect(createProductService(database).createAutomation({
      completionMode: "continue",
      goal: "Default clock",
      modelProfile: "balanced",
      name: "Default clock",
      schedule: "0 0 * * *",
      toolPolicy: "none"
    })).resolves.toMatchObject({ name: "Default clock" });

    const stale = await api.updateAutomation(
      jsonRequest(`/api/automations/${created.id}`, "PATCH", { name: "Stale", version: 1 }),
      created.id
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: { code: "version_conflict", message: expect.any(String) }
    });
  });

  it("rejects invalid automation policy, schedule, timezone, profile, bounds, and protected fields", async () => {
    const api = createHttpApi(service());
    const cases: Array<[unknown, number, string]> = [
      [{ ...validAutomation, schedule: "0 9 * *" }, 400, "invalid_request"],
      [{ ...validAutomation, schedule: "61 25 32 13 8" }, 400, "invalid_request"],
      [{ ...validAutomation, timezone: "Mars/Olympus" }, 400, "invalid_request"],
      [{ ...validAutomation, modelProfile: "gpt-5.6-sol" }, 400, "invalid_request"],
      [{ ...validAutomation, toolPolicy: "calendar.delete_event" }, 403, "policy_denied"],
      [{ ...validAutomation, claimedBy: "client" }, 400, "invalid_request"]
    ];
    for (const [body, status, code] of cases) {
      const response = await api.createAutomation(jsonRequest("/api/automations", "POST", body));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    const bounds = await api.listAutomations(
      new Request("http://localhost/api/automations?limit=51")
    );
    expect(bounds.status).toBe(400);
    const unknownQuery = await api.listAutomations(
      new Request("http://localhost/api/automations?internal=true")
    );
    expect(unknownQuery.status).toBe(400);
  });

  it("returns structured not-found and invalid-update errors without database details", async () => {
    const api = createHttpApi(service());
    const missing = randomUUID();
    for (const response of [
      await api.getCommand(new Request("http://localhost"), missing),
      await api.updateAutomation(
        jsonRequest("/api/automations/missing", "PATCH", { name: "x", version: 1 }),
        missing
      )
    ]) {
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toMatch(/postgres|stack|relation/i);
    }
    const invalidId = await api.getCommand(new Request("http://localhost"), "not-a-uuid");
    expect(invalidId.status).toBe(400);
    const emptyUpdate = await api.updateAutomation(
      jsonRequest("/api/automations/x", "PATCH", { version: 1 }),
      missing
    );
    expect(emptyUpdate.status).toBe(400);
    const protectedUpdate = await api.updateAutomation(
      jsonRequest("/api/automations/x", "PATCH", { attempt: 99, version: 1 }),
      missing
    );
    expect(protectedUpdate.status).toBe(400);
  });
});

async function createAutomationAndRun(status: "needs_human" | "queued" | "running" | "succeeded") {
  const repositories = createRepositories(database);
  const automation = await repositories.createAutomation({
    completionMode: "continue",
    goal: "Run fixture",
    modelProfile: "balanced",
    name: randomUUID(),
    nextRunAt: new Date("2026-08-27T00:00:00.000Z"),
    schedule: "0 0 * * *",
    timezone: "UTC",
    toolPolicy: "course-registration"
  });
  const run = await repositories.createAutomationRun({
    automationId: automation.id,
    availableAt: now,
    modelProfile: "balanced",
    status,
    trigger: "manual",
    workflowPhase: "fixture"
  });
  return { automation, repositories, run };
}

describe("bounded run, activity, evidence, and resume surfaces", () => {
  it("orders and bounds run lists deterministically", async () => {
    const first = await createAutomationAndRun("succeeded");
    const second = await createAutomationAndRun("succeeded");
    const third = await createAutomationAndRun("succeeded");
    await database.update(automationRuns).set({ createdAt: new Date("2026-08-26T01:00:00Z") }).where(eq(automationRuns.id, first.run.id));
    await database.update(automationRuns).set({ createdAt: new Date("2026-08-26T03:00:00Z") }).where(eq(automationRuns.id, second.run.id));
    await database.update(automationRuns).set({ createdAt: new Date("2026-08-26T02:00:00Z") }).where(eq(automationRuns.id, third.run.id));

    const api = createHttpApi(service());
    const response = await api.listRuns(new Request("http://localhost/api/runs?limit=2&offset=0"));
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string }>; page: { count: number } };
    expect(body.items.map((item) => item.id)).toEqual([second.run.id, third.run.id]);
    expect(body.page.count).toBe(2);
    expect((await api.listRuns(new Request("http://localhost/api/runs?limit=0"))).status).toBe(400);
    expect((await api.listRuns(new Request("http://localhost/api/runs?offset=10001"))).status).toBe(400);
  });

  it("returns bounded safe run detail without checkpoint, payload, prompt, response, or external bodies", async () => {
    const { repositories, run } = await createAutomationAndRun("succeeded");
    await database.update(automationRuns).set({
      checkpoint: { emailBody: "UNRESTRICTED_EMAIL_BODY", prompt: "HIDDEN_PROMPT" }
    }).where(eq(automationRuns.id, run.id));
    await repositories.appendRunEvent({
      eventType: "fixture_event",
      payload: { rawText: "EVENT_EXTERNAL_BODY" },
      runId: run.id,
      toStatus: "succeeded"
    });
    const tool = await repositories.recordToolCall({
      attempt: 1,
      externalId: "external-1",
      inputSummary: "UNRESTRICTED_TOOL_INPUT",
      outputSummary: "UNRESTRICTED_TOOL_OUTPUT",
      runId: run.id,
      sideEffectClass: "consequential",
      status: "success",
      tool: "calendar.create_event"
    });
    await repositories.addEvidence({
      evidenceType: "calendar_event",
      payload: { body: "UNRESTRICTED_EVIDENCE_BODY" },
      runId: run.id,
      toolCallId: tool.id
    });
    await repositories.recordModelInvocation({
      completedAt: now,
      executionModelId: "provider-model-must-not-be-exposed",
      latencyMs: 10,
      modelProfile: "balanced",
      role: "general",
      runId: run.id,
      schemaOutcome: "valid",
      status: "succeeded",
      summary: "decision_complete",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }
    });
    await repositories.recordModelInvocation({
      executionModelId: "second-provider-model",
      modelProfile: "fast",
      role: "extractor",
      runId: run.id,
      schemaOutcome: "not_requested",
      startedAt: new Date(now.getTime() + 1_000),
      status: "started",
      usage: {}
    });

    const api = createHttpApi(service());
    const response = await api.getRun(
      new Request("http://localhost/api/runs/id?eventLimit=1&evidenceLimit=1&toolLimit=1&modelLimit=2"),
      run.id
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      evidence: [{ externalId: "external-1", type: "calendar_event" }],
      events: [{ eventType: "fixture_event" }],
      toolCalls: [{ tool: "calendar.create_event" }]
    });
    expect((body.modelInvocations as Array<{ usage: object }>).map((item) => item.usage)).toEqual(
      expect.arrayContaining([{}, { inputTokens: 5, outputTokens: 2, totalTokens: 7 }])
    );
    const serialized = JSON.stringify(body);
    for (const prohibited of [
      "checkpoint",
      "UNRESTRICTED_EMAIL_BODY",
      "HIDDEN_PROMPT",
      "EVENT_EXTERNAL_BODY",
      "UNRESTRICTED_TOOL_INPUT",
      "UNRESTRICTED_TOOL_OUTPUT",
      "UNRESTRICTED_EVIDENCE_BODY",
      "provider-model-must-not-be-exposed"
    ]) expect(serialized).not.toContain(prohibited);
    expect((await api.getRun(new Request("http://localhost?eventLimit=51"), run.id)).status).toBe(400);
    expect((await api.getRun(new Request("http://localhost"), randomUUID())).status).toBe(404);
  });

  it("resumes only needs_human through the shared transition rule and preserves checkpoints", async () => {
    const eligible = await createAutomationAndRun("needs_human");
    const checkpoint = { cursor: "step-2", humanRequest: { question: "Complete OTP" } };
    await database.update(automationRuns).set({ checkpoint }).where(eq(automationRuns.id, eligible.run.id));
    const product = service();
    await expect(product.resumeRun(eligible.run.id, {})).resolves.toEqual({
      id: eligible.run.id,
      resumed: true,
      status: "queued"
    });
    const [stored] = await database.select().from(automationRuns).where(eq(automationRuns.id, eligible.run.id));
    expect(stored).toMatchObject({ checkpoint, status: "queued" });
    await expect(product.resumeRun(eligible.run.id, {})).resolves.toEqual({
      id: eligible.run.id,
      resumed: false,
      status: "queued"
    });

    for (const status of ["queued", "running", "succeeded"] as const) {
      const fixture = await createAutomationAndRun(status);
      await expect(product.resumeRun(fixture.run.id, {})).rejects.toMatchObject({
        code: "invalid_transition"
      });
    }
    await expect(product.resumeRun(randomUUID(), {})).rejects.toMatchObject({ code: "not_found" });
    await expect(product.resumeRun(eligible.run.id, { input: "unapproved" })).rejects.toThrow();
    const api = createHttpApi(product);
    expect((await api.resumeRun(
      jsonRequest(`/api/runs/${eligible.run.id}/resume`, "POST", { input: "unapproved" }),
      eligible.run.id
    )).status).toBe(400);
    const apiEligible = await createAutomationAndRun("needs_human");
    expect((await api.resumeRun(
      new Request(`http://localhost/api/runs/${apiEligible.run.id}/resume`, { method: "POST" }),
      apiEligible.run.id
    )).status).toBe(200);
  });

  it("serializes duplicate resume requests safely", async () => {
    const eligible = await createAutomationAndRun("needs_human");
    const product = service();
    const results = await Promise.all([
      product.resumeRun(eligible.run.id, {}),
      product.resumeRun(eligible.run.id, {})
    ]);
    expect(results.map((item) => item.resumed).sort()).toEqual([false, true]);
  });
});

describe("integration metadata and stable errors", () => {
  it("returns status metadata only and remains healthy without configured providers", async () => {
    const unavailable = service();
    await expect(unavailable.getStatus()).resolves.toEqual({
      database: "available",
      integrations: { browser: "unavailable", google: "unavailable", openai: "unavailable" },
      service: "app",
      status: "ok",
      worker: "unavailable"
    });
    await expect(service({
      readIntegrations: async () => ({
        integrations: { browser: "available", google: "available", openai: "available" },
        worker: "available"
      })
    }).getStatus()).resolves.toMatchObject({
      integrations: { browser: "available", google: "available", openai: "available" },
      worker: "available"
    });
    const api = createHttpApi(unavailable);
    expect((await api.status()).status).toBe(200);
    expect((await api.health()).status).toBe(200);

    const broken = createHttpApi({
      ...unavailable,
      getStatus: async () => { throw new Error("raw database failure"); }
    });
    expect((await broken.status()).status).toBe(500);
    const health = await broken.health();
    expect(health.status).toBe(503);
    expect(JSON.stringify(await health.json())).not.toContain("raw database failure");
  });

  it("validates worker health and never forwards credentials or malformed responses", async () => {
    const valid = vi.fn<typeof fetch>(async () => Response.json({
      integrations: { browser: "available", google: "unavailable", openai: "unavailable" },
      service: "worker",
      status: "ok"
    }));
    await expect(readWorkerHealth("http://worker/health", valid)).resolves.toMatchObject({
      worker: "available"
    });
    expect(valid).toHaveBeenCalledWith("http://worker/health", { signal: expect.any(AbortSignal) });

    for (const fetcher of [
      vi.fn<typeof fetch>(async () => new Response("no", { status: 503 })),
      vi.fn<typeof fetch>(async () => Response.json({
        credentials: "CANARY_SECRET",
        integrations: { browser: "available", google: "available", openai: "available" },
        service: "worker",
        status: "ok"
      })),
      vi.fn<typeof fetch>(async () => { throw new Error("CANARY_SECRET database stack"); })
    ]) {
      const result = await readWorkerHealth("http://worker/health", fetcher);
      expect(result).toEqual({
        integrations: { browser: "unavailable", google: "unavailable", openai: "unavailable" },
        worker: "unavailable"
      });
      expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
    }
  });

  it("normalizes application, validation, policy, and unknown errors", async () => {
    expect(publicError(new ApplicationError("integration_unavailable", 503, "Unavailable"))).toEqual({
      code: "integration_unavailable",
      message: "Unavailable",
      status: 503
    });
    expect(publicError(new Error("raw database stack"))).toEqual({
      code: "configuration_error",
      message: "The application could not complete the request",
      status: 500
    });
    const response = await respond(async () => { throw new Error("raw database stack"); });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("raw database stack");
  });
});
