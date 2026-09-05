import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrustedGit, validateCandidateRevision } from "../src/git";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function repository() {
  const path = await mkdtemp(join(tmpdir(), "personal-agent-git-"));
  cleanup.push(path);
  await mkdir(join(path, "src"));
  await writeFile(join(path, "src/value.txt"), "base\n");
  await writeFile(join(path, "README.md"), "readme\n");
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "base"],
    { cwd: path }
  );
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  const workspaces = `${path}-workspaces`;
  cleanup.push(workspaces);
  return { base, git: new TrustedGit(path, workspaces, ["GIT_CANDIDATE_CANARY"]), path, workspaces };
}

let attemptCounter = 0;
function attemptId(): string {
  attemptCounter += 1;
  return `00000000-0000-4000-8000-${String(attemptCounter).padStart(12, "0")}`;
}

describe("trusted Git and worktree authority", () => {
  it("resolves exact commits and reads exact blobs without accepting arbitrary objects", async () => {
    const fixture = await repository();
    await expect(fixture.git.resolveCommit("HEAD")).resolves.toBe(fixture.base);
    await expect(fixture.git.resolveCommit(" ")).rejects.toThrow("invalid");
    await expect(fixture.git.resolveCommit("missing")).rejects.toThrow();
    await expect(fixture.git.readBlob(fixture.base, "src/value.txt")).resolves.toMatchObject({
      blobId: expect.stringMatching(/^[0-9a-f]{40}$/),
      content: "base\n"
    });
    await expect(fixture.git.readBlob(fixture.base, "src")).rejects.toThrow("not a file");
    expect(() => fixture.git.workspacePath("bad")).toThrow("invalid");
    expect(() =>
      validateCandidateRevision({
        baseCommit: fixture.base,
        commit: "c".repeat(40),
        parent: "d".repeat(40)
      })
    ).toThrow("parent");
    expect(() =>
      validateCandidateRevision({
        anchored: "e".repeat(40),
        baseCommit: fixture.base,
        commit: "c".repeat(40),
        parent: fixture.base
      })
    ).toThrow("ref");
    expect(() =>
      validateCandidateRevision({
        anchored: "c".repeat(40),
        baseCommit: fixture.base,
        commit: "c".repeat(40),
        parent: fixture.base
      })
    ).not.toThrow();
  });

  it("creates, recovers, inspects, verifies, and idempotently removes an exact-base worktree", async () => {
    const fixture = await repository();
    const id = attemptId();
    const workspace = await fixture.git.createWorktree(id, fixture.base);
    await expect(fixture.git.createWorktree(id, fixture.base)).resolves.toBe(workspace);
    await expect(fixture.git.verifyWorkspaceBase(workspace, fixture.base)).resolves.toBeUndefined();
    await writeFile(join(workspace, "src/value.txt"), "changed\n");
    await expect(fixture.git.status(workspace)).resolves.toContain("src/value.txt");
    await expect(fixture.git.diff(workspace, 10_000)).resolves.toContain("changed");
    await expect(fixture.git.verifyWorkspaceSize(workspace, 10_000)).resolves.toBeGreaterThan(0);
    await expect(fixture.git.verifyWorkspaceSize(workspace, 1)).rejects.toThrow("byte budget");
    await expect(fixture.git.verifyWorkspaceSize(workspace, 0)).rejects.toThrow("positive integer");
    await expect(fixture.git.verifyWorkspaceSize(workspace, 1.5)).rejects.toThrow("positive integer");
    await fixture.git.removeWorktree(workspace);
    await expect(fixture.git.removeWorktree(workspace)).resolves.toBeUndefined();
    await expect(fixture.git.removeWorktree(fixture.workspaces)).rejects.toThrow("outside");
    await expect(
      fixture.git.removeWorktree(join(fixture.workspaces, "x".repeat(5_000)))
    ).rejects.toBeDefined();
  });

  it("captures and anchors one trusted candidate whose parent is the exact base", async () => {
    const fixture = await repository();
    const id = attemptId();
    const workspace = await fixture.git.createWorktree(id, fixture.base);
    await writeFile(join(workspace, "src/value.txt"), "candidate\n");
    const candidate = await fixture.git.captureCandidate({
      allowedPaths: ["src"],
      attemptId: id,
      baseCommit: fixture.base,
      forbiddenPaths: [],
      maxDiffBytes: 100_000,
      workspacePath: workspace
    });
    expect(candidate.ref).toBe(`refs/personal-agent/development-attempts/${id}`);
    await expect(fixture.git.changedPaths(fixture.base, candidate.commit, 100_000)).resolves.toEqual([
      "src/value.txt"
    ]);
    await expect(fixture.git.diffRange(fixture.base, candidate.commit, 100_000)).resolves.toContain(
      "candidate"
    );
    await expect(fixture.git.treeId(candidate.commit)).resolves.toMatch(/^[0-9a-f]{40}$/);
    await expect(fixture.git.verifyCandidateRef(id, fixture.base, candidate.commit)).resolves.toEqual(candidate);
    await expect(fixture.git.verifyCandidateRef(id, fixture.base, "f".repeat(40))).rejects.toThrow(
      "does not match"
    );
    await fixture.git.removeWorktree(workspace);
    await expect(fixture.git.verifyCandidateRef(id, fixture.base, candidate.commit)).resolves.toEqual(candidate);
    await expect(fixture.git.verifyCandidateRef(attemptId(), fixture.base)).resolves.toBeUndefined();
  });

  it("retains one exact reviewed candidate without making the retention ref identity authority", async () => {
    const fixture = await repository();
    const id = attemptId();
    const workspace = await fixture.git.createWorktree(id, fixture.base);
    await writeFile(join(workspace, "src/value.txt"), "reviewed candidate\n");
    const candidate = await fixture.git.captureCandidate({
      allowedPaths: ["src"],
      attemptId: id,
      baseCommit: fixture.base,
      forbiddenPaths: [],
      maxDiffBytes: 100_000,
      workspacePath: workspace
    });
    const reviewId = attemptId();
    const retained = await fixture.git.ensureReviewRetentionRef(reviewId, candidate.commit);
    expect(retained).toEqual({
      commit: candidate.commit,
      ref: `refs/personal-agent/reviews/${reviewId}`
    });
    await expect(fixture.git.ensureReviewRetentionRef(reviewId, candidate.commit)).resolves.toEqual(retained);
    await fixture.git.removeWorktree(workspace);
    execFileSync("git", ["update-ref", "-d", candidate.ref], { cwd: fixture.path });
    execFileSync("git", ["reflog", "expire", "--expire=now", "--all"], { cwd: fixture.path });
    execFileSync("git", ["gc", "--prune=now"], { cwd: fixture.path });
    await expect(fixture.git.resolveCommit(candidate.commit)).resolves.toBe(candidate.commit);
    await expect(
      fixture.git.verifyReviewRetentionRef(reviewId, candidate.commit)
    ).resolves.toEqual(retained);

    execFileSync("git", ["update-ref", retained.ref, fixture.base], { cwd: fixture.path });
    await expect(
      fixture.git.verifyReviewRetentionRef(reviewId, candidate.commit)
    ).rejects.toThrow("does not match");
    await expect(fixture.git.ensureReviewRetentionRef(reviewId, candidate.commit)).rejects.toThrow(
      "does not match"
    );
    await expect(
      fixture.git.verifyReviewRetentionRef(attemptId(), candidate.commit)
    ).resolves.toBeUndefined();
    expect(() => fixture.git.reviewRetentionRef("bad")).toThrow("invalid");

    execFileSync("git", ["update-ref", "-d", retained.ref], { cwd: fixture.path });
    execFileSync("git", ["reflog", "expire", "--expire=now", "--all"], { cwd: fixture.path });
    execFileSync("git", ["gc", "--prune=now"], { cwd: fixture.path });
    await expect(fixture.git.ensureReviewRetentionRef(reviewId, candidate.commit)).rejects.toBeDefined();

    const namespaceConflict = await repository();
    execFileSync("git", ["update-ref", "refs/personal-agent/reviews", namespaceConflict.base], {
      cwd: namespaceConflict.path
    });
    await expect(
      namespaceConflict.git.ensureReviewRetentionRef(attemptId(), namespaceConflict.base)
    ).rejects.toThrow("corrupt");
  });

  it("rejects empty, out-of-scope, forbidden, generated, native, symlink, and secret candidates", async () => {
    const fixture = await repository();

    const emptyId = attemptId();
    const empty = await fixture.git.createWorktree(emptyId, fixture.base);
    await expect(
      fixture.git.captureCandidate({
        allowedPaths: ["src"],
        attemptId: emptyId,
        baseCommit: fixture.base,
        forbiddenPaths: [],
        maxDiffBytes: 100_000,
        workspacePath: empty
      })
    ).rejects.toThrow("empty");
    await fixture.git.removeWorktree(empty);

    for (const test of [
      { allowed: ["src"], forbidden: [], path: "README.md", message: "out-of-scope" },
      { allowed: ["."], forbidden: ["README.md"], path: "README.md", message: "forbidden" },
      { allowed: ["."], forbidden: [], path: "dist/output.js", message: "generated" },
      { allowed: ["."], forbidden: [], path: "src/addon.node", message: "native" }
    ]) {
      const id = attemptId();
      const workspace = await fixture.git.createWorktree(id, fixture.base);
      await mkdir(join(workspace, test.path, ".."), { recursive: true });
      await writeFile(join(workspace, test.path), "change\n");
      await expect(
        fixture.git.captureCandidate({
          allowedPaths: test.allowed,
          attemptId: id,
          baseCommit: fixture.base,
          forbiddenPaths: test.forbidden,
          maxDiffBytes: 100_000,
          workspacePath: workspace
        })
      ).rejects.toThrow(test.message === "out-of-scope" || test.message === "forbidden" ? "scope" : test.message);
      await fixture.git.removeWorktree(workspace);
    }

    const symlinkId = attemptId();
    const symlinkWorkspace = await fixture.git.createWorktree(symlinkId, fixture.base);
    await symlink("value.txt", join(symlinkWorkspace, "src/link.txt"));
    await expect(
      fixture.git.captureCandidate({
        allowedPaths: ["src"],
        attemptId: symlinkId,
        baseCommit: fixture.base,
        forbiddenPaths: [],
        maxDiffBytes: 100_000,
        workspacePath: symlinkWorkspace
      })
    ).rejects.toThrow("symlink");
    await fixture.git.removeWorktree(symlinkWorkspace);

    const secretId = attemptId();
    const secretWorkspace = await fixture.git.createWorktree(secretId, fixture.base);
    await writeFile(join(secretWorkspace, "src/value.txt"), "GIT_CANDIDATE_CANARY\n");
    await expect(
      fixture.git.captureCandidate({
        allowedPaths: ["src"],
        attemptId: secretId,
        baseCommit: fixture.base,
        forbiddenPaths: [],
        maxDiffBytes: 100_000,
        workspacePath: secretWorkspace
      })
    ).rejects.toThrow("secret");
    await fixture.git.removeWorktree(secretWorkspace);
  });

  it("rejects recovered workspaces and candidate refs that moved away from the exact base", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.path, "README.md"), "second\n");
    execFileSync("git", ["add", "README.md"], { cwd: fixture.path });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "second"],
      { cwd: fixture.path }
    );
    const second = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.path,
      encoding: "utf8"
    }).trim();
    const id = attemptId();
    const workspace = await fixture.git.createWorktree(id, fixture.base);
    execFileSync("git", ["reset", "--hard", second], { cwd: workspace, stdio: "ignore" });
    await expect(fixture.git.verifyWorkspaceBase(workspace, fixture.base)).rejects.toThrow("moved");
    await expect(fixture.git.createWorktree(id, fixture.base)).rejects.toThrow("does not match");
    await fixture.git.removeWorktree(workspace);

    const badRefId = attemptId();
    execFileSync(
      "git",
      ["update-ref", `refs/personal-agent/development-attempts/${badRefId}`, second],
      { cwd: fixture.path }
    );
    await expect(fixture.git.verifyCandidateRef(badRefId, second)).rejects.toThrow("unexpected parent");
    expect(await readFile(join(fixture.path, "README.md"), "utf8")).toBe("second\n");
  });
});
