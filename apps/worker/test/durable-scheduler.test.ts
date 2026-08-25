import { once } from "node:events";
import {
  automationRuns,
  automations,
  createDatabase,
  createRepositories,
  migrateDatabase,
  runEvents,
  idempotencyRecords,
  type Database
} from "@personal-agent/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDurablePolling,
  createRunState,
  InvalidRunTransitionError,
  RunLeaseError,
  scheduleDueAutomations,
  SCHEDULER_POLL_INTERVAL_MS,
  startWorker
} from "../src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for PostgreSQL scheduler integration tests");
}

if (!new URL(databaseUrl).pathname.slice(1).endsWith("_test")) {
  throw new Error("PostgreSQL integration tests require a database name ending in _test");
}

let database: Database;
let pool: ReturnType<typeof createDatabase>["pool"];
let closeDatabase: () => Promise<void>;

beforeAll(async () => {
  const resetConnection = createDatabase(databaseUrl);
  await resetConnection.pool.query("drop schema public cascade");
  await resetConnection.pool.query("drop schema if exists drizzle cascade");
  await resetConnection.pool.query("create schema public");
  await resetConnection.close();
  await migrateDatabase(databaseUrl, new URL("../../../packages/db/migrations", import.meta.url).pathname);

  const connection = createDatabase(databaseUrl);
  database = connection.database;
  pool = connection.pool;
  closeDatabase = connection.close;
});

beforeEach(async () => {
  await pool.query("truncate table automations cascade");
});

afterAll(async () => {
  await closeDatabase();
});

async function createAutomation(input: {
  name?: string;
  nextRunAt: Date;
  schedule: string;
  timezone?: string;
}) {
  return createRepositories(database).createAutomation({
    completionMode: "continue",
    goal: "Exercise durable scheduling",
    modelProfile: "balanced",
    name: input.name ?? "Scheduler fixture",
    nextRunAt: input.nextRunAt,
    schedule: input.schedule,
    timezone: input.timezone ?? "UTC",
    toolPolicy: "none"
  });
}

async function createRun(input: {
  automationId: string;
  availableAt?: Date;
  checkpoint?: Record<string, never>;
  status?: "queued" | "running" | "verifying" | "retry_wait" | "needs_human" | "succeeded";
}) {
  return createRepositories(database).createAutomationRun({
    automationId: input.automationId,
    availableAt: input.availableAt ?? new Date("2026-08-25T00:00:00.000Z"),
    checkpoint: input.checkpoint ?? {},
    modelProfile: "balanced",
    status: input.status ?? "queued",
    trigger: "manual",
    workflowPhase: "fixture"
  });
}

async function runsFor(automationId: string) {
  return database
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(asc(automationRuns.createdAt));
}

describe("durable due scheduling", () => {
  it("does nothing when there is no missed occurrence", async () => {
    await createAutomation({
      nextRunAt: new Date("2026-08-26T00:00:00.000Z"),
      schedule: "0 0 * * *"
    });

    await expect(
      scheduleDueAutomations(database, new Date("2026-08-25T12:00:00.000Z"))
    ).resolves.toEqual([]);
  });

  it("creates exactly one run for exactly one missed occurrence", async () => {
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-25T09:00:00.000Z"),
      schedule: "0 9 * * *"
    });
    const [decision] = await scheduleDueAutomations(
      database,
      new Date("2026-08-25T10:00:00.000Z")
    );

    expect(decision).toMatchObject({ outcome: "created", scheduledFor: new Date("2026-08-25T09:00:00.000Z") });
    expect(await runsFor(automation.id)).toHaveLength(1);
  });

  it("creates only the most recent eligible occurrence after multiple misses", async () => {
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-25T07:00:00.000Z"),
      schedule: "0 * * * *"
    });
    const [decision] = await scheduleDueAutomations(
      database,
      new Date("2026-08-25T10:30:00.000Z")
    );
    const runs = await runsFor(automation.id);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.scheduledFor).toEqual(new Date("2026-08-25T10:00:00.000Z"));
    expect(decision?.nextRunAt).toEqual(new Date("2026-08-25T11:00:00.000Z"));
  });

  it("includes an occurrence exactly at the 24-hour catch-up boundary", async () => {
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-01T09:00:00.000Z"),
      schedule: "0 9 1 * *"
    });
    const [decision] = await scheduleDueAutomations(
      database,
      new Date("2026-08-02T09:00:00.000Z")
    );

    expect(decision?.outcome).toBe("created");
    expect((await runsFor(automation.id))[0]?.scheduledFor).toEqual(
      new Date("2026-08-01T09:00:00.000Z")
    );
  });

  it("records but does not queue an occurrence just older than 24 hours", async () => {
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-01T09:00:00.000Z"),
      schedule: "0 9 1 * *"
    });
    const [decision] = await scheduleDueAutomations(
      database,
      new Date("2026-08-02T09:00:00.001Z")
    );
    const [run] = await runsFor(automation.id);

    expect(decision?.outcome).toBe("skipped");
    expect(run).toMatchObject({ status: "succeeded", workflowPhase: "schedule_skipped" });
    expect(run?.completedAt).toEqual(new Date("2026-08-02T09:00:00.001Z"));
  });

  it("deduplicates a duplicate scheduler wake-up and still advances the schedule", async () => {
    const now = new Date("2026-08-25T10:00:00.000Z");
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-25T09:00:00.000Z"),
      schedule: "0 9 * * *"
    });
    await scheduleDueAutomations(database, now);
    await database
      .update(automationRuns)
      .set({ status: "succeeded" })
      .where(eq(automationRuns.automationId, automation.id));
    await database
      .update(automations)
      .set({ nextRunAt: new Date("2026-08-25T09:00:00.000Z") })
      .where(eq(automations.id, automation.id));

    const [decision] = await scheduleDueAutomations(database, now);

    expect(decision?.outcome).toBe("deduplicated");
    expect(await runsFor(automation.id)).toHaveLength(1);
  });

  it("uses row locks across concurrent scheduler workers", async () => {
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-25T09:00:00.000Z"),
      schedule: "0 9 * * *"
    });
    const now = new Date("2026-08-25T10:00:00.000Z");
    const decisions = await Promise.all([
      scheduleDueAutomations(database, now),
      scheduleDueAutomations(database, now)
    ]);

    expect(decisions.flat().filter((decision) => decision.outcome === "created")).toHaveLength(1);
    expect(await runsFor(automation.id)).toHaveLength(1);
  });

  it("leaves a due automation unchanged while an active run prevents overlap", async () => {
    const due = new Date("2026-08-25T09:00:00.000Z");
    const automation = await createAutomation({ nextRunAt: due, schedule: "0 9 * * *" });
    await createRun({ automationId: automation.id });

    const [decision] = await scheduleDueAutomations(
      database,
      new Date("2026-08-25T10:00:00.000Z")
    );
    const [stored] = await database.select().from(automations).where(eq(automations.id, automation.id));

    expect(decision).toMatchObject({ nextRunAt: due, outcome: "overlap" });
    expect(stored?.nextRunAt).toEqual(due);
  });

  it("validates the scheduler batch limit", async () => {
    await expect(scheduleDueAutomations(database, new Date(), 0)).rejects.toThrow(
      "Scheduler batch limit must be a positive integer"
    );
  });
});

describe("durable claims, leases, checkpoints, and recovery", () => {
  const now = new Date("2026-08-25T10:00:00.000Z");

  async function fixture(status: "queued" | "retry_wait" | "needs_human" = "queued", availableAt = now) {
    const automation = await createAutomation({
      name: `Run ${status}`,
      nextRunAt: new Date("2026-08-26T00:00:00.000Z"),
      schedule: "0 0 * * *"
    });
    const run = await createRun({ automationId: automation.id, availableAt, status });
    return { automation, run };
  }

  it("acquires one durable lease under concurrent worker claims", async () => {
    const { run } = await fixture();
    const state = createRunState(database);
    const claims = await Promise.all([
      state.claimRun("worker-a", now, 60_000),
      state.claimRun("worker-b", now, 60_000)
    ]);
    const claimed = claims.filter((claim) => claim !== undefined);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ attempt: 1, id: run.id, status: "running" });
    expect(claimed[0]?.leaseExpiresAt).toEqual(new Date("2026-08-25T10:01:00.000Z"));
  });

  it("renews only a current lease", async () => {
    const { run } = await fixture();
    const state = createRunState(database);
    await state.claimRun("worker", now, 60_000);

    await expect(
      state.renewLease(run.id, "worker", new Date("2026-08-25T10:00:30.000Z"), 60_000)
    ).resolves.toMatchObject({ leaseExpiresAt: new Date("2026-08-25T10:01:30.000Z") });
    await expect(
      state.renewLease(run.id, "other", new Date("2026-08-25T10:00:40.000Z"), 60_000)
    ).resolves.toBeUndefined();
  });

  it("expires a lease without losing running state", async () => {
    const { run } = await fixture();
    const state = createRunState(database);
    await state.claimRun("crashed-worker", now, 60_000);
    const recovered = await state.recoverExpiredLeases(new Date("2026-08-25T10:01:00.000Z"));

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ claimedBy: null, id: run.id, status: "running" });
  });

  it("recovers after a simulated worker crash from the durable checkpoint", async () => {
    const { run } = await fixture();
    const firstWorker = createRunState(database);
    await firstWorker.claimRun("worker-before-crash", now, 60_000);
    await firstWorker.saveCheckpoint({
      checkpoint: { cursor: "durable-step-2" },
      now: new Date("2026-08-25T10:00:10.000Z"),
      runId: run.id,
      workerId: "worker-before-crash",
      workflowPhase: "step_2"
    });
    await firstWorker.recoverExpiredLeases(new Date("2026-08-25T10:01:00.000Z"));

    const afterRestart = createRunState(database);
    const claimed = await afterRestart.claimRun(
      "worker-after-restart",
      new Date("2026-08-25T10:01:01.000Z"),
      60_000
    );
    expect(claimed).toMatchObject({
      attempt: 2,
      checkpoint: { cursor: "durable-step-2" },
      status: "running",
      workflowPhase: "step_2"
    });
  });

  it("makes retry_wait claimable only at available_at", async () => {
    const availableAt = new Date("2026-08-25T10:05:00.000Z");
    const { run } = await fixture("retry_wait", availableAt);
    const state = createRunState(database);

    await expect(state.claimRun("worker", now, 60_000)).resolves.toBeUndefined();
    await expect(state.claimRun("worker", availableAt, 60_000)).resolves.toMatchObject({
      id: run.id,
      status: "running"
    });
    const events = await database
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.createdAt));
    expect(events.map((event) => [event.fromStatus, event.toStatus])).toEqual([
      ["retry_wait", "queued"],
      ["queued", "running"]
    ]);
  });

  it("rejects an explicit retry transition before available_at", async () => {
    const availableAt = new Date("2026-08-25T10:05:00.000Z");
    const { run } = await fixture("retry_wait", availableAt);

    await expect(
      createRunState(database).transitionRun({ now, runId: run.id, toStatus: "queued" })
    ).rejects.toThrow("retry_wait is not available yet");
  });

  it("never executes needs_human automatically", async () => {
    await fixture("needs_human");
    await expect(createRunState(database).claimRun("worker", now, 60_000)).resolves.toBeUndefined();
  });

  it("recovers unresolved consequential work into verification, never retry", async () => {
    const { run } = await fixture();
    const state = createRunState(database);
    await state.claimRun("worker", now, 60_000);
    await state.saveCheckpoint({
      checkpoint: {
        pendingConsequentialOperation: { idempotencyKey: "stable-key", outcome: "pending", tool: "browser.submit" }
      },
      now: new Date("2026-08-25T10:00:10.000Z"),
      runId: run.id,
      workerId: "worker",
      workflowPhase: "submitted"
    });
    await createRepositories(database).createIdempotencyRecord({ key: "stable-key", runId: run.id, scope: "browser.submit", state: "reserved" });
    const [recovered] = await state.recoverExpiredLeases(
      new Date("2026-08-25T10:01:00.000Z")
    );

    expect(recovered).toMatchObject({
      checkpoint: {
        pendingConsequentialOperation: { idempotencyKey: "stable-key", outcome: "unknown", tool: "browser.submit" }
      },
      status: "verifying"
    });
    await expect(database.select().from(idempotencyRecords)).resolves.toMatchObject([{ state: "unknown" }]);
    await expect(
      createRunState(database).claimRun(
        "verifier",
        new Date("2026-08-25T10:01:01.000Z"),
        60_000
      )
    ).resolves.toMatchObject({ status: "verifying" });
  });

  it("recovers malformed legacy consequential checkpoints without inventing idempotency state", async () => {
    const { run } = await fixture();
    const state = createRunState(database);
    await state.claimRun("legacy-worker", now, 60_000);
    await state.saveCheckpoint({ checkpoint: { pendingConsequentialOperation: { idempotencyKey: "key", outcome: "pending", tool: 1 } }, now, runId: run.id, workerId: "legacy-worker", workflowPhase: "legacy" });
    await expect(state.recoverExpiredLeases(new Date("2026-08-25T10:01:00.000Z"))).resolves.toMatchObject([{ status: "verifying" }]);
  });

  it("rejects checkpoint writes without the live owning lease", async () => {
    const { run } = await fixture();
    await expect(
      createRunState(database).saveCheckpoint({
        checkpoint: { safe: true },
        now,
        runId: run.id,
        workerId: "not-owner",
        workflowPhase: "step"
      })
    ).rejects.toBeInstanceOf(RunLeaseError);
  });

  it("validates lease and recovery limits", async () => {
    const state = createRunState(database);
    await expect(state.claimRun("worker", now, 0)).rejects.toThrow(
      "Lease duration must be a positive integer"
    );
    await expect(state.recoverExpiredLeases(now, 0)).rejects.toThrow(
      "Recovery batch limit must be a positive integer"
    );
  });
});

describe("lifecycle state machine", () => {
  const now = new Date("2026-08-25T10:00:00.000Z");

  async function runningRun() {
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-26T00:00:00.000Z"),
      schedule: "0 0 * * *"
    });
    const run = await createRun({ automationId: automation.id });
    const state = createRunState(database);
    await state.claimRun("worker", now, 60_000);
    return { run, state };
  }

  it.each(["succeeded", "failed", "blocked", "cancelled"] as const)(
    "allows running -> %s and records completion",
    async (toStatus) => {
      const { run, state } = await runningRun();
      const updated = await state.transitionRun({
        checkpoint: { final: true },
        errorSummary: "safe error summary",
        now,
        payload: { reason: "fixture" },
        resultSummary: "safe result",
        runId: run.id,
        toStatus,
        workerId: "worker",
        workflowPhase: "complete"
      });
      expect(updated).toMatchObject({
        checkpoint: { final: true },
        claimedBy: null,
        completedAt: now,
        errorSummary: "safe error summary",
        status: toStatus
      });
    }
  );

  it("allows the verifying and retry branches", async () => {
    const { run, state } = await runningRun();
    await state.transitionRun({ now, runId: run.id, toStatus: "verifying", workerId: "worker" });
    const waiting = await state.transitionRun({
      availableAt: now,
      now,
      runId: run.id,
      toStatus: "retry_wait",
      workerId: "worker"
    });
    expect(waiting.status).toBe("retry_wait");
    await expect(state.transitionRun({ now, runId: run.id, toStatus: "queued" })).resolves.toMatchObject({
      status: "queued"
    });
  });

  it("allows human pause and explicit resume", async () => {
    const { run, state } = await runningRun();
    await state.transitionRun({ now, runId: run.id, toStatus: "needs_human", workerId: "worker" });
    await expect(state.transitionRun({ now, runId: run.id, toStatus: "queued" })).resolves.toMatchObject({
      status: "queued"
    });
  });

  it("allows verification to succeed or block", async () => {
    for (const toStatus of ["succeeded", "blocked"] as const) {
      const { run, state } = await runningRun();
      await state.transitionRun({ now, runId: run.id, toStatus: "verifying", workerId: "worker" });
      await expect(
        state.transitionRun({ now, runId: run.id, toStatus, workerId: "worker" })
      ).resolves.toMatchObject({ status: toStatus });
    }
  });

  it("rejects invalid, premature, missing, and stale transitions deterministically", async () => {
    const automation = await createAutomation({
      nextRunAt: new Date("2026-08-26T00:00:00.000Z"),
      schedule: "0 0 * * *"
    });
    const queued = await createRun({ automationId: automation.id });
    const state = createRunState(database);
    await expect(
      state.transitionRun({ now, runId: queued.id, toStatus: "succeeded" })
    ).rejects.toBeInstanceOf(InvalidRunTransitionError);
    await expect(
      state.transitionRun({ now, runId: "00000000-0000-4000-8000-000000000000", toStatus: "running" })
    ).rejects.toThrow("Automation run not found");

    await state.claimRun("owner", now, 60_000);
    await expect(
      state.transitionRun({ now, runId: queued.id, toStatus: "succeeded", workerId: "other" })
    ).rejects.toBeInstanceOf(RunLeaseError);
    await expect(
      state.transitionRun({
        now: new Date("2026-08-25T10:01:00.000Z"),
        runId: queued.id,
        toStatus: "succeeded",
        workerId: "owner"
      })
    ).rejects.toThrow("Automation run lease has expired");
  });

  it("requires retry availability and safe summaries", async () => {
    const { run, state } = await runningRun();
    await expect(
      state.transitionRun({ now, runId: run.id, toStatus: "retry_wait", workerId: "worker" })
    ).rejects.toThrow("retry_wait requires availableAt");
    await expect(
      state.transitionRun({
        now,
        resultSummary: "sk-abcdefghijklmnop",
        runId: run.id,
        toStatus: "succeeded",
        workerId: "worker"
      })
    ).rejects.toThrow("Secret material is not allowed");
  });
});

describe("worker polling", () => {
  it("uses a 15-second default and avoids overlapping local wake-ups", async () => {
    expect(SCHEDULER_POLL_INTERVAL_MS).toBe(15_000);
    const clock = vi.fn(() => new Date("2026-08-25T10:00:00.000Z"));
    const polling = createDurablePolling(database, { clock, pollIntervalMs: 15_000 });
    polling.start();
    polling.start();
    await polling.tick();
    polling.stop();
    polling.stop();
    expect(clock).toHaveBeenCalled();
  });

  it("validates polling intervals", () => {
    expect(() => createDurablePolling(database, { pollIntervalMs: 0 })).toThrow(
      "Poll interval must be a positive integer"
    );
  });

  it("contains a failed wake-up and remains stoppable", async () => {
    const brokenDatabase = {
      transaction: () => Promise.reject(new Error("database unavailable"))
    } as unknown as Database;
    const polling = createDurablePolling(brokenDatabase);

    polling.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    polling.stop();
  });

  it("starts against PostgreSQL and reports configured integration availability", async () => {
    const worker = await startWorker(0, {
      DATABASE_URL: databaseUrl,
      GOOGLE_CLIENT_ID_FILE: "/id",
      GOOGLE_CLIENT_SECRET_FILE: "/secret",
      GOOGLE_REFRESH_TOKEN_FILE: "/refresh",
      OPENAI_API_KEY_FILE: "/openai"
    });
    await once(worker.server, "listening");
    const address = worker.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Worker did not bind a TCP port");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    await expect(response.json()).resolves.toMatchObject({
      integrations: { google: "available", openai: "available" }
    });
    await worker.stop();
  });
});
