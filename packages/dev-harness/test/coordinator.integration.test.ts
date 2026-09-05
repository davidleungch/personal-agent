import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DevelopmentLeaseError,
  createDatabase,
  createDevelopmentRepositories,
  migrateDatabase,
  type Database
} from "@personal-agent/db";
import { emptyDevelopmentUsage } from "@personal-agent/shared";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DevelopmentEvent,
  DevelopmentHarness,
  DevelopmentHarnessInput
} from "../src/contract";
import { DevelopmentCoordinator } from "../src/coordinator";
import { DevelopmentContextCompiler } from "../src/context-compiler";
import { TrustedGit } from "../src/git";
import type { ProcessResult } from "../src/process";
import { DockerSandboxManager, type SandboxManager, type SandboxWorkspace } from "../src/sandbox";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

let database: Database;
let closeDatabase: () => Promise<void>;
const cleanup: string[] = [];

beforeAll(async () => {
  const reset = new Pool({ connectionString: databaseUrl });
  await reset.query("drop schema public cascade");
  await reset.query("drop schema if exists drizzle cascade");
  await reset.query("create schema public");
  await reset.end();
  await migrateDatabase(databaseUrl, new URL("../../db/migrations", import.meta.url).pathname);
  const connection = createDatabase(databaseUrl);
  database = connection.database;
  closeDatabase = connection.close;
});

afterAll(async () => {
  await closeDatabase();
  await Promise.all(cleanup.map((path) => rm(path, { force: true, recursive: true })));
});

const budget = {
  maxCommandMs: 5_000,
  maxCommandOutputBytes: 20_000,
  maxContextBytes: 200_000,
  maxCostUsdMicros: 1_000_000,
  maxDiffBytes: 100_000,
  maxModelInvocations: 3,
  maxTokens: 10_000,
  maxToolCalls: 20,
  maxWallClockMs: 60_000,
  maxWorkspaceBytes: 100_000_000
};
const criteria = [
  {
    check: { arguments: ["-e", "process.exit(0)"], executable: "node" as const, timeoutMs: 1_000 },
    description: "Fixture check passes",
    id: "fixture"
  }
];

async function repositoryFixture() {
  const repository = await mkdtemp(join(tmpdir(), "personal-agent-coordinator-"));
  const workspaces = `${repository}-workspaces`;
  cleanup.push(repository, workspaces);
  await mkdir(join(repository, "docs/decisions"), { recursive: true });
  await mkdir(join(repository, "src"));
  await Promise.all([
    writeFile(join(repository, "AGENTS.md"), "bounded agents rules\n"),
    writeFile(join(repository, "docs/design.md"), "bounded design\n"),
    writeFile(join(repository, "docs/decisions/0001-pi-development-harness.md"), "bounded adr\n"),
    writeFile(join(repository, "docs/phase-2-implementation-plan.md"), "bounded plan\n"),
    writeFile(join(repository, "src/value.txt"), "base\n")
  ]);
  const manifests = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".gitignore",
    "apps/app/package.json",
    "apps/worker/package.json",
    "packages/agents/package.json",
    "packages/db/package.json",
    "packages/dev-harness/package.json",
    "packages/shared/package.json",
    "packages/tools/package.json"
  ];
  for (const manifest of manifests) {
    await mkdir(join(repository, manifest, ".."), { recursive: true });
    await copyFile(join(process.cwd(), manifest), join(repository, manifest));
  }
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "base"],
    { cwd: repository }
  );
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8"
  }).trim();
  return { base, git: new TrustedGit(repository, workspaces, ["COORDINATOR_CANARY"]), repository };
}

class FakeSandboxManager implements SandboxManager {
  checkResult: ProcessResult = {
    durationMs: 5,
    exitCode: 0,
    outputLimitExceeded: false,
    stderr: "",
    stdout: "checks pass",
    timedOut: false
  };
  createFailure = false;
  teardownFailure = false;
  created: SandboxWorkspace[] = [];
  tornDown: SandboxWorkspace[] = [];

  identify(input: { sandboxId: string; workspacePath: string }): SandboxWorkspace {
    return { containerName: `fake-${input.sandboxId}`, id: input.sandboxId, path: input.workspacePath };
  }

  async create(input: { sandboxId: string; workspacePath: string }): Promise<SandboxWorkspace> {
    if (this.createFailure) throw new Error("sandbox create failed");
    const workspace = this.identify(input);
    this.created.push(workspace);
    return workspace;
  }

  async execute(): Promise<ProcessResult> {
    return this.checkResult;
  }

  async teardown(workspace: SandboxWorkspace): Promise<void> {
    this.tornDown.push(workspace);
    if (this.teardownFailure) throw new Error("teardown failed");
  }
}

class FakeHarness implements DevelopmentHarness {
  aborts: string[] = [];
  constructor(
    private readonly behavior:
      | "complete"
      | "complete_empty"
      | "failed"
      | "no_completion"
      | "over_budget" = "complete",
    private readonly delayMs = 0
  ) {}

  async execute(input: DevelopmentHarnessInput) {
    const behavior = this.behavior;
    const delayMs = this.delayMs;
    async function* stream(): AsyncGenerator<DevelopmentEvent> {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield { kind: "execution_started", safeMetadata: { fake: true } };
      if (behavior === "failed") {
        yield { failureClass: "provider", kind: "failed", safeMetadata: {} };
        return;
      }
      if (behavior === "over_budget") {
        yield {
          delta: { ...emptyDevelopmentUsage(), modelInvocations: input.budget.maxModelInvocations + 1 },
          kind: "usage",
          safeMetadata: {}
        };
        return;
      }
      if (behavior !== "complete_empty") {
        await input.tools.invoke("sandbox.write", {
          content: "implemented\n",
          path: "src/value.txt"
        });
        yield { kind: "tool", safeMetadata: {}, status: "success", tool: "sandbox.write" };
      }
      yield { delta: { ...emptyDevelopmentUsage(), inputTokens: 10, modelInvocations: 1, outputTokens: 5 }, kind: "usage", safeMetadata: {} };
      if (behavior !== "no_completion") {
        yield { kind: "completed", result: "completion_proposed", safeMetadata: {} };
      }
    }
    return { events: stream(), executionId: `fake-execution-${input.attemptId}` };
  }

  async abort(executionId: string): Promise<void> {
    this.aborts.push(executionId);
  }
}

function coordinator(input: {
  fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  harness?: DevelopmentHarness;
  manager?: FakeSandboxManager;
  runnerId?: string;
}) {
  const persistence = createDevelopmentRepositories(database, ["COORDINATOR_CANARY"]);
  const manager = input.manager ?? new FakeSandboxManager();
  return {
    coordinator: new DevelopmentCoordinator({
      contextCompiler: new DevelopmentContextCompiler(input.fixture.git),
      git: input.fixture.git,
      harness: input.harness ?? new FakeHarness(),
      knownSecrets: ["COORDINATOR_CANARY"],
      persistence,
      runnerId: input.runnerId ?? "coordinator-runner",
      sandboxManager: manager
    }),
    manager,
    persistence
  };
}

const policy = {
  allowedPaths: ["src"],
  budget,
  forbiddenPaths: ["src/forbidden"],
  leaseDurationMs: 30_000,
  modelProfile: "balanced" as const,
  relevantPaths: ["src/value.txt"]
};

describe("Phase 2A trusted development coordinator", () => {
  it("runs the complete small-task slice through the real isolated Docker sandbox", async () => {
    const fixture = await repositoryFixture();
    const persistence = createDevelopmentRepositories(database);
    const sandboxManager = new DockerSandboxManager("node:22.19.0-bookworm-slim", async () => ({
      durationMs: 0,
      exitCode: 0,
      outputLimitExceeded: false,
      stderr: "",
      stdout: "",
      timedOut: false
    }));
    const isolated = new DevelopmentCoordinator({
      contextCompiler: new DevelopmentContextCompiler(fixture.git),
      git: fixture.git,
      harness: new FakeHarness(),
      persistence,
      runnerId: "real-sandbox-runner",
      sandboxManager
    });
    const task = await isolated.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Change the isolated fixture and run the deterministic Node check.",
      baseReference: fixture.base,
      title: "Real sandbox fixture"
    });
    const result = await isolated.runOne(policy, { taskId: task.id });
    expect(result).toMatchObject({
      attempt: { status: "succeeded" },
      task: { status: "candidate_ready" }
    });
    expect(await isolated.verifyDurableCandidate(result!.attempt.id)).toBe(true);
    const workspace = sandboxManager.identify({
      sandboxId: result!.attempt.sandboxId,
      workspacePath: fixture.git.workspacePath(result!.attempt.id)
    });
    expect(() => execFileSync("docker", ["inspect", workspace.containerName], { stdio: "ignore" })).toThrow();
  }, 120_000);

  it("runs one human-approved task to an exact durable candidate and stops", async () => {
    const fixture = await repositoryFixture();
    const harness = new FakeHarness();
    const setup = coordinator({ fixture, harness });
    const task = await setup.coordinator.createApprovedTask({
      acceptanceCriteria: [
        ...criteria,
        {
          check: {
            arguments: ["-e", "process.exit(0)"],
            executable: "node",
            timeoutMs: 1_000,
            workingDirectory: "src"
          },
          description: "Working-directory check passes",
          id: "working-directory"
        }
      ],
      approvedAt: new Date("2026-08-27T00:00:00.000Z"),
      approvedSpec: "Change src/value.txt to implemented and run the fixture check.",
      baseReference: "HEAD",
      title: "Implement fixture"
    });
    expect(task.baseCommit).toBe(fixture.base);
    const result = await setup.coordinator.runOne(policy, { taskId: task.id });
    expect(result?.task.status).toBe("candidate_ready");
    expect(result?.attempt.status).toBe("succeeded");
    expect(result?.attempt.contextDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.attempt.contextManifest?.entries.map((entry) => entry.path)).toContain(
      "src/value.txt"
    );
    expect(await setup.coordinator.verifyDurableCandidate(result!.attempt.id)).toBe(true);
    expect(
      execFileSync("git", ["show", `${result!.attempt.candidateCommit}:src/value.txt`], {
        cwd: fixture.repository,
        encoding: "utf8"
      })
    ).toBe("implemented\n");
    expect(setup.manager.tornDown).toHaveLength(1);
    expect(harness.aborts).toEqual([`fake-execution-${result!.attempt.id}`]);
    const events = await setup.persistence.listDevelopmentAttemptEvents(result!.attempt.id);
    expect(events.some((event) => event.kind === "test" && event.status === "success")).toBe(true);
    expect(events.some((event) => event.kind === "teardown" && event.status === "success")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("COORDINATOR_CANARY");
    await expect(setup.coordinator.runOne(policy, { taskId: task.id })).resolves.toBeUndefined();
    execFileSync("git", ["update-ref", "-d", result!.attempt.candidateRef!], {
      cwd: fixture.repository
    });
    expect(await setup.coordinator.verifyDurableCandidate(result!.attempt.id)).toBe(false);
    await expect(setup.persistence.getDevelopmentTask(task.id)).resolves.toMatchObject({
      status: "blocked"
    });
  });

  it("deterministically fails provider, missing-completion, empty-diff, test, budget, and sandbox errors without another attempt", async () => {
    const cases: Array<{
      configure?: (manager: FakeSandboxManager) => void;
      harness: FakeHarness;
      label: string;
    }> = [
      { harness: new FakeHarness("failed"), label: "provider" },
      { harness: new FakeHarness("no_completion"), label: "no-completion" },
      { harness: new FakeHarness("complete_empty"), label: "empty-diff" },
      {
        configure: (manager) => {
          manager.checkResult = { ...manager.checkResult, exitCode: 1, stderr: "test failed" };
        },
        harness: new FakeHarness(),
        label: "test"
      },
      {
        configure: (manager) => {
          manager.checkResult = { ...manager.checkResult, stdout: "COORDINATOR_CANARY" };
        },
        harness: new FakeHarness(),
        label: "secret-output"
      },
      {
        configure: (manager) => {
          manager.checkResult = { ...manager.checkResult, timedOut: true };
        },
        harness: new FakeHarness(),
        label: "test-timeout"
      },
      {
        configure: (manager) => {
          manager.checkResult = { ...manager.checkResult, outputLimitExceeded: true };
        },
        harness: new FakeHarness(),
        label: "test-output-limit"
      },
      { harness: new FakeHarness("over_budget"), label: "budget" },
      {
        configure: (manager) => {
          manager.createFailure = true;
        },
        harness: new FakeHarness(),
        label: "sandbox"
      }
    ];
    for (const test of cases) {
      const fixture = await repositoryFixture();
      const manager = new FakeSandboxManager();
      test.configure?.(manager);
      const setup = coordinator({ fixture, harness: test.harness, manager, runnerId: `runner-${test.label}` });
      const task = await setup.coordinator.createApprovedTask({
        acceptanceCriteria: criteria,
        approvedSpec: `Failure case ${test.label}`,
        baseReference: fixture.base,
        title: `Failure ${test.label}`
      });
      await expect(setup.coordinator.runOne(policy, { taskId: task.id })).rejects.toBeDefined();
      await expect(setup.persistence.getDevelopmentTask(task.id)).resolves.toMatchObject({ status: "failed" });
      const attempts = await database.query.developmentAttempts.findMany({
        where: (attempts, { eq }) => eq(attempts.taskId, task.id)
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("failed");
    }
  });

  it("classifies validation, heartbeat, candidate-integrity, transition, and teardown failures deterministically", async () => {
    const validationFixture = await repositoryFixture();
    const validation = coordinator({ fixture: validationFixture, runnerId: "validation-runner" });
    const validationTask = await validation.coordinator.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Invalid context selection",
      baseReference: validationFixture.base,
      title: "Validation"
    });
    await expect(
      validation.coordinator.runOne(
        { ...policy, relevantPaths: ["../escape"] },
        { taskId: validationTask.id }
      )
    ).rejects.toBeDefined();

    const heartbeatFixture = await repositoryFixture();
    const heartbeatPersistence = createDevelopmentRepositories(database);
    const heartbeatManager = new FakeSandboxManager();
    const heartbeatCoordinator = new DevelopmentCoordinator({
      contextCompiler: new DevelopmentContextCompiler(heartbeatFixture.git),
      git: heartbeatFixture.git,
      harness: new FakeHarness("complete", 300),
      persistence: heartbeatPersistence,
      runnerId: "heartbeat-runner",
      sandboxManager: heartbeatManager
    });
    const heartbeatTask = await heartbeatCoordinator.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Heartbeat success",
      baseReference: heartbeatFixture.base,
      title: "Heartbeat"
    });
    await expect(
      heartbeatCoordinator.runOne(
        { ...policy, leaseDurationMs: 900 },
        { taskId: heartbeatTask.id }
      )
    ).resolves.toMatchObject({ task: { status: "candidate_ready" } });

    const expiredFixture = await repositoryFixture();
    const expired = coordinator({
      fixture: expiredFixture,
      harness: new FakeHarness("complete", 400),
      runnerId: "expired-heartbeat-runner"
    });
    const expiredTask = await expired.coordinator.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Heartbeat expires",
      baseReference: expiredFixture.base,
      title: "Expired heartbeat"
    });
    await expect(
      expired.coordinator.runOne(
        { ...policy, leaseDurationMs: 100 },
        { taskId: expiredTask.id }
      )
    ).rejects.toBeInstanceOf(DevelopmentLeaseError);
    await expect(expired.coordinator.recoverOne(30_000)).resolves.toMatchObject({
      candidate: undefined
    });

    const integrityFixture = await repositoryFixture();
    const integrity = coordinator({ fixture: integrityFixture, runnerId: "integrity-runner" });
    const integrityTask = await integrity.coordinator.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Candidate integrity",
      baseReference: integrityFixture.base,
      title: "Integrity"
    });
    vi.spyOn(integrityFixture.git, "verifyCandidateRef").mockResolvedValueOnce(undefined);
    await expect(
      integrity.coordinator.runOne(policy, { taskId: integrityTask.id })
    ).resolves.toMatchObject({ task: { status: "candidate_ready" } });

    const transitionFixture = await repositoryFixture();
    const transition = coordinator({ fixture: transitionFixture, runnerId: "transition-runner" });
    const transitionTask = await transition.coordinator.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Transition integrity",
      baseReference: transitionFixture.base,
      title: "Transition integrity"
    });
    const originalTransition = transition.persistence.transitionDevelopmentAttempt;
    vi.spyOn(transition.persistence, "transitionDevelopmentAttempt").mockImplementation(async (input) => {
      if (input.attemptStatus === "failed") throw new Error("terminal persistence failed");
      return originalTransition(input);
    });
    await expect(
      transition.coordinator.runOne(
        { ...policy, relevantPaths: ["../escape"] },
        { taskId: transitionTask.id }
      )
    ).rejects.toThrow("terminal persistence failed");

    const fencedTransitionFixture = await repositoryFixture();
    const fencedTransition = coordinator({
      fixture: fencedTransitionFixture,
      runnerId: "fenced-transition-runner"
    });
    const fencedTransitionTask = await fencedTransition.coordinator.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Fenced terminal transition",
      baseReference: fencedTransitionFixture.base,
      title: "Fenced transition"
    });
    const originalFencedTransition = fencedTransition.persistence.transitionDevelopmentAttempt;
    vi.spyOn(fencedTransition.persistence, "transitionDevelopmentAttempt").mockImplementation(
      async (input) => {
        if (input.attemptStatus === "failed") throw new DevelopmentLeaseError("stale terminal write");
        return originalFencedTransition(input);
      }
    );
    await expect(
      fencedTransition.coordinator.runOne(
        { ...policy, relevantPaths: ["../escape"] },
        { taskId: fencedTransitionTask.id }
      )
    ).rejects.not.toBeInstanceOf(DevelopmentLeaseError);

    const teardownFixture = await repositoryFixture();
    const teardownManager = new FakeSandboxManager();
    teardownManager.teardownFailure = true;
    const teardown = coordinator({
      fixture: teardownFixture,
      manager: teardownManager,
      runnerId: "teardown-runner"
    });
    const teardownTask = await teardown.coordinator.createApprovedTask({
      acceptanceCriteria: criteria,
      approvedSpec: "Teardown recording",
      baseReference: teardownFixture.base,
      title: "Teardown"
    });
    const teardownResult = await teardown.coordinator.runOne(policy, {
      taskId: teardownTask.id
    });
    const teardownEvents = await teardown.persistence.listDevelopmentAttemptEvents(
      teardownResult!.attempt.id
    );
    expect(teardownEvents.at(-1)).toMatchObject({ kind: "teardown", status: "failed" });
    execFileSync(
      "git",
      ["update-ref", teardownResult!.attempt.candidateRef!, teardownFixture.base],
      { cwd: teardownFixture.repository }
    );
    expect(await teardown.coordinator.verifyDurableCandidate(teardownResult!.attempt.id)).toBe(false);
    await expect(
      teardown.persistence.getDevelopmentTask(teardownResult!.task.id)
    ).resolves.toMatchObject({ status: "blocked" });
  });

  it("handles fenced and non-fenced teardown event persistence errors", async () => {
    for (const leaseError of [false, true]) {
      const fixture = await repositoryFixture();
      const setup = coordinator({ fixture, runnerId: `teardown-event-${String(leaseError)}` });
      const task = await setup.coordinator.createApprovedTask({
        acceptanceCriteria: criteria,
        approvedSpec: "Teardown event error",
        baseReference: fixture.base,
        title: "Teardown event"
      });
      const originalAppend = setup.persistence.appendDevelopmentAttemptEvent;
      vi.spyOn(setup.persistence, "appendDevelopmentAttemptEvent").mockImplementation(async (input) => {
        if (input.kind === "teardown") {
          if (leaseError) throw new DevelopmentLeaseError("stale teardown");
          throw new Error("teardown audit failed");
        }
        return originalAppend(input);
      });
      if (leaseError) {
        await expect(
          setup.coordinator.runOne(policy, { taskId: task.id })
        ).resolves.toMatchObject({
          task: { status: "candidate_ready" }
        });
      } else {
        await expect(
          setup.coordinator.runOne(policy, { taskId: task.id })
        ).rejects.toThrow("teardown audit failed");
      }
    }
  });

  it("reclaims an expired generation, rejects session authority, and reconciles a trusted candidate ref", async () => {
    const fixture = await repositoryFixture();
    const setup = coordinator({ fixture, runnerId: "recovery-runner" });
    const task = await setup.persistence.createApprovedDevelopmentTask({
      acceptanceCriteria: criteria,
      approvedAt: new Date("2026-08-27T01:00:00.000Z"),
      approvedSpec: "Recover candidate",
      baseCommit: fixture.base,
      title: "Recovery"
    });
    const claim = (await setup.persistence.claimReadyDevelopmentTask({
      budget,
      leaseDurationMs: 1,
      modelProfile: "fast",
      now: new Date("2026-08-27T01:00:00.000Z"),
      runnerId: "lost-session-runner"
    }))!;
    const workspacePath = await fixture.git.createWorktree(claim.attempt.id, fixture.base);
    await writeFile(join(workspacePath, "src/value.txt"), "recovered candidate\n");
    const candidate = await fixture.git.captureCandidate({
      allowedPaths: ["src"],
      attemptId: claim.attempt.id,
      baseCommit: fixture.base,
      forbiddenPaths: [],
      maxDiffBytes: budget.maxDiffBytes,
      workspacePath
    });
    expect(candidate.commit).toMatch(/^[0-9a-f]{40}$/);
    const recovered = await setup.coordinator.recoverOne(30_000);
    expect(recovered?.task.status).toBe("candidate_ready");
    await expect(setup.persistence.getDevelopmentTask(task.id)).resolves.toMatchObject({
      status: "candidate_ready"
    });
    expect(await setup.coordinator.verifyDurableCandidate(claim.attempt.id)).toBe(true);
    await expect(setup.coordinator.recoverOne(30_000)).resolves.toBeUndefined();
  });

  it("blocks sandbox loss before capture and reports absent or inconsistent durable candidates", async () => {
    const fixture = await repositoryFixture();
    const setup = coordinator({ fixture, runnerId: "loss-runner" });
    expect(await setup.coordinator.verifyDurableCandidate("00000000-0000-4000-8000-000000000777")).toBe(
      false
    );
    const task = await setup.persistence.createApprovedDevelopmentTask({
      acceptanceCriteria: criteria,
      approvedAt: new Date("2000-01-01T00:00:00.000Z"),
      approvedSpec: "Lost sandbox",
      baseCommit: fixture.base,
      title: "Lost sandbox"
    });
    const claim = (await setup.persistence.claimReadyDevelopmentTask({
      budget,
      leaseDurationMs: 1,
      modelProfile: "fast",
      now: new Date("2000-01-01T00:00:00.000Z"),
      runnerId: "lost-runner"
    }))!;
    const recovered = await setup.coordinator.recoverOne(30_000);
    expect(recovered?.candidate).toBeUndefined();
    expect((await setup.persistence.getDevelopmentTask(task.id))?.status).toBe("blocked");
    expect(await setup.coordinator.verifyDurableCandidate(claim.attempt.id)).toBe(false);
  });
});
