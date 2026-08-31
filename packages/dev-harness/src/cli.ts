import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase, createDevelopmentRepositories, createReviewRepositories } from "@personal-agent/db";
import { developmentAcceptanceCriteriaSchema, type DevelopmentBudget } from "@personal-agent/shared";
import { z } from "zod";
import { DevelopmentCoordinator } from "./coordinator.js";
import { DevelopmentContextCompiler } from "./context-compiler.js";
import { TrustedGit } from "./git.js";
import { OfficialPiTransport, PiDevelopmentHarness, type PiModelConfiguration } from "./pi-adapter.js";
import { ReviewerContextCompiler } from "./reviewer-context-compiler.js";
import { ReviewerCoordinator } from "./reviewer-coordinator.js";
import { DockerSandboxManager } from "./sandbox.js";

const defaultBudget: DevelopmentBudget = {
  maxCommandMs: 10 * 60 * 1_000,
  maxCommandOutputBytes: 2_000_000,
  maxContextBytes: 500_000,
  maxCostUsdMicros: 20_000_000,
  maxDiffBytes: 20_000_000,
  maxModelInvocations: 8,
  maxTokens: 200_000,
  maxToolCalls: 200,
  maxWallClockMs: 30 * 60 * 1_000,
  maxWorkspaceBytes: 1_000_000_000
};

function options(arguments_: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("CLI options require --name value pairs");
    result.set(key.slice(2), value);
  }
  return result;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

function list(values: Map<string, string>, name: string, fallback: readonly string[]): string[] {
  return values.get(name)?.split(",").filter(Boolean) ?? [...fallback];
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 8 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

async function trustedSecrets(databaseUrl: string, agentDirectory?: string): Promise<string[]> {
  const secrets = [databaseUrl, new URL(databaseUrl).password].filter((value) => value.length >= 8);
  if (agentDirectory) {
    try {
      const credentials = JSON.parse(await readFile(resolve(agentDirectory, "auth.json"), "utf8")) as unknown;
      secrets.push(...strings(credentials));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return [...new Set(secrets)];
}

function modelConfiguration(environment: NodeJS.ProcessEnv): PiModelConfiguration {
  return {
    balanced: {
      modelId: environment.DEVELOPMENT_MODEL_BALANCED ?? environment.MODEL_BALANCED ?? "gpt-5.6-terra",
      providerId: environment.DEVELOPMENT_MODEL_BALANCED_PROVIDER ?? "openai"
    },
    fast: {
      modelId: environment.DEVELOPMENT_MODEL_FAST ?? environment.MODEL_FAST ?? "gpt-5.6-luna",
      providerId: environment.DEVELOPMENT_MODEL_FAST_PROVIDER ?? "openai"
    },
    reasoning: {
      modelId: environment.DEVELOPMENT_MODEL_REASONING ?? environment.MODEL_REASONING ?? "gpt-5.6-sol",
      providerId: environment.DEVELOPMENT_MODEL_REASONING_PROVIDER ?? "openai"
    }
  };
}

export async function runDevelopmentCli(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env
): Promise<unknown> {
  const [command, ...optionArguments] = arguments_;
  const values = options(optionArguments);
  const databaseUrl = z.string().url().parse(environment.DATABASE_URL);
  const repositoryPath = resolve(environment.DEVELOPMENT_REPOSITORY_PATH ?? process.cwd());
  const workspaceRoot = resolve(
    environment.DEVELOPMENT_WORKSPACE_ROOT ?? "/tmp/personal-agent-development-workspaces"
  );
  const agentDirectory = environment.DEVELOPMENT_PI_AGENT_DIR
    ? resolve(environment.DEVELOPMENT_PI_AGENT_DIR)
    : undefined;
  const knownSecrets = await trustedSecrets(databaseUrl, agentDirectory);
  const connection = createDatabase(databaseUrl);
  const persistence = createDevelopmentRepositories(connection.database, knownSecrets);
  const git = new TrustedGit(repositoryPath, workspaceRoot, knownSecrets);

  try {
    if (command === "task-create") {
      const specification = await readFile(resolve(required(values, "spec-file")), "utf8");
      const criteria = developmentAcceptanceCriteriaSchema.parse(
        JSON.parse(await readFile(resolve(required(values, "criteria-file")), "utf8"))
      );
      const coordinator = new DevelopmentCoordinator({
        contextCompiler: new DevelopmentContextCompiler(git),
        git,
        harness: new PiDevelopmentHarness({
          run: async () => {
            throw new Error("Harness execution is unavailable during task creation");
          }
        }),
        knownSecrets,
        persistence,
        runnerId: "human-task-ingress",
        sandboxManager: new DockerSandboxManager("unused")
      });
      return coordinator.createApprovedTask({
        acceptanceCriteria: criteria,
        approvedSpec: specification,
        baseReference: values.get("base") ?? "HEAD",
        title: required(values, "title")
      });
    }

    if (!agentDirectory) throw new Error("DEVELOPMENT_PI_AGENT_DIR is required for development execution");
    await mkdir(agentDirectory, { mode: 0o700, recursive: true });
    const sandboxManager = new DockerSandboxManager(
      environment.DEVELOPMENT_SANDBOX_IMAGE ?? "personal-agent-development-sandbox:local"
    );
    const coordinator = new DevelopmentCoordinator({
      contextCompiler: new DevelopmentContextCompiler(git),
      git,
      harness: new PiDevelopmentHarness(
        new OfficialPiTransport({ agentDirectory, models: modelConfiguration(environment) })
      ),
      knownSecrets,
      persistence,
      runnerId: environment.DEVELOPMENT_RUNNER_ID ?? `development-runner-${process.pid}`,
      sandboxManager
    });
    if (command === "run-once") {
      return coordinator.runOne({
        allowedPaths: list(values, "allowed", ["."]),
        budget: defaultBudget,
        forbiddenPaths: list(values, "forbidden", [".git", ".pi", ".secrets", "browser-profile"]),
        leaseDurationMs: Number(values.get("lease-ms") ?? 90_000),
        modelProfile: z.enum(["fast", "balanced", "reasoning"]).parse(values.get("profile") ?? "balanced"),
        relevantPaths: list(values, "relevant", [])
      });
    }
    if (command === "recover-one") {
      return coordinator.recoverOne(Number(values.get("lease-ms") ?? 90_000));
    }
    if (command === "review-once" || command === "recover-review") {
      const reviewer = new ReviewerCoordinator({
        contextCompiler: new ReviewerContextCompiler(git),
        developmentPersistence: persistence,
        git,
        harness: new PiDevelopmentHarness(
          new OfficialPiTransport({ agentDirectory, models: modelConfiguration(environment) })
        ),
        knownSecrets,
        persistence: createReviewRepositories(connection.database, knownSecrets),
        runnerId: environment.DEVELOPMENT_RUNNER_ID ?? `development-reviewer-${process.pid}`,
        sandboxManager
      });
      const policy = {
        budget: defaultBudget,
        forbiddenPaths: list(values, "forbidden", [".git", ".pi", ".secrets", "browser-profile"]),
        leaseDurationMs: Number(values.get("lease-ms") ?? 90_000),
        modelProfile: z.enum(["fast", "balanced", "reasoning"]).parse(values.get("profile") ?? "reasoning"),
        readablePaths: list(values, "readable", ["AGENTS.md", "docs"]),
        relevantPaths: list(values, "relevant", [])
      };
      return command === "review-once"
        ? reviewer.runOne(policy)
        : reviewer.recoverOne(policy.leaseDurationMs);
    }
    throw new Error("Expected task-create, run-once, recover-one, review-once, or recover-review");
  } finally {
    await connection.close();
  }
}

export async function runDevelopmentCliMain(
  run: typeof runDevelopmentCli = runDevelopmentCli,
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr
): Promise<void> {
  try {
    const result = await run();
    output.write(`${JSON.stringify(result ?? null)}\n`);
  } catch (error) {
    errorOutput.write(`${error instanceof Error ? error.message : "Development runner failed"}\n`);
    process.exitCode = 1;
  }
}

export function maybeRunDevelopmentCliMain(
  moduleUrl: string,
  executablePath: string | undefined,
  main: () => Promise<void> = runDevelopmentCliMain
): boolean {
  if (!executablePath || moduleUrl !== new URL(executablePath, "file:").href) return false;
  void main();
  return true;
}

maybeRunDevelopmentCliMain(import.meta.url, process.argv[1]);
