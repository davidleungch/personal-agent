import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  developmentAcceptanceCriteriaSchema,
  emptyDevelopmentUsage,
  redactText,
  workspaceRelativePathSchema,
  type DevelopmentAcceptanceCriteria,
  type DevelopmentBudget,
  type DevelopmentUsage,
  type JsonObject
} from "@personal-agent/shared";
import { z } from "zod";
import {
  developmentToolNameSchema,
  fixImplementerToolNames,
  implementerToolNames,
  reviewerToolNames,
  type DevelopmentToolName,
  type DevelopmentToolResult,
  type DevelopmentToolSet
} from "./contract.js";
import { TrustedGit } from "./git.js";
import { requireProcess, runProcess, type ProcessResult } from "./process.js";

const dockerNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);

export function assertSandboxPath(root: string, path: string, allowRoot = false): void {
  if ((allowRoot && path === root) || path.startsWith(`${root}${sep}`)) return;
  throw new Error("Path escapes the sandbox workspace");
}

export type SandboxWorkspace = {
  containerName: string;
  id: string;
  path: string;
};

export interface SandboxManager {
  identify(input: { sandboxId: string; workspacePath: string }): SandboxWorkspace;
  create(input: { sandboxId: string; workspacePath: string }): Promise<SandboxWorkspace>;
  execute(
    workspace: SandboxWorkspace,
    input: {
      arguments: readonly string[];
      executable: "node" | "pnpm";
      maxOutputBytes: number;
      signal?: AbortSignal;
      timeoutMs: number;
      workingDirectory?: string;
    }
  ): Promise<ProcessResult>;
  teardown(workspace: SandboxWorkspace): Promise<void>;
}

export class DockerSandboxManager implements SandboxManager {
  private readonly prepareDependencies: (workspace: SandboxWorkspace) => Promise<ProcessResult>;

  constructor(
    private readonly image: string,
    prepareDependencies?: (workspace: SandboxWorkspace) => Promise<ProcessResult>
  ) {
    this.prepareDependencies =
      prepareDependencies ??
      ((workspace) =>
        this.execute(workspace, {
          arguments: [
            "install",
            "--offline",
            "--frozen-lockfile",
            "--trust-lockfile"
          ],
          executable: "pnpm",
          maxOutputBytes: 2_000_000,
          timeoutMs: 10 * 60 * 1_000
        }));
  }

  identify(input: { sandboxId: string; workspacePath: string }): SandboxWorkspace {
    const suffix = input.sandboxId.replaceAll("-", "").slice(-32);
    return {
      containerName: dockerNameSchema.parse(`personal-agent-dev-${suffix}`),
      id: input.sandboxId,
      path: resolve(input.workspacePath)
    };
  }

  private docker(arguments_: readonly string[], timeoutMs = 120_000): Promise<string> {
    return requireProcess({
      arguments: arguments_,
      command: "docker",
      environment: {
        DOCKER_HOST: process.env.DOCKER_HOST,
        LANG: "C.UTF-8",
        PATH: process.env.PATH
      },
      maxOutputBytes: 1_000_000,
      timeoutMs
    });
  }

  async create(input: { sandboxId: string; workspacePath: string }): Promise<SandboxWorkspace> {
    const workspacePath = await realpath(input.workspacePath);
    const identified = this.identify({ sandboxId: input.sandboxId, workspacePath });
    const { containerName } = identified;
    try {
      await this.docker(["inspect", containerName], 30_000);
      await this.docker(["start", containerName], 30_000);
    } catch {
      const user = `${process.getuid!()}:${process.getgid!()}`;
      await this.docker([
        "create",
        "--name",
        containerName,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=268435456",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--user",
        user,
        "--mount",
        `type=bind,source=${workspacePath},target=/workspace`,
        "--mount",
        `type=bind,source=${resolve(workspacePath, ".git")},target=/workspace/.git,readonly`,
        "--mount",
        "type=volume,target=/pnpm/store",
        "--workdir",
        "/workspace",
        this.image,
        "tail",
        "-f",
        "/dev/null"
      ]);
      await this.docker(["start", containerName], 30_000);
    }
    const workspace = { ...identified, path: workspacePath };
    const installed = await this.prepareDependencies(workspace);
    if (installed.exitCode !== 0 || installed.timedOut || installed.outputLimitExceeded) {
      throw new Error("Sandbox dependency installation failed");
    }
    return workspace;
  }

  execute(
    workspace: SandboxWorkspace,
    input: {
      arguments: readonly string[];
      executable: "node" | "pnpm";
      maxOutputBytes: number;
      signal?: AbortSignal;
      timeoutMs: number;
      workingDirectory?: string;
    }
  ): Promise<ProcessResult> {
    const workingDirectory = input.workingDirectory
      ? `/workspace/${workspaceRelativePathSchema.parse(input.workingDirectory)}`
      : "/workspace";
    return runProcess({
      arguments: [
        "exec",
        "--workdir",
        workingDirectory,
        workspace.containerName,
        input.executable,
        ...input.arguments
      ],
      command: "docker",
      environment: {
        DOCKER_HOST: process.env.DOCKER_HOST,
        LANG: "C.UTF-8",
        PATH: process.env.PATH
      },
      maxOutputBytes: input.maxOutputBytes,
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  async teardown(workspace: SandboxWorkspace): Promise<void> {
    try {
      await this.docker(["rm", "--volumes", "--force", workspace.containerName], 60_000);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("No such container") || error.message.includes("No such object"))
      ) {
        return;
      }
      throw error;
    }
  }
}

const readInputSchema = z.object({ path: workspaceRelativePathSchema });
const listInputSchema = z.object({ path: workspaceRelativePathSchema.optional() });
const searchInputSchema = z.object({
  path: workspaceRelativePathSchema.optional(),
  query: z.string().min(1).max(500)
});
const writeInputSchema = z.object({
  content: z.string().max(1_000_000),
  path: workspaceRelativePathSchema
});
const editInputSchema = z.object({
  newText: z.string().max(1_000_000),
  oldText: z.string().min(1).max(1_000_000),
  path: workspaceRelativePathSchema
});
const execInputSchema = z.object({
  arguments: z.array(z.string().max(1_000)).max(64).default([]),
  executable: z.enum(["node", "pnpm"]),
  timeoutMs: z.number().int().positive().optional(),
  workingDirectory: workspaceRelativePathSchema.optional()
});
const reviewCheckInputSchema = z.object({ acceptanceCriterionId: z.string().min(1).max(100) }).strict();

function pathMatches(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)
  );
}

function pathIntersectsDescendant(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => path === "." || prefix === path || prefix.startsWith(`${path}/`)
  );
}

function escapeSearchGlobPath(path: string): string {
  return path.replace(/[!*?[\]{}]/g, "\\$&");
}

export class SandboxGateway implements DevelopmentToolSet {
  readonly names: readonly DevelopmentToolName[];
  private readonly root: string;
  private readonly role: "implementer" | "reviewer";
  private readonly approvedChecks: DevelopmentAcceptanceCriteria;

  constructor(
    private readonly input: {
      allowedPaths: readonly string[];
      approvedChecks?: unknown;
      baseCommit?: string;
      budget: DevelopmentBudget;
      candidateCommit?: string;
      fix?: boolean;
      forbiddenPaths: readonly string[];
      git: TrustedGit;
      knownSecrets?: readonly string[];
      onAudit: (input: {
        safeMetadata: JsonObject;
        status: "started" | "success" | "failed";
        tool: DevelopmentToolName;
      }) => Promise<void>;
      onUsage: (delta: DevelopmentUsage) => Promise<void>;
      role?: "implementer" | "reviewer";
      sandboxManager: SandboxManager;
      workspace: SandboxWorkspace;
    }
  ) {
    this.root = resolve(input.workspace.path);
    this.role = input.role ?? "implementer";
    this.names = this.role === "reviewer"
      ? reviewerToolNames
      : input.fix
        ? fixImplementerToolNames
        : implementerToolNames;
    this.approvedChecks = this.role === "reviewer"
      ? developmentAcceptanceCriteriaSchema.parse(input.approvedChecks)
      : [];
    if (this.role === "reviewer" && (!input.baseCommit || !input.candidateCommit)) {
      throw new Error("Reviewer gateway requires exact base and candidate commits");
    }
  }

  private reviewerPathVisible(relativePath: string, allowReadableAncestor = false): boolean {
    if (pathMatches(relativePath, this.input.forbiddenPaths)) return false;
    return pathMatches(relativePath, this.input.allowedPaths) ||
      (allowReadableAncestor && pathIntersectsDescendant(relativePath, this.input.allowedPaths));
  }

  private lexicalPath(relativePath: string, allowReadableAncestor = false): string {
    const safePath = workspaceRelativePathSchema.parse(relativePath);
    if (safePath === ".git" || safePath.startsWith(".git/")) {
      throw new Error("Git metadata is not model-readable");
    }
    if (this.role === "reviewer" && !this.reviewerPathVisible(safePath, allowReadableAncestor)) {
      throw new Error("Path is outside the approved Reviewer read scope");
    }
    const absolute = resolve(this.root, safePath);
    assertSandboxPath(this.root, absolute);
    return absolute;
  }

  private async existingPath(relativePath: string, allowReadableAncestor = false): Promise<string> {
    const absolute = this.lexicalPath(relativePath, allowReadableAncestor);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error("Symlinks and device-like files are not accessible");
    }
    const canonical = await realpath(absolute);
    assertSandboxPath(this.root, canonical);
    return canonical;
  }

  private reviewerSearchExclusions(searchRoot: string): string[] {
    if (this.role !== "reviewer") return [];
    const exclusions: string[] = [];
    for (const forbidden of this.input.forbiddenPaths) {
      const relative = searchRoot.length === 0
        ? forbidden
        : forbidden.startsWith(`${searchRoot}/`)
          ? forbidden.slice(searchRoot.length + 1)
          : undefined;
      if (!relative) continue;
      const escaped = escapeSearchGlobPath(relative);
      exclusions.push("--glob", `!${escaped}`, "--glob", `!${escaped}/**`);
    }
    return exclusions;
  }

  private assertWritable(relativePath: string): void {
    if (
      !pathMatches(relativePath, this.input.allowedPaths) ||
      pathMatches(relativePath, this.input.forbiddenPaths)
    ) {
      throw new Error("Path is outside the approved write scope");
    }
  }

  private async safeWritePath(relativePath: string): Promise<string> {
    this.assertWritable(relativePath);
    const absolute = this.lexicalPath(relativePath);
    const parentRelative = dirname(relativePath);
    let current = this.root;
    if (parentRelative !== ".") {
      for (const segment of parentRelative.split("/")) {
        current = resolve(current, segment);
        try {
          const metadata = await lstat(current);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error("Write path crosses a non-directory or symlink");
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            await mkdir(current, { mode: 0o700 });
          } else {
            throw error;
          }
        }
      }
    }
    const canonicalParent = await realpath(resolve(absolute, ".."));
    assertSandboxPath(this.root, canonicalParent, true);
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("Writes may target only regular files");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return absolute;
  }

  async invoke(
    name: DevelopmentToolName,
    rawInput: unknown,
    signal?: AbortSignal
  ): Promise<DevelopmentToolResult> {
    const tool = developmentToolNameSchema.parse(name);
    if (!this.names.includes(tool)) throw new Error(`Tool is not granted to the ${this.role}`);
    await this.input.onAudit({ safeMetadata: {}, status: "started", tool });
    try {
      if (this.role === "reviewer") {
        await this.input.git.assertWorkspaceClean(this.input.workspace.path, this.input.candidateCommit!);
      }
      const result = await this.executeTool(tool, rawInput, signal);
      if (this.role === "reviewer") {
        await this.input.git.assertWorkspaceClean(this.input.workspace.path, this.input.candidateCommit!);
      }
      await this.input.onUsage({ ...emptyDevelopmentUsage(), toolCalls: 1 });
      await this.input.onAudit({ safeMetadata: result.safeMetadata, status: "success", tool });
      return result;
    } catch (error) {
      await this.input.onAudit({
        safeMetadata: { failure_class: error instanceof Error ? error.name : "unknown" },
        status: "failed",
        tool
      });
      throw error;
    }
  }

  private async executeTool(
    tool: DevelopmentToolName,
    rawInput: unknown,
    signal?: AbortSignal
  ): Promise<DevelopmentToolResult> {
    if (tool === "sandbox.read") {
      const input = readInputSchema.parse(rawInput);
      const path = await this.existingPath(input.path);
      const content = await readFile(path, "utf8");
      if (Buffer.byteLength(content) > 1_000_000) throw new Error("File exceeds read limit");
      return {
        content: redactText(content, this.input.knownSecrets),
        safeMetadata: { bytes: Buffer.byteLength(content), path: input.path }
      };
    }
    if (tool === "sandbox.list") {
      const input = listInputSchema.parse(rawInput);
      const relativePath = input.path ?? "";
      const path = relativePath ? await this.existingPath(relativePath, true) : this.root;
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.length > 1_000) throw new Error("Directory exceeds listing limit");
      const visibleEntries = entries.filter((entry) => {
        if (entry.name === ".git") return false;
        if (this.role !== "reviewer") return true;
        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        return this.reviewerPathVisible(entryPath, true);
      });
      const content = visibleEntries
        .map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`)
        .join("\n");
      return {
        content,
        safeMetadata: { entries: visibleEntries.length, path: relativePath || "." }
      };
    }
    if (tool === "sandbox.search") {
      const input = searchInputSchema.parse(rawInput);
      if (this.role === "reviewer" && !input.path && !this.reviewerPathVisible(".")) {
        throw new Error("Reviewer search requires an approved bounded path");
      }
      const relativePath = input.path ?? "";
      const searchPath = input.path ? await this.existingPath(input.path) : this.root;
      const result = await runProcess({
        arguments: [
          "--fixed-strings",
          "--line-number",
          "--max-count",
          "200",
          "--glob",
          "!node_modules/**",
          "--glob",
          "!.git/**",
          ...this.reviewerSearchExclusions(relativePath),
          input.query,
          searchPath
        ],
        command: "rg",
        cwd: this.root,
        maxOutputBytes: this.input.budget.maxCommandOutputBytes,
        timeoutMs: this.input.budget.maxCommandMs,
        ...(signal ? { signal } : {})
      });
      if (![0, 1].includes(result.exitCode ?? -1) || result.timedOut || result.outputLimitExceeded) {
        throw new Error("Sandbox search failed");
      }
      return {
        content: redactText(result.stdout, this.input.knownSecrets),
        safeMetadata: { duration_ms: result.durationMs, matches: result.stdout.split("\n").filter(Boolean).length }
      };
    }
    if (tool === "review.run_check") {
      const input = reviewCheckInputSchema.parse(rawInput);
      const criterion = this.approvedChecks.find(
        (candidate) => candidate.id === input.acceptanceCriterionId
      );
      if (!criterion) throw new Error("Reviewer requested an unapproved deterministic check");
      const result = await this.input.sandboxManager.execute(this.input.workspace, {
        arguments: criterion.check.arguments,
        executable: criterion.check.executable,
        maxOutputBytes: this.input.budget.maxCommandOutputBytes,
        timeoutMs: Math.min(criterion.check.timeoutMs, this.input.budget.maxCommandMs),
        ...(signal ? { signal } : {}),
        ...(criterion.check.workingDirectory
          ? { workingDirectory: criterion.check.workingDirectory }
          : {})
      });
      const output = `${result.stdout}${result.stderr}`;
      await this.input.onUsage({
        ...emptyDevelopmentUsage(),
        commandMs: result.durationMs,
        commandOutputBytes: Buffer.byteLength(output)
      });
      if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
        throw new Error("Approved Reviewer check failed");
      }
      return {
        content: redactText(output, this.input.knownSecrets),
        safeMetadata: {
          criterion_id: criterion.id,
          duration_ms: result.durationMs,
          exit_code: result.exitCode
        }
      };
    }
    if (tool === "review.submit") {
      throw new Error("Reviewer result submission is owned by the Pi adapter");
    }
    if (tool === "fix.submit") {
      throw new Error("Fix result submission is owned by the Pi adapter");
    }
    if (tool === "sandbox.write") {
      const input = writeInputSchema.parse(rawInput);
      const path = await this.safeWritePath(input.path);
      await writeFile(path, input.content, { encoding: "utf8", mode: 0o600 });
      return { content: "File written", safeMetadata: { bytes: Buffer.byteLength(input.content), path: input.path } };
    }
    if (tool === "sandbox.edit") {
      const input = editInputSchema.parse(rawInput);
      this.assertWritable(input.path);
      const path = await this.existingPath(input.path);
      const content = await readFile(path, "utf8");
      const first = content.indexOf(input.oldText);
      if (first < 0 || content.indexOf(input.oldText, first + input.oldText.length) >= 0) {
        throw new Error("Edit target must occur exactly once");
      }
      const updated = `${content.slice(0, first)}${input.newText}${content.slice(first + input.oldText.length)}`;
      await writeFile(path, updated, "utf8");
      return { content: "File edited", safeMetadata: { bytes: Buffer.byteLength(updated), path: input.path } };
    }
    if (tool === "sandbox.exec") {
      const input = execInputSchema.parse(rawInput);
      const timeoutMs = Math.min(input.timeoutMs ?? this.input.budget.maxCommandMs, this.input.budget.maxCommandMs);
      const result = await this.input.sandboxManager.execute(this.input.workspace, {
        arguments: input.arguments,
        executable: input.executable,
        maxOutputBytes: this.input.budget.maxCommandOutputBytes,
        timeoutMs,
        ...(signal ? { signal } : {}),
        ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {})
      });
      const outputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      await this.input.onUsage({
        ...emptyDevelopmentUsage(),
        commandMs: result.durationMs,
        commandOutputBytes: outputBytes
      });
      if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
        throw new Error("Sandbox command failed");
      }
      return {
        content: redactText(`${result.stdout}${result.stderr}`, this.input.knownSecrets),
        safeMetadata: {
          duration_ms: result.durationMs,
          executable: input.executable,
          exit_code: result.exitCode,
          output_bytes: outputBytes
        }
      };
    }
    if (tool === "git.status") {
      const content = await this.input.git.status(this.input.workspace.path);
      return { content, safeMetadata: { changed_entries: content.split("\n").filter(Boolean).length } };
    }
    const content = this.role === "reviewer"
      ? await this.input.git.diffCommits(
          this.input.baseCommit!,
          this.input.candidateCommit!,
          this.input.budget.maxDiffBytes
        )
      : await this.input.git.diff(
          this.input.workspace.path,
          this.input.budget.maxDiffBytes
        );
    return { content, safeMetadata: { bytes: Buffer.byteLength(content) } };
  }
}
