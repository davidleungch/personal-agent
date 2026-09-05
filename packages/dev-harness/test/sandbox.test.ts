import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyDevelopmentUsage, type DevelopmentUsage, type JsonObject } from "@personal-agent/shared";
import { TrustedGit } from "../src/git";
import {
  DockerSandboxManager,
  SandboxGateway,
  assertSandboxPath,
  type SandboxManager,
  type SandboxWorkspace
} from "../src/sandbox";
import type { ProcessResult } from "../src/process";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const budget = {
  maxCommandMs: 2_000,
  maxCommandOutputBytes: 20_000,
  maxContextBytes: 100_000,
  maxCostUsdMicros: 1_000,
  maxDiffBytes: 20_000,
  maxModelInvocations: 2,
  maxTokens: 1_000,
  maxToolCalls: 100,
  maxWallClockMs: 100_000,
  maxWorkspaceBytes: 100_000_000
};

async function gitWorkspace() {
  const repository = await mkdtemp(join(tmpdir(), "personal-agent-sandbox-repo-"));
  const workspaces = `${repository}-workspaces`;
  cleanup.push(repository, workspaces);
  await mkdir(join(repository, "src/private/nested"), { recursive: true });
  await mkdir(join(repository, "src/[private]"), { recursive: true });
  await mkdir(join(repository, ".pi"));
  await writeFile(join(repository, "src/value.txt"), "value\n");
  await writeFile(join(repository, "src/private/secret.txt"), "FORBIDDEN_PRIVATE_CANARY\n");
  await writeFile(
    join(repository, "src/private/nested/secret.txt"),
    "FORBIDDEN_NESTED_CANARY\n"
  );
  await writeFile(
    join(repository, "src/[private]/secret.txt"),
    "FORBIDDEN_GLOB_CANARY\n"
  );
  await writeFile(join(repository, ".pi/hidden.txt"), "FORBIDDEN_PI_CANARY\n");
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
  const git = new TrustedGit(repository, workspaces, ["SANDBOX_SECRET_CANARY"]);
  const id = "00000000-0000-4000-8000-000000000099";
  const path = await git.createWorktree(id, base);
  return { base, git, id, path };
}

class FakeSandboxManager implements SandboxManager {
  results: ProcessResult[] = [];
  executions: unknown[] = [];

  identify(input: { sandboxId: string; workspacePath: string }): SandboxWorkspace {
    return { containerName: "fake", id: input.sandboxId, path: input.workspacePath };
  }

  async create(input: { sandboxId: string; workspacePath: string }): Promise<SandboxWorkspace> {
    return this.identify(input);
  }

  async execute(
    _workspace: SandboxWorkspace,
    input: {
      arguments: readonly string[];
      executable: "node" | "pnpm";
      maxOutputBytes: number;
      signal?: AbortSignal;
      timeoutMs: number;
      workingDirectory?: string;
    }
  ): Promise<ProcessResult> {
    this.executions.push(input);
    return (
      this.results.shift() ?? {
        durationMs: 5,
        exitCode: 0,
        outputLimitExceeded: false,
        stderr: "",
        stdout: "command output",
        timedOut: false
      }
    );
  }

  async teardown(): Promise<void> {}
}

async function gatewayFixture() {
  const fixture = await gitWorkspace();
  const manager = new FakeSandboxManager();
  const audits: Array<{ safeMetadata: JsonObject; status: string; tool: string }> = [];
  const usages: DevelopmentUsage[] = [];
  const workspace = manager.identify({ sandboxId: fixture.id, workspacePath: fixture.path });
  const gateway = new SandboxGateway({
    allowedPaths: ["src", "new"],
    budget,
    forbiddenPaths: ["src/forbidden"],
    git: fixture.git,
    knownSecrets: ["SANDBOX_SECRET_CANARY"],
    onAudit: async (event) => {
      audits.push(event);
    },
    onUsage: async (delta) => {
      usages.push(delta);
    },
    sandboxManager: manager,
    workspace
  });
  return { ...fixture, audits, gateway, manager, usages, workspace };
}

describe("project-owned sandbox gateway", () => {
  it("enforces canonical sandbox roots", () => {
    expect(() => assertSandboxPath("/workspace", "/workspace/src/file")).not.toThrow();
    expect(() => assertSandboxPath("/workspace", "/workspace", true)).not.toThrow();
    expect(() => assertSandboxPath("/workspace", "/workspace", false)).toThrow("escapes");
    expect(() => assertSandboxPath("/workspace", "/host/file")).toThrow("escapes");
  });

  it("adds only the non-authoritative terminating tool for a fix Implementer", async () => {
    const fixture = await gatewayFixture();
    const fix = new SandboxGateway({
      allowedPaths: ["src"],
      budget,
      fix: true,
      forbiddenPaths: [".git"],
      git: fixture.git,
      onAudit: async () => undefined,
      onUsage: async () => undefined,
      sandboxManager: fixture.manager,
      workspace: fixture.workspace
    });
    expect(fix.names).toContain("fix.submit");
    expect(fix.names).not.toContain("git.commit");
    await expect(fix.invoke("fix.submit", { outcome: "FIX_COMPLETE" })).rejects.toThrow(
      "Pi adapter"
    );
  });

  it("reads, lists, searches, writes, edits, and audits only workspace-scoped files", async () => {
    const fixture = await gatewayFixture();
    await expect(fixture.gateway.invoke("sandbox.read", { path: "src/value.txt" })).resolves.toMatchObject({
      content: "value\n",
      safeMetadata: { path: "src/value.txt" }
    });
    await expect(fixture.gateway.invoke("sandbox.list", {})).resolves.toMatchObject({
      content: expect.stringContaining("directory\tsrc")
    });
    await expect(fixture.gateway.invoke("sandbox.list", { path: "src" })).resolves.toMatchObject({
      content: expect.stringContaining("file\tvalue.txt")
    });
    await expect(
      fixture.gateway.invoke("sandbox.search", { query: "value" })
    ).resolves.toMatchObject({ content: expect.stringContaining("value") });
    await expect(
      fixture.gateway.invoke("sandbox.search", { path: "src", query: "absent" })
    ).resolves.toMatchObject({ content: "" });
    await expect(
      fixture.gateway.invoke("sandbox.write", { content: "created\n", path: "new/nested/file.txt" })
    ).resolves.toMatchObject({ content: "File written" });
    await expect(
      fixture.gateway.invoke("sandbox.write", { content: "updated\n", path: "src/value.txt" })
    ).resolves.toMatchObject({ content: "File written" });
    await expect(
      fixture.gateway.invoke("sandbox.edit", {
        newText: "edited",
        oldText: "updated",
        path: "src/value.txt"
      })
    ).resolves.toMatchObject({ content: "File edited" });
    expect(fixture.audits.every((event) => !("content" in event.safeMetadata))).toBe(true);
    expect(fixture.usages.every((delta) => delta.toolCalls === 1)).toBe(true);
  });

  it("rejects absolute, traversal, Git metadata, symlink, device, write-scope, and unsafe edit paths", async () => {
    const fixture = await gatewayFixture();
    await expect(
      fixture.gateway.invoke("sandbox.read", { path: "/etc/passwd" })
    ).rejects.toBeDefined();
    await expect(
      fixture.gateway.invoke("sandbox.read", { path: "../outside" })
    ).rejects.toBeDefined();
    await expect(fixture.gateway.invoke("sandbox.read", { path: ".git" })).rejects.toThrow(
      "not model-readable"
    );
    await symlink("value.txt", join(fixture.path, "src/link.txt"));
    await expect(fixture.gateway.invoke("sandbox.read", { path: "src/link.txt" })).rejects.toThrow(
      "Symlinks"
    );
    execFileSync("mkfifo", [join(fixture.path, "src/fifo")]);
    await expect(fixture.gateway.invoke("sandbox.read", { path: "src/fifo" })).rejects.toThrow(
      "device-like"
    );
    await writeFile(join(fixture.path, "src/large.txt"), "x".repeat(1_000_001));
    await expect(fixture.gateway.invoke("sandbox.read", { path: "src/large.txt" })).rejects.toThrow(
      "read limit"
    );
    await expect(
      fixture.gateway.invoke("sandbox.write", { content: "x", path: "README.md" })
    ).rejects.toThrow("write scope");
    await expect(
      fixture.gateway.invoke("sandbox.write", { content: "x", path: "src/forbidden/x.txt" })
    ).rejects.toThrow("write scope");
    await expect(
      fixture.gateway.invoke("sandbox.write", { content: "x", path: "src" })
    ).rejects.toThrow("regular files");
    await writeFile(join(fixture.path, "src/crossing"), "file");
    await expect(
      fixture.gateway.invoke("sandbox.write", { content: "x", path: "src/crossing/child.txt" })
    ).rejects.toThrow("non-directory");
    await writeFile(join(fixture.path, "src/duplicate.txt"), "same same");
    await expect(
      fixture.gateway.invoke("sandbox.edit", {
        newText: "new",
        oldText: "same",
        path: "src/duplicate.txt"
      })
    ).rejects.toThrow("exactly once");
    await expect(
      fixture.gateway.invoke("sandbox.edit", {
        newText: "new",
        oldText: "missing",
        path: "src/value.txt"
      }, new AbortController().signal)
    ).rejects.toThrow("exactly once");
    expect(fixture.audits.some((event) => event.status === "failed")).toBe(true);
  });

  it("bounds directory, search, and command output and exposes only node or pnpm execution", async () => {
    const fixture = await gatewayFixture();
    const crowded = join(fixture.path, "src/crowded");
    await mkdir(crowded);
    await Promise.all(
      Array.from({ length: 1_001 }, (_value, index) => writeFile(join(crowded, String(index)), ""))
    );
    await expect(fixture.gateway.invoke("sandbox.list", { path: "src/crowded" })).rejects.toThrow(
      "listing limit"
    );
    await expect(
      fixture.gateway.invoke("sandbox.exec", {
        arguments: ["--version"],
        executable: "node",
        timeoutMs: 50,
        workingDirectory: "src"
      }, new AbortController().signal)
    ).resolves.toMatchObject({ content: "command output" });
    expect(fixture.usages).toContainEqual({
      ...emptyDevelopmentUsage(),
      commandMs: 5,
      commandOutputBytes: "command output".length
    });
    fixture.manager.results.push({
      durationMs: 10,
      exitCode: 1,
      outputLimitExceeded: false,
      stderr: "SANDBOX_SECRET_CANARY",
      stdout: "",
      timedOut: false
    });
    await expect(
      fixture.gateway.invoke("sandbox.exec", { executable: "pnpm" })
    ).rejects.toThrow("command failed");
    fixture.manager.results.push({
      durationMs: 10,
      exitCode: 0,
      outputLimitExceeded: true,
      stderr: "",
      stdout: "large",
      timedOut: false
    });
    await expect(
      fixture.gateway.invoke("sandbox.exec", { executable: "node" })
    ).rejects.toThrow("command failed");
    await expect(
      fixture.gateway.invoke("sandbox.exec", { executable: "bash" })
    ).rejects.toBeDefined();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      fixture.gateway.invoke("sandbox.search", { query: "value" }, aborted.signal)
    ).rejects.toThrow("search failed");
    const nonErrorAudits: JsonObject[] = [];
    const nonErrorGateway = new SandboxGateway({
      allowedPaths: ["src"],
      budget,
      forbiddenPaths: [],
      git: fixture.git,
      onAudit: async (event) => {
        nonErrorAudits.push(event.safeMetadata);
      },
      onUsage: async () => Promise.reject("non-error"),
      sandboxManager: fixture.manager,
      workspace: fixture.workspace
    });
    await expect(nonErrorGateway.invoke("sandbox.read", { path: "src/value.txt" })).rejects.toBe(
      "non-error"
    );
    expect(nonErrorAudits.at(-1)).toEqual({ failure_class: "unknown" });
  });

  it("enforces the Reviewer read-only grant, bounded reads, exact diff, and approved checks", async () => {
    const fixture = await gitWorkspace();
    await writeFile(join(fixture.path, "src/value.txt"), "candidate\n");
    const candidate = await fixture.git.captureCandidate({
      allowedPaths: ["src"], attemptId: fixture.id, baseCommit: fixture.base,
      forbiddenPaths: [], maxDiffBytes: budget.maxDiffBytes, workspacePath: fixture.path
    });
    await fixture.git.removeWorktree(fixture.path);
    const reviewId = "00000000-0000-4000-8000-000000000098";
    const reviewPath = await fixture.git.createWorktree(reviewId, candidate.commit);
    const manager = new FakeSandboxManager();
    const workspace = manager.identify({ sandboxId: reviewId, workspacePath: reviewPath });
    const audits: unknown[] = [];
    const gatewayInput = {
      allowedPaths: ["src"],
      approvedChecks: [{
        check: { arguments: ["-e", "process.exit(0)"], executable: "node" as const, timeoutMs: 500, workingDirectory: "src" },
        description: "fixture", id: "fixture"
      }],
      baseCommit: fixture.base,
      budget,
      candidateCommit: candidate.commit,
      forbiddenPaths: ["src/private", "src/[private]", "outside/private"],
      git: fixture.git,
      knownSecrets: ["SANDBOX_SECRET_CANARY"],
      onAudit: async (event: unknown) => { audits.push(event); },
      onUsage: async () => undefined,
      role: "reviewer" as const,
      sandboxManager: manager,
      workspace
    };
    const reviewer = new SandboxGateway(gatewayInput);
    expect(reviewer.names).toEqual([
      "sandbox.read", "sandbox.list", "sandbox.search", "git.status", "git.diff",
      "review.run_check", "review.submit"
    ]);
    await expect(reviewer.invoke("sandbox.list", {})).resolves.toMatchObject({
      content: "directory\tsrc",
      safeMetadata: { entries: 1, path: "." }
    });
    await expect(reviewer.invoke("sandbox.list", { path: "src" })).resolves.toMatchObject({
      content: "file\tvalue.txt",
      safeMetadata: { entries: 1, path: "src" }
    });
    await expect(reviewer.invoke("sandbox.read", { path: "src/value.txt" })).resolves.toMatchObject({
      content: "candidate\n"
    });
    await expect(reviewer.invoke("sandbox.read", { path: "package.json" })).rejects.toThrow("read scope");
    await expect(reviewer.invoke("sandbox.search", { query: "candidate" })).rejects.toThrow("bounded path");
    await expect(reviewer.invoke("sandbox.search", { path: "src", query: "candidate" })).resolves.toMatchObject({ content: expect.stringContaining("candidate") });
    await expect(
      reviewer.invoke("sandbox.search", { path: "src", query: "FORBIDDEN_PRIVATE_CANARY" })
    ).resolves.toMatchObject({ content: "", safeMetadata: { matches: 0 } });
    await expect(
      reviewer.invoke("sandbox.search", { path: "src", query: "FORBIDDEN_NESTED_CANARY" })
    ).resolves.toMatchObject({ content: "", safeMetadata: { matches: 0 } });
    await expect(
      reviewer.invoke("sandbox.search", { path: "src", query: "FORBIDDEN_GLOB_CANARY" })
    ).resolves.toMatchObject({ content: "", safeMetadata: { matches: 0 } });
    await expect(reviewer.invoke("git.status", {})).resolves.toMatchObject({ content: "" });
    await expect(reviewer.invoke("git.diff", {})).resolves.toMatchObject({ content: expect.stringContaining("candidate") });
    await expect(reviewer.invoke("review.run_check", { acceptanceCriterionId: "fixture" }, new AbortController().signal)).resolves.toMatchObject({ content: "command output" });
    await expect(reviewer.invoke("review.submit", { decision: "APPROVE", findings: [] })).rejects.toThrow("Pi adapter");
    await expect(reviewer.invoke("sandbox.write", { path: "src/value.txt", content: "bad" })).rejects.toThrow("not granted");

    for (const result of [
      { exitCode: 1, timedOut: false, outputLimitExceeded: false },
      { exitCode: 0, timedOut: true, outputLimitExceeded: false },
      { exitCode: 0, timedOut: false, outputLimitExceeded: true }
    ]) {
      manager.results.push({ durationMs: 1, stderr: "bad", stdout: "", ...result });
      await expect(reviewer.invoke("review.run_check", { acceptanceCriterionId: "fixture" })).rejects.toThrow("check failed");
    }
    expect(audits.length).toBeGreaterThan(0);

    expect(() => new SandboxGateway({ ...gatewayInput, baseCommit: undefined })).toThrow("exact base");
    const wholeRepo = new SandboxGateway({
      ...gatewayInput,
      allowedPaths: ["."],
      forbiddenPaths: [".pi", "src/private", "src/[private]"]
    });
    const wholeRepositoryRoot = await wholeRepo.invoke("sandbox.list", {});
    expect(wholeRepositoryRoot.content).not.toContain(".pi");
    expect(wholeRepositoryRoot.safeMetadata).toEqual({ entries: 8, path: "." });
    await expect(wholeRepo.invoke("sandbox.search", { query: "candidate" })).resolves.toMatchObject({ content: expect.stringContaining("candidate") });
    await expect(
      wholeRepo.invoke("sandbox.search", { query: "FORBIDDEN_PI_CANARY" })
    ).resolves.toMatchObject({ content: "", safeMetadata: { matches: 0 } });
  });

  it("routes Git status and diff through trusted Git without commit authority", async () => {
    const fixture = await gatewayFixture();
    await writeFile(join(fixture.path, "src/value.txt"), "diff\n");
    await expect(fixture.gateway.invoke("git.status", {})).resolves.toMatchObject({
      content: expect.stringContaining("src/value.txt")
    });
    await expect(fixture.gateway.invoke("git.diff", {})).resolves.toMatchObject({
      content: expect.stringContaining("diff")
    });
    expect(fixture.gateway.names).not.toContain("git.commit");
  });
});

describe("Docker sandbox security boundary", () => {
  it("keeps runner and host credentials, host files, Docker, SSH, and Pi state outside the container", async () => {
    const fixture = await gitWorkspace();
    const hostCanaryPath = join(tmpdir(), `host-canary-${process.pid}`);
    cleanup.push(hostCanaryPath);
    await writeFile(hostCanaryPath, "HOST_ONLY_CANARY");
    process.env.PROVIDER_CANARY_FOR_SANDBOX_TEST = "PROVIDER_ONLY_CANARY";
    process.env.GOOGLE_CANARY_FOR_SANDBOX_TEST = "GOOGLE_ONLY_CANARY";
    process.env.PRODUCTION_DATABASE_CANARY_FOR_SANDBOX_TEST = "DATABASE_ONLY_CANARY";
    const manager = new DockerSandboxManager("node:22.19.0-bookworm-slim", async () => ({
      durationMs: 0,
      exitCode: 0,
      outputLimitExceeded: false,
      stderr: "",
      stdout: "",
      timedOut: false
    }));
    const workspace = await manager.create({ sandboxId: fixture.id, workspacePath: fixture.path });
    await expect(manager.create({ sandboxId: fixture.id, workspacePath: fixture.path })).resolves.toEqual(
      workspace
    );
    const script = [
      "const fs=require('node:fs');",
      `console.log(JSON.stringify({provider:process.env.PROVIDER_CANARY_FOR_SANDBOX_TEST,google:process.env.GOOGLE_CANARY_FOR_SANDBOX_TEST,database:process.env.PRODUCTION_DATABASE_CANARY_FOR_SANDBOX_TEST,host:fs.existsSync(${JSON.stringify(hostCanaryPath)}),docker:fs.existsSync('/var/run/docker.sock'),ssh:fs.existsSync('/home/sandbox/.ssh'),pi:fs.existsSync('/home/sandbox/.pi/agent')}));`
    ].join("");
    const result = await manager.execute(workspace, {
      arguments: ["-e", script],
      executable: "node",
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workingDirectory: "src"
    });
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(observed).toEqual({
      docker: false,
      host: false,
      pi: false,
      ssh: false
    });
    expect(observed.provider).toBeUndefined();
    expect(observed.google).toBeUndefined();
    expect(observed.database).toBeUndefined();
    await manager.teardown(workspace);
    await expect(manager.teardown(workspace)).resolves.toBeUndefined();
    delete process.env.PROVIDER_CANARY_FOR_SANDBOX_TEST;
    delete process.env.GOOGLE_CANARY_FOR_SANDBOX_TEST;
    delete process.env.PRODUCTION_DATABASE_CANARY_FOR_SANDBOX_TEST;
  }, 60_000);

  it("treats both Docker missing-container messages as idempotent and rethrows other cleanup failures", async () => {
    const workspace = { containerName: "missing", id: "id", path: "/tmp" };
    for (const message of ["No such container", "No such object"]) {
      const manager = new DockerSandboxManager("unused") as unknown as { docker: () => Promise<string>; teardown: (workspace: SandboxWorkspace) => Promise<void> };
      manager.docker = async () => Promise.reject(new Error(message));
      await expect(manager.teardown(workspace)).resolves.toBeUndefined();
    }
    const manager = new DockerSandboxManager("unused") as unknown as { docker: () => Promise<string>; teardown: (workspace: SandboxWorkspace) => Promise<void> };
    manager.docker = async () => Promise.reject("non-error");
    await expect(manager.teardown(workspace)).rejects.toBe("non-error");
  });

  it("fails closed when dependency preparation or container cleanup fails", async () => {
    const fixture = await gitWorkspace();
    const manager = new DockerSandboxManager("node:22.19.0-bookworm-slim");
    await expect(manager.create({ sandboxId: fixture.id, workspacePath: fixture.path })).rejects.toThrow(
      "dependency installation failed"
    );
    const workspace = manager.identify({ sandboxId: fixture.id, workspacePath: fixture.path });
    await manager.teardown(workspace);
    await expect(manager.teardown({ ...workspace, containerName: "" })).rejects.toBeDefined();
  }, 60_000);
});
