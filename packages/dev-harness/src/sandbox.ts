import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  emptyDevelopmentUsage,
  redactText,
  workspaceRelativePathSchema,
  type DevelopmentBudget,
  type DevelopmentUsage,
  type JsonObject
} from "@personal-agent/shared";
import { z } from "zod";
import {
  developmentToolNameSchema,
  implementerToolNames,
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
    await this.docker(["rm", "--volumes", "--force", workspace.containerName], 60_000);
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

function pathMatches(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)
  );
}

export class SandboxGateway implements DevelopmentToolSet {
  readonly names = implementerToolNames;
  private readonly root: string;

  constructor(
    private readonly input: {
      allowedPaths: readonly string[];
      budget: DevelopmentBudget;
      forbiddenPaths: readonly string[];
      git: TrustedGit;
      knownSecrets?: readonly string[];
      onAudit: (input: {
        safeMetadata: JsonObject;
        status: "started" | "success" | "failed";
        tool: DevelopmentToolName;
      }) => Promise<void>;
      onUsage: (delta: DevelopmentUsage) => Promise<void>;
      sandboxManager: SandboxManager;
      workspace: SandboxWorkspace;
    }
  ) {
    this.root = resolve(input.workspace.path);
  }

  private lexicalPath(relativePath: string): string {
    const safePath = workspaceRelativePathSchema.parse(relativePath);
    if (safePath === ".git" || safePath.startsWith(".git/")) {
      throw new Error("Git metadata is not model-readable");
    }
    const absolute = resolve(this.root, safePath);
    assertSandboxPath(this.root, absolute);
    return absolute;
  }

  private async existingPath(relativePath: string): Promise<string> {
    const absolute = this.lexicalPath(relativePath);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error("Symlinks and device-like files are not accessible");
    }
    const canonical = await realpath(absolute);
    assertSandboxPath(this.root, canonical);
    return canonical;
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
    await this.input.onAudit({ safeMetadata: {}, status: "started", tool });
    try {
      const result = await this.executeTool(tool, rawInput, signal);
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
      return { content, safeMetadata: { bytes: Buffer.byteLength(content), path: input.path } };
    }
    if (tool === "sandbox.list") {
      const input = listInputSchema.parse(rawInput);
      const relativePath = input.path ?? "";
      const path = relativePath ? await this.existingPath(relativePath) : this.root;
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.length > 1_000) throw new Error("Directory exceeds listing limit");
      const content = entries
        .filter((entry) => entry.name !== ".git")
        .map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`)
        .join("\n");
      return { content, safeMetadata: { entries: entries.length, path: relativePath || "." } };
    }
    if (tool === "sandbox.search") {
      const input = searchInputSchema.parse(rawInput);
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
    const content = await this.input.git.diff(
      this.input.workspace.path,
      this.input.budget.maxDiffBytes
    );
    return { content, safeMetadata: { bytes: Buffer.byteLength(content) } };
  }
}
