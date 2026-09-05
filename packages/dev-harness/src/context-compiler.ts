import { createHash } from "node:crypto";
import {
  developmentAcceptanceCriteriaSchema,
  developmentBudgetSchema,
  developmentContextManifestSchema,
  developmentReviewFindingSchema,
  developmentUsageSchema,
  gitObjectIdSchema,
  workspaceRelativePathSchema,
  type DevelopmentBudget,
  type DevelopmentUsage
} from "@personal-agent/shared";
import { z } from "zod";
import type { DevelopmentContext, DevelopmentContextSection } from "./contract.js";
import { TrustedGit } from "./git.js";

const authorityPaths = [
  "AGENTS.md",
  "docs/design.md",
  "docs/decisions/0001-pi-development-harness.md",
  "docs/phase-2-implementation-plan.md"
] as const;

const scopedPathSchema = z.union([z.literal("."), workspaceRelativePathSchema]);

function remainingBudget(budget: DevelopmentBudget, usage: DevelopmentUsage): DevelopmentBudget {
  if (
    usage.modelInvocations >= budget.maxModelInvocations ||
    usage.inputTokens + usage.outputTokens >= budget.maxTokens ||
    usage.toolCalls >= budget.maxToolCalls ||
    usage.commandMs >= budget.maxWallClockMs ||
    usage.costUsdMicros > budget.maxCostUsdMicros
  ) {
    throw new Error("Development attempt has no remaining execution budget");
  }
  return {
    ...budget,
    maxCostUsdMicros: Math.max(0, budget.maxCostUsdMicros - usage.costUsdMicros),
    maxModelInvocations: budget.maxModelInvocations - usage.modelInvocations,
    maxTokens: budget.maxTokens - usage.inputTokens - usage.outputTokens,
    maxToolCalls: budget.maxToolCalls - usage.toolCalls,
    maxWallClockMs: budget.maxWallClockMs - usage.commandMs
  };
}

export class DevelopmentContextCompiler {
  constructor(private readonly git: TrustedGit) {}

  async compile(input: {
    acceptanceCriteria: unknown;
    allowedPaths: readonly string[];
    authorityBaseCommit?: string;
    baseCommit: string;
    budget: unknown;
    fix?: {
      findings: unknown;
      iteration: number;
      sourceReviewId: string;
    };
    forbiddenPaths: readonly string[];
    relevantPaths: readonly string[];
    specification: string;
    taskTitle: string;
    usage: unknown;
  }): Promise<DevelopmentContext> {
    const baseCommit = gitObjectIdSchema.parse(input.baseCommit);
    const authorityBaseCommit = gitObjectIdSchema.parse(input.authorityBaseCommit ?? baseCommit);
    const budget = developmentBudgetSchema.parse(input.budget);
    const usage = developmentUsageSchema.parse(input.usage);
    const acceptanceCriteria = developmentAcceptanceCriteriaSchema.parse(input.acceptanceCriteria);
    const allowedPaths = z.array(scopedPathSchema).min(1).max(64).parse(input.allowedPaths);
    const forbiddenPaths = z.array(scopedPathSchema).max(64).parse(input.forbiddenPaths);
    const relevantPaths = z
      .array(workspaceRelativePathSchema)
      .max(64)
      .parse(input.relevantPaths);
    const fix = input.fix
      ? {
          findings: z.array(developmentReviewFindingSchema).min(1).max(64).parse(input.fix.findings),
          iteration: z.number().int().min(1).max(3).parse(input.fix.iteration),
          rejectedCandidateCommit: baseCommit,
          sourceReviewId: z.string().uuid().parse(input.fix.sourceReviewId)
        }
      : undefined;
    const selectedPaths = [...new Set([...authorityPaths, ...relevantPaths])];
    const sections: DevelopmentContextSection[] = [];
    const entries = [];
    let totalBytes = 0;

    for (const path of selectedPaths) {
      const source = authorityPaths.includes(path as (typeof authorityPaths)[number])
        ? "authority"
        : "repository";
      const blob = await this.git.readBlob(
        source === "authority" ? authorityBaseCommit : baseCommit,
        path
      );
      const bytes = Buffer.byteLength(blob.content);
      totalBytes += bytes;
      if (totalBytes > budget.maxContextBytes) {
        throw new Error("Compiled development context exceeds the approved byte budget");
      }
      sections.push({ content: blob.content, path, source });
      entries.push({ blobId: blob.blobId, bytes, path, source });
    }

    const acceptanceCriteriaText = JSON.stringify(acceptanceCriteria);
    const candidateDiff = fix
      ? await this.git.diffRange(authorityBaseCommit, baseCommit, budget.maxDiffBytes)
      : undefined;
    const metadataBytes = Buffer.byteLength(
      input.taskTitle +
        input.specification +
        acceptanceCriteriaText +
        JSON.stringify(fix ?? {}) +
        (candidateDiff ?? "")
    );
    if (totalBytes + metadataBytes > budget.maxContextBytes) {
      throw new Error("Task metadata and selected files exceed the approved context byte budget");
    }
    const manifest = developmentContextManifestSchema.parse({ entries, totalBytes });
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          acceptanceCriteria,
          allowedPaths,
          authorityBaseCommit,
          baseCommit,
          budget,
          fix,
          forbiddenPaths,
          manifest,
          role: "implementer",
          specification: input.specification,
          taskTitle: input.taskTitle
        })
      )
      .digest("hex");

    return {
      acceptanceCriteria: acceptanceCriteriaText,
      allowedPaths,
      baseCommit,
      budget,
      ...(candidateDiff ? { candidateDiff } : {}),
      digest,
      ...(fix ? { fix } : {}),
      forbiddenPaths,
      manifest,
      remainingBudget: remainingBudget(budget, usage),
      role: "implementer",
      sections,
      specification: input.specification,
      taskTitle: input.taskTitle
    };
  }
}
