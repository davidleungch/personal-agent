import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  gitObjectIdSchema,
  isSecretFreeText,
  workspaceRelativePathSchema
} from "@personal-agent/shared";
import { requireProcess } from "./process.js";

const trustedGitEnvironment: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C.UTF-8",
  PATH: process.env.PATH
};

function inScope(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)
  );
}

function assertManagedPath(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Workspace path is outside the managed development root");
  }
}

export type CandidateRevision = {
  commit: string;
  ref: string;
};

export class TrustedGit {
  constructor(
    private readonly repositoryPath: string,
    private readonly workspaceRoot: string,
    private readonly knownSecrets: readonly string[] = []
  ) {}

  private git(
    arguments_: readonly string[],
    options: { cwd?: string; maxOutputBytes?: number; timeoutMs?: number; trimOutput?: boolean } = {}
  ): Promise<string> {
    return requireProcess({
      arguments: arguments_,
      command: "git",
      cwd: options.cwd ?? this.repositoryPath,
      environment: trustedGitEnvironment,
      maxOutputBytes: options.maxOutputBytes ?? 10_000_000,
      timeoutMs: options.timeoutMs ?? 120_000
    }, options.trimOutput ?? true);
  }

  async resolveCommit(reference: string): Promise<string> {
    if (reference.trim().length === 0 || reference.length > 500) {
      throw new Error("Git reference is invalid");
    }
    return gitObjectIdSchema.parse(await this.git(["rev-parse", "--verify", `${reference}^{commit}`]));
  }

  async readBlob(commit: string, path: string): Promise<{ blobId: string; content: string }> {
    const objectId = gitObjectIdSchema.parse(commit);
    const safePath = workspaceRelativePathSchema.parse(path);
    const object = `${objectId}:${safePath}`;
    const type = await this.git(["cat-file", "-t", object]);
    if (type !== "blob") throw new Error(`Context path is not a file: ${safePath}`);
    const blobId = gitObjectIdSchema.parse(await this.git(["rev-parse", object]));
    const content = await this.git(["show", object], {
      maxOutputBytes: 2_000_000,
      trimOutput: false
    });
    return { blobId, content };
  }

  workspacePath(attemptId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(attemptId)) throw new Error("Attempt ID is invalid");
    const path = resolve(this.workspaceRoot, attemptId);
    assertManagedPath(this.workspaceRoot, path);
    return path;
  }

  async createWorktree(attemptId: string, baseCommit: string): Promise<string> {
    const base = gitObjectIdSchema.parse(baseCommit);
    const workspacePath = this.workspacePath(attemptId);
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    try {
      await stat(workspacePath);
      const head = await this.git(["rev-parse", "HEAD"], { cwd: workspacePath });
      if (head !== base) throw new Error("Recovered workspace does not match the recorded base");
      return workspacePath;
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
    await this.git(["worktree", "add", "--detach", workspacePath, base]);
    await this.verifyWorkspaceBase(workspacePath, base);
    return workspacePath;
  }

  async verifyWorkspaceBase(workspacePath: string, baseCommit: string): Promise<void> {
    assertManagedPath(this.workspaceRoot, workspacePath);
    const canonicalRoot = await realpath(this.workspaceRoot);
    const canonicalWorkspace = await realpath(workspacePath);
    assertManagedPath(canonicalRoot, canonicalWorkspace);
    const head = await this.git(["rev-parse", "HEAD"], { cwd: canonicalWorkspace });
    if (head !== gitObjectIdSchema.parse(baseCommit)) {
      throw new Error("Workspace HEAD moved away from the recorded base commit");
    }
  }

  async status(workspacePath: string): Promise<string> {
    assertManagedPath(this.workspaceRoot, workspacePath);
    return this.git(["status", "--short", "--untracked-files=all"], {
      cwd: workspacePath,
      trimOutput: false
    });
  }

  async diff(workspacePath: string, maxOutputBytes: number): Promise<string> {
    assertManagedPath(this.workspaceRoot, workspacePath);
    return this.git(["diff", "--no-ext-diff", "--binary", "--"], {
      cwd: workspacePath,
      maxOutputBytes,
      trimOutput: false
    });
  }

  async verifyWorkspaceSize(workspacePath: string, maxBytes: number): Promise<number> {
    assertManagedPath(this.workspaceRoot, workspacePath);
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Workspace byte limit must be a positive integer");
    }
    const paths = (
      await this.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: workspacePath,
        maxOutputBytes: 10_000_000,
        trimOutput: false
      })
    )
      .split("\0")
      .filter(Boolean);
    let bytes = 0;
    for (const path of paths) {
      workspaceRelativePathSchema.parse(path);
      const metadata = await lstat(resolve(workspacePath, path));
      bytes += metadata.size;
      if (bytes > maxBytes) throw new Error("Workspace exceeds the approved byte budget");
    }
    return bytes;
  }

  async captureCandidate(input: {
    allowedPaths: readonly string[];
    attemptId: string;
    baseCommit: string;
    forbiddenPaths: readonly string[];
    maxDiffBytes: number;
    workspacePath: string;
  }): Promise<CandidateRevision> {
    await this.verifyWorkspaceBase(input.workspacePath, input.baseCommit);
    const status = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: input.workspacePath,
      maxOutputBytes: input.maxDiffBytes,
      trimOutput: false
    });
    const changedPaths = status
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3).split(" -> ").at(-1)!);
    if (changedPaths.length === 0) throw new Error("Candidate diff is empty");

    for (const path of changedPaths) {
      workspaceRelativePathSchema.parse(path);
      if (!inScope(path, input.allowedPaths) || inScope(path, input.forbiddenPaths)) {
        throw new Error(`Candidate changed a forbidden or out-of-scope path: ${path}`);
      }
      if (
        path === "node_modules" ||
        path.includes("/node_modules/") ||
        path.startsWith("dist/") ||
        path.includes("/dist/") ||
        path.startsWith(".next/") ||
        /\.(?:node|o|a|so|dylib|dll|exe)$/i.test(path)
      ) {
        throw new Error(`Candidate contains generated or native output: ${path}`);
      }
    }

    await this.git(["add", "--all", "--", ...input.allowedPaths], { cwd: input.workspacePath });
    const stagedPaths = (
      await this.git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
        cwd: input.workspacePath,
        maxOutputBytes: input.maxDiffBytes,
        trimOutput: false
      })
    )
      .split("\0")
      .filter(Boolean);
    const modes = await this.git(["ls-files", "--stage", "--", ...stagedPaths], {
      cwd: input.workspacePath,
      maxOutputBytes: input.maxDiffBytes,
      trimOutput: false
    });
    if (modes.split("\n").some((line) => line.startsWith("120000 ") || line.startsWith("160000 "))) {
      throw new Error("Candidate contains a symlink or submodule change");
    }

    const stagedDiff = await this.git(["diff", "--cached", "--no-ext-diff", "--binary", "--"], {
      cwd: input.workspacePath,
      maxOutputBytes: input.maxDiffBytes,
      trimOutput: false
    });
    if (!isSecretFreeText(stagedDiff, this.knownSecrets)) {
      throw new Error("Candidate contains recognized or configured secret material");
    }

    await this.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Personal Agent Development Runner",
        "-c",
        "user.email=development-runner@localhost",
        "commit",
        "--no-gpg-sign",
        "-m",
        `Phase 2A candidate ${input.attemptId}`
      ],
      { cwd: input.workspacePath }
    );
    const commit = gitObjectIdSchema.parse(
      await this.git(["rev-parse", "HEAD"], { cwd: input.workspacePath })
    );
    const parent = await this.git(["rev-parse", "HEAD^"], { cwd: input.workspacePath });
    validateCandidateRevision({ baseCommit: input.baseCommit, commit, parent });

    const ref = `refs/personal-agent/development-attempts/${input.attemptId}`;
    await this.git(["update-ref", ref, commit]);
    const anchored = await this.git(["rev-parse", "--verify", ref]);
    validateCandidateRevision({ anchored, baseCommit: input.baseCommit, commit, parent });
    return { commit, ref };
  }

  async verifyCandidateRef(
    attemptId: string,
    baseCommit: string,
    expectedCommit?: string
  ): Promise<CandidateRevision | undefined> {
    const ref = `refs/personal-agent/development-attempts/${attemptId}`;
    let commit: string;
    try {
      commit = gitObjectIdSchema.parse(await this.git(["rev-parse", "--verify", `${ref}^{commit}`]));
    } catch {
      return undefined;
    }
    if (expectedCommit && commit !== expectedCommit) {
      throw new Error("Database candidate does not match the trusted Git ref");
    }
    const parent = await this.git(["rev-parse", `${commit}^`]);
    if (parent !== gitObjectIdSchema.parse(baseCommit)) {
      throw new Error("Trusted candidate ref has an unexpected parent");
    }
    return { commit, ref };
  }

  async removeWorktree(workspacePath: string): Promise<void> {
    assertManagedPath(this.workspaceRoot, workspacePath);
    try {
      await stat(workspacePath);
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        await this.git(["worktree", "prune"]);
        return;
      }
      throw error;
    }
    await this.git(["worktree", "remove", "--force", workspacePath]);
    await this.git(["worktree", "prune"]);
  }
}

export function validateCandidateRevision(input: {
  anchored?: string;
  baseCommit: string;
  commit: string;
  parent: string;
}): void {
  if (input.parent !== input.baseCommit) {
    throw new Error("Candidate parent is not the recorded base");
  }
  if (input.anchored !== undefined && input.anchored !== input.commit) {
    throw new Error("Trusted candidate ref does not match the candidate");
  }
}
