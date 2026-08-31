import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  developmentHarnessInputSchema,
  developmentToolNameSchema,
  implementerToolNames,
  zeroUsage
} from "../src/contract";
import { DevelopmentContextCompiler } from "../src/context-compiler";
import { ReviewerContextCompiler } from "../src/reviewer-context-compiler";
import { TrustedGit } from "../src/git";
import { requireProcess, runProcess } from "../src/process";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function fixtureRepository(): Promise<{ commit: string; path: string; workspaces: string }> {
  const path = await mkdtemp(join(tmpdir(), "personal-agent-context-"));
  temporaryDirectories.push(path);
  await mkdir(join(path, "docs/decisions"), { recursive: true });
  await mkdir(join(path, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(path, "AGENTS.md"), "agents"),
    writeFile(
      join(path, "docs/design.md"),
      "# Design\n\n```md\n# Not Governing In A Fence\n~~~md\n## Still Not Governing\n```\n\n~~~md\n## Also Not Governing\n~~~\n\n## Design-1\n\n## Design\n"
    ),
    writeFile(join(path, "docs/decisions/0001-pi-development-harness.md"), "adr"),
    writeFile(
      join(path, "docs/phase-2-implementation-plan.md"),
      "# Phase 2\n\n## Phase 2B\n\n### Contract\nReview only.\n\n## Phase 2C\n\n### Contract\nFix loop.\n\n## Phase 2D\n\n### Contract\nMerge.\n"
    ),
    writeFile(join(path, "src/relevant.ts"), "export const relevant = true;\n")
  ]);
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "base"],
    { cwd: path }
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  return { commit, path, workspaces: join(path, "workspaces") };
}

const budget = {
  maxCommandMs: 1_000,
  maxCommandOutputBytes: 10_000,
  maxContextBytes: 100_000,
  maxCostUsdMicros: 1_000,
  maxDiffBytes: 10_000,
  maxModelInvocations: 2,
  maxTokens: 1_000,
  maxToolCalls: 3,
  maxWallClockMs: 10_000,
  maxWorkspaceBytes: 100_000
};
const usage = {
  commandMs: 0,
  commandOutputBytes: 0,
  costUsdMicros: 0,
  inputTokens: 0,
  modelInvocations: 0,
  outputTokens: 0,
  toolCalls: 0
};
const acceptanceCriteria = [
  {
    check: { arguments: ["test"], executable: "pnpm", timeoutMs: 1_000 },
    description: "Tests pass",
    id: "tests"
  }
];

describe("development contract and process boundary", () => {
  it("exposes only the Phase 2A implementer tool contract", () => {
    expect(implementerToolNames).toEqual([
      "sandbox.read",
      "sandbox.list",
      "sandbox.search",
      "sandbox.write",
      "sandbox.edit",
      "sandbox.exec",
      "git.status",
      "git.diff"
    ]);
    expect(developmentToolNameSchema.options).not.toContain("git.commit");
    expect(zeroUsage()).toEqual(usage);
    expect(
      developmentHarnessInputSchema.parse({
        attemptId: "00000000-0000-4000-8000-000000000001",
        budget,
        context: {
          baseCommit: "a".repeat(40),
          digest: "b".repeat(64),
          manifest: { entries: [], totalBytes: 0 },
          role: "implementer"
        },
        modelProfile: "fast",
        role: "implementer"
      }).role
    ).toBe("implementer");
  });

  it("runs argument-vector processes with timeout, output, abort, and error bounds", async () => {
    const success = await runProcess({
      arguments: ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"],
      command: process.execPath,
      maxOutputBytes: 100,
      timeoutMs: 1_000
    });
    expect(success).toMatchObject({ exitCode: 0, stderr: "warn", stdout: "ok", timedOut: false });
    await expect(
      requireProcess({
        arguments: ["-e", "process.stdout.write('required')"],
        command: process.execPath,
        maxOutputBytes: 100,
        timeoutMs: 1_000
      })
    ).resolves.toBe("required");
    await expect(
      requireProcess({
        arguments: ["-e", "process.stderr.write('bad'); process.exit(2)"],
        command: process.execPath,
        maxOutputBytes: 100,
        timeoutMs: 1_000
      })
    ).rejects.toThrow("exit=2");

    const limited = await runProcess({
      arguments: ["-e", "process.stdout.write('x'.repeat(10000))"],
      command: process.execPath,
      maxOutputBytes: 10,
      timeoutMs: 1_000
    });
    expect(limited.outputLimitExceeded).toBe(true);
    expect(limited.stdout).toHaveLength(10);
    const exhausted = await runProcess({
      arguments: ["-e", "process.stdout.write('1234567890'); process.stderr.write('x')"],
      command: process.execPath,
      maxOutputBytes: 10,
      timeoutMs: 1_000
    });
    expect(exhausted.outputLimitExceeded).toBe(true);

    const timed = await runProcess({
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      command: process.execPath,
      maxOutputBytes: 10,
      timeoutMs: 20
    });
    expect(timed.timedOut).toBe(true);

    const controller = new AbortController();
    const aborted = runProcess({
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      command: process.execPath,
      maxOutputBytes: 10,
      signal: controller.signal,
      timeoutMs: 1_000
    });
    controller.abort();
    expect((await aborted).exitCode).not.toBe(0);
    await expect(
      runProcess({
        arguments: [],
        command: "/definitely/not/a/command",
        maxOutputBytes: 10,
        timeoutMs: 100
      })
    ).rejects.toBeDefined();
  });
});

describe("Reviewer Context Compiler", () => {
  it("binds exact candidate diff, source, evidence, and rejects changed or over-budget inputs", async () => {
    const fixture = await fixtureRepository();
    await writeFile(join(fixture.path, "src/relevant.ts"), "export const relevant = 'candidate';\n");
    execFileSync("git", ["add", "src/relevant.ts"], { cwd: fixture.path });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "candidate"], { cwd: fixture.path });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.path, encoding: "utf8" }).trim();
    const compiler = new ReviewerContextCompiler(new TrustedGit(fixture.path, fixture.workspaces));
    const evidence = [{ criterionId: "tests", durationMs: 5, eventId: "00000000-0000-4000-8000-000000000001", status: "success" }];
    const input = {
      acceptanceCriteria,
      baseCommit: fixture.commit,
      budget,
      candidateCommit: candidate,
      contextPolicy: {
        forbiddenPaths: ["src/generated"],
        readablePaths: ["src"],
        relevantPaths: ["src/relevant.ts", "src/relevant.ts"]
      },
      modelProfile: "reasoning",
      specification: "Review relevant.ts",
      taskTitle: "Review relevant change",
      testEvidence: evidence,
      usage
    } as const;
    const context = await compiler.compile(input);
    expect(context).toMatchObject({ candidateCommit: candidate, role: "reviewer" });
    expect(context.candidateDiff).toContain("candidate");
    expect(context.manifest.entries.filter((entry) => entry.path === "src/relevant.ts")).toHaveLength(1);
    const reviewerManifest = context.manifest as typeof context.manifest & {
      authorityReferences: string[];
    };
    expect(reviewerManifest.authorityReferences).toEqual(expect.arrayContaining([
      "docs/design.md#design",
      "docs/design.md#design-1",
      "docs/design.md#design-2"
    ]));
    expect(reviewerManifest.authorityReferences).toEqual(expect.arrayContaining([
      "docs/phase-2-implementation-plan.md#contract",
      "docs/phase-2-implementation-plan.md#contract-1",
      "docs/phase-2-implementation-plan.md#contract-2"
    ]));
    expect(new Set(reviewerManifest.authorityReferences).size).toBe(
      reviewerManifest.authorityReferences.length
    );
    expect(reviewerManifest.authorityReferences).not.toContain(
      "docs/design.md#not-governing-in-a-fence"
    );
    expect(reviewerManifest.authorityReferences).not.toContain(
      "docs/design.md#still-not-governing"
    );
    expect(reviewerManifest.authorityReferences).not.toContain(
      "docs/design.md#also-not-governing"
    );
    const validFinding = {
      acceptanceCriterionId: "tests",
      architectureReference: "docs/design.md#design",
      category: "correctness" as const,
      finding: "Candidate issue",
      relevantPath: "src/relevant.ts",
      requiredCorrection: "Correct it",
      severity: "high" as const
    };
    await expect(compiler.validateFindings(context, [validFinding])).resolves.toBeUndefined();
    for (const architectureReference of [
      "docs/phase-2-implementation-plan.md#contract",
      "docs/phase-2-implementation-plan.md#contract-1",
      "docs/phase-2-implementation-plan.md#contract-2"
    ]) {
      await expect(compiler.validateFindings(context, [
        { ...validFinding, architectureReference }
      ])).resolves.toBeUndefined();
    }
    await expect(compiler.validateFindings(context, [
      { ...validFinding, relevantPath: undefined }
    ])).resolves.toBeUndefined();
    await expect(compiler.validateFindings(context, [{
      ...validFinding, acceptanceCriterionId: "unknown"
    }])).rejects.toThrow("unknown acceptance");
    await expect(compiler.validateFindings(context, [{
      ...validFinding, architectureReference: "n/a"
    }])).rejects.toThrow("heading");
    await expect(compiler.validateFindings(context, [{
      ...validFinding, architectureReference: "docs/design.md #design"
    }])).rejects.toThrow("normalized");
    await expect(compiler.validateFindings(context, [{
      ...validFinding, architectureReference: "docs/design.md#missing"
    }])).rejects.toThrow("nonexistent architecture");
    await expect(compiler.validateFindings(context, [{
      ...validFinding, relevantPath: "AGENTS.md"
    }])).rejects.toThrow("read scope");
    await expect(compiler.validateFindings(context, [{
      ...validFinding, relevantPath: "src/missing.ts"
    }])).rejects.toThrow("not bound");
    await expect(compiler.validateFindings({
      ...context,
      manifest: {
        ...context.manifest,
        entries: context.manifest.entries.map((entry) =>
          entry.path === "src/relevant.ts" ? { ...entry, blobId: "f".repeat(40) } : entry
        )
      }
    }, [validFinding])).rejects.toThrow("changed from the exact candidate");

    await expect(compiler.compile({
      ...input,
      contextPolicy: { ...input.contextPolicy, relevantPaths: ["AGENTS.md"] }
    })).rejects.toThrow("read scope");
    await expect(compiler.compile({
      ...input,
      contextPolicy: { forbiddenPaths: ["src"], readablePaths: ["."], relevantPaths: ["src/relevant.ts"] }
    })).rejects.toThrow("read scope");
    await expect(compiler.compile({ ...input, testEvidence: [] })).rejects.toThrow("missing deterministic");
    await expect(compiler.compile({ ...input, budget: { ...budget, maxContextBytes: 5 } })).rejects.toThrow("byte budget");
    await expect(compiler.compile({ ...input, usage: { ...usage, modelInvocations: budget.maxModelInvocations } })).rejects.toThrow("no remaining");

    execFileSync("git", ["checkout", "--detach", fixture.commit], { cwd: fixture.path, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-q", "-m", "empty"], { cwd: fixture.path });
    const emptyCandidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.path, encoding: "utf8" }).trim();
    await expect(compiler.compile({ ...input, candidateCommit: emptyCandidate })).rejects.toThrow("diff is empty");
  });
});

describe("Development Context Compiler", () => {
  it("reconstructs bounded context and a blob manifest from the exact base", async () => {
    const fixture = await fixtureRepository();
    const git = new TrustedGit(fixture.path, fixture.workspaces);
    const compiler = new DevelopmentContextCompiler(git);
    const context = await compiler.compile({
      acceptanceCriteria,
      allowedPaths: ["src"],
      baseCommit: fixture.commit,
      budget,
      forbiddenPaths: ["src/generated"],
      relevantPaths: ["src/relevant.ts", "src/relevant.ts"],
      specification: "Change relevant.ts",
      taskTitle: "Relevant change",
      usage
    });
    expect(context.sections).toHaveLength(5);
    expect(context.manifest.entries.map((entry) => entry.path)).toContain("src/relevant.ts");
    expect(context.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(context.remainingBudget.maxModelInvocations).toBe(2);
    expect(context.acceptanceCriteria).toContain("Tests pass");
  });

  it("rejects source and task metadata over the context limit", async () => {
    const fixture = await fixtureRepository();
    const compiler = new DevelopmentContextCompiler(new TrustedGit(fixture.path, fixture.workspaces));
    await expect(
      compiler.compile({
        acceptanceCriteria,
        allowedPaths: ["src"],
        baseCommit: fixture.commit,
        budget: { ...budget, maxContextBytes: 5 },
        forbiddenPaths: [],
        relevantPaths: [],
        specification: "small",
        taskTitle: "small",
        usage
      })
    ).rejects.toThrow("byte budget");
    const authorityBytes =
      "agents".length +
      "# Design\n\n```md\n# Not Governing In A Fence\n~~~md\n## Still Not Governing\n```\n\n~~~md\n## Also Not Governing\n~~~\n\n## Design-1\n\n## Design\n".length +
      "adr".length +
      "# Phase 2\n\n## Phase 2B\n\n### Contract\nReview only.\n\n## Phase 2C\n\n### Contract\nFix loop.\n\n## Phase 2D\n\n### Contract\nMerge.\n".length;
    await expect(
      compiler.compile({
        acceptanceCriteria,
        allowedPaths: ["src"],
        baseCommit: fixture.commit,
        budget: { ...budget, maxContextBytes: authorityBytes + 1 },
        forbiddenPaths: [],
        relevantPaths: [],
        specification: "metadata makes this too large",
        taskTitle: "large",
        usage
      })
    ).rejects.toThrow("Task metadata");
  });

  it("rejects every exhausted remaining-budget dimension", async () => {
    const fixture = await fixtureRepository();
    const compiler = new DevelopmentContextCompiler(new TrustedGit(fixture.path, fixture.workspaces));
    const exhausted = [
      { modelInvocations: budget.maxModelInvocations },
      { inputTokens: budget.maxTokens },
      { toolCalls: budget.maxToolCalls },
      { commandMs: budget.maxWallClockMs },
      { costUsdMicros: budget.maxCostUsdMicros + 1 }
    ];
    for (const delta of exhausted) {
      await expect(
        compiler.compile({
          acceptanceCriteria,
          allowedPaths: ["src"],
          baseCommit: fixture.commit,
          budget,
          forbiddenPaths: [],
          relevantPaths: [],
          specification: "bounded",
          taskTitle: "bounded",
          usage: { ...usage, ...delta }
        })
      ).rejects.toThrow("no remaining");
    }
    await expect(
      compiler.compile({
        acceptanceCriteria,
        allowedPaths: ["../escape"],
        baseCommit: fixture.commit,
        budget,
        forbiddenPaths: [],
        relevantPaths: [],
        specification: "bounded",
        taskTitle: "bounded",
        usage
      })
    ).rejects.toBeDefined();
  });
});
