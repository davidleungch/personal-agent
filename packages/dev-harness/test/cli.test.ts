import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  coordinatorDependencies: [] as unknown[],
  createApprovedTask: vi.fn(async (input) => ({ created: input })),
  databaseSecrets: [] as unknown[],
  gitArguments: [] as unknown[],
  harnessTransports: [] as unknown[],
  piArguments: [] as unknown[],
  recoverOne: vi.fn(async () => ({ recovered: true })),
  runOne: vi.fn(async (input) => ({ ran: input })),
  sandboxArguments: [] as unknown[]
}));

vi.mock("@personal-agent/db", () => ({
  createDatabase: () => ({ close: state.close, database: {} }),
  createDevelopmentRepositories: (_database: unknown, secrets: unknown) => {
    state.databaseSecrets.push(secrets);
    return {};
  }
}));
vi.mock("../src/coordinator.js", () => ({
  DevelopmentCoordinator: class {
    constructor(dependencies: unknown) {
      state.coordinatorDependencies.push(dependencies);
    }
    createApprovedTask = state.createApprovedTask;
    recoverOne = state.recoverOne;
    runOne = state.runOne;
  }
}));
vi.mock("../src/context-compiler.js", () => ({
  DevelopmentContextCompiler: class {}
}));
vi.mock("../src/git.js", () => ({
  TrustedGit: class {
    constructor(...arguments_: unknown[]) {
      state.gitArguments.push(arguments_);
    }
  }
}));
vi.mock("../src/pi-adapter.js", () => ({
  OfficialPiTransport: class {
    constructor(input: unknown) {
      state.piArguments.push(input);
    }
  },
  PiDevelopmentHarness: class {
    constructor(transport: unknown) {
      state.harnessTransports.push(transport);
    }
  }
}));
vi.mock("../src/sandbox.js", () => ({
  DockerSandboxManager: class {
    constructor(...arguments_: unknown[]) {
      state.sandboxArguments.push(arguments_);
    }
  }
}));

const temporary: string[] = [];
const databaseUrl = "postgresql://runner:database-password@localhost/development_test";

beforeEach(() => {
  for (const value of Object.values(state)) {
    if (typeof value === "function" && "mockClear" in value) value.mockClear();
    else if (Array.isArray(value)) value.splice(0);
  }
  state.createApprovedTask.mockResolvedValue({ created: true });
  state.recoverOne.mockResolvedValue({ recovered: true });
  state.runOne.mockResolvedValue({ ran: true });
});

afterAll(async () => {
  await Promise.all(temporary.map((path) => rm(path, { force: true, recursive: true })));
});

async function loadCli() {
  return import("../src/cli");
}

describe("host-level development runner CLI", () => {
  it("creates an explicitly approved task from bounded human files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personal-agent-cli-"));
    temporary.push(directory);
    const spec = join(directory, "spec.md");
    const criteria = join(directory, "criteria.json");
    await writeFile(spec, "approved specification");
    await writeFile(
      criteria,
      JSON.stringify([
        {
          check: { executable: "node", timeoutMs: 1000 },
          description: "check",
          id: "check"
        }
      ])
    );
    const { runDevelopmentCli } = await loadCli();
    await expect(
      runDevelopmentCli(
        [
          "task-create",
          "--title",
          "Approved task",
          "--spec-file",
          spec,
          "--criteria-file",
          criteria,
          "--base",
          "main"
        ],
        { DATABASE_URL: databaseUrl, DEVELOPMENT_REPOSITORY_PATH: directory }
      )
    ).resolves.toEqual({ created: true });
    expect(state.createApprovedTask).toHaveBeenCalledWith({
      acceptanceCriteria: expect.any(Array),
      approvedSpec: "approved specification",
      baseReference: "main",
      title: "Approved task"
    });
    expect(state.close).toHaveBeenCalled();
    expect(state.sandboxArguments).toContainEqual(["unused"]);
    await expect((state.harnessTransports[0] as { run: () => Promise<unknown> }).run()).rejects.toThrow(
      "unavailable during task creation"
    );
    await runDevelopmentCli(
      [
        "task-create",
        "--title",
        "Default base",
        "--spec-file",
        spec,
        "--criteria-file",
        criteria
      ],
      { DATABASE_URL: databaseUrl }
    );
    expect(state.createApprovedTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseReference: "HEAD" })
    );
  });

  it("runs and recovers once with explicit and default bounded policy", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "personal-agent-cli-agent-"));
    temporary.push(agentDirectory);
    await writeFile(
      join(agentDirectory, "auth.json"),
      JSON.stringify({ nested: { token: "RUNNER_AUTH_CANARY" }, array: ["short", 7, null] })
    );
    const { runDevelopmentCli } = await loadCli();
    const environment = {
      DATABASE_URL: databaseUrl,
      DEVELOPMENT_MODEL_BALANCED: "balanced-runtime",
      DEVELOPMENT_MODEL_BALANCED_PROVIDER: "balanced-provider",
      DEVELOPMENT_MODEL_FAST: "fast-runtime",
      DEVELOPMENT_MODEL_FAST_PROVIDER: "fast-provider",
      DEVELOPMENT_MODEL_REASONING: "reasoning-runtime",
      DEVELOPMENT_MODEL_REASONING_PROVIDER: "reasoning-provider",
      DEVELOPMENT_PI_AGENT_DIR: agentDirectory,
      DEVELOPMENT_RUNNER_ID: "runner-explicit",
      DEVELOPMENT_SANDBOX_IMAGE: "sandbox:test",
      DEVELOPMENT_WORKSPACE_ROOT: join(agentDirectory, "workspaces")
    };
    await expect(
      runDevelopmentCli(
        [
          "run-once",
          "--allowed",
          "src,,packages",
          "--forbidden",
          ".git,.pi",
          "--lease-ms",
          "1234",
          "--profile",
          "reasoning",
          "--relevant",
          "src/a.ts"
        ],
        environment
      )
    ).resolves.toEqual({ ran: true });
    expect(state.runOne).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedPaths: ["src", "packages"],
        forbiddenPaths: [".git", ".pi"],
        leaseDurationMs: 1234,
        modelProfile: "reasoning",
        relevantPaths: ["src/a.ts"]
      })
    );
    expect(state.piArguments.at(-1)).toEqual({
      agentDirectory: resolve(agentDirectory),
      models: {
        balanced: { modelId: "balanced-runtime", providerId: "balanced-provider" },
        fast: { modelId: "fast-runtime", providerId: "fast-provider" },
        reasoning: { modelId: "reasoning-runtime", providerId: "reasoning-provider" }
      }
    });
    expect(state.databaseSecrets.at(-1)).toEqual(
      expect.arrayContaining([databaseUrl, "database-password", "RUNNER_AUTH_CANARY"])
    );
    expect(state.sandboxArguments.at(-1)).toEqual(["sandbox:test"]);

    await expect(
      runDevelopmentCli(["recover-one"], {
        DATABASE_URL: databaseUrl,
        DEVELOPMENT_PI_AGENT_DIR: agentDirectory,
        MODEL_BALANCED: "fallback-balanced",
        MODEL_FAST: "fallback-fast",
        MODEL_REASONING: "fallback-reasoning"
      })
    ).resolves.toEqual({ recovered: true });
    expect(state.recoverOne).toHaveBeenCalledWith(90_000);
    expect(state.piArguments.at(-1)).toMatchObject({
      models: {
        balanced: { modelId: "fallback-balanced", providerId: "openai" },
        fast: { modelId: "fallback-fast", providerId: "openai" },
        reasoning: { modelId: "fallback-reasoning", providerId: "openai" }
      }
    });
  });

  it("uses defaults and rejects malformed options, missing inputs, invalid auth, and unknown commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personal-agent-cli-errors-"));
    temporary.push(directory);
    const { runDevelopmentCli } = await loadCli();
    await expect(runDevelopmentCli(["run-once", "--broken"], { DATABASE_URL: databaseUrl })).rejects.toThrow(
      "pairs"
    );
    await expect(
      runDevelopmentCli(["task-create", "--title", "missing files"], { DATABASE_URL: databaseUrl })
    ).rejects.toThrow("spec-file");
    await expect(runDevelopmentCli(["run-once"], { DATABASE_URL: databaseUrl })).rejects.toThrow(
      "DEVELOPMENT_PI_AGENT_DIR"
    );
    await writeFile(join(directory, "auth.json"), "not json");
    await expect(
      runDevelopmentCli(["run-once"], {
        DATABASE_URL: databaseUrl,
        DEVELOPMENT_PI_AGENT_DIR: directory
      })
    ).rejects.toBeInstanceOf(SyntaxError);
    await rm(join(directory, "auth.json"));
    await expect(
      runDevelopmentCli(["unknown"], {
        DATABASE_URL: databaseUrl,
        DEVELOPMENT_PI_AGENT_DIR: directory
      })
    ).rejects.toThrow("Expected task-create");
    await expect(
      runDevelopmentCli(["run-once"], {
        DATABASE_URL: databaseUrl,
        DEVELOPMENT_PI_AGENT_DIR: directory
      })
    ).resolves.toEqual({ ran: true });
    expect(state.runOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedPaths: ["."],
        forbiddenPaths: [".git", ".pi", ".secrets", "browser-profile"],
        leaseDurationMs: 90_000,
        modelProfile: "balanced",
        relevantPaths: []
      })
    );
    expect(state.piArguments.at(-1)).toMatchObject({
      models: {
        balanced: { modelId: "gpt-5.6-terra", providerId: "openai" },
        fast: { modelId: "gpt-5.6-luna", providerId: "openai" },
        reasoning: { modelId: "gpt-5.6-sol", providerId: "openai" }
      }
    });
  });

  it("renders CLI main success, empty success, Error, non-Error, and executable detection", async () => {
    const { maybeRunDevelopmentCliMain, runDevelopmentCliMain } = await loadCli();
    const output = { write: vi.fn(() => true) };
    const errorOutput = { write: vi.fn(() => true) };
    await runDevelopmentCliMain(async () => ({ ok: true }), output, errorOutput);
    await runDevelopmentCliMain(async () => undefined, output, errorOutput);
    await runDevelopmentCliMain(async () => Promise.reject(new Error("main failed")), output, errorOutput);
    await runDevelopmentCliMain(async () => Promise.reject("non-error"), output, errorOutput);
    expect(output.write).toHaveBeenNthCalledWith(1, '{"ok":true}\n');
    expect(output.write).toHaveBeenNthCalledWith(2, "null\n");
    expect(errorOutput.write).toHaveBeenNthCalledWith(1, "main failed\n");
    expect(errorOutput.write).toHaveBeenNthCalledWith(2, "Development runner failed\n");

    const main = vi.fn(async () => undefined);
    expect(maybeRunDevelopmentCliMain("file:///module.js", undefined, main)).toBe(false);
    expect(maybeRunDevelopmentCliMain("file:///module.js", "/different.js", main)).toBe(false);
    expect(maybeRunDevelopmentCliMain("file:///module.js", "/module.js", main)).toBe(true);
    await Promise.resolve();
    expect(main).toHaveBeenCalledOnce();
  });
});
