import { createHash } from "node:crypto";
import {
  developmentAcceptanceCriteriaSchema,
  developmentArchitectureReferenceSchema,
  developmentBudgetSchema,
  developmentReviewerContextManifestSchema,
  developmentReviewerContextPolicySchema,
  developmentReviewFindingSchema,
  developmentUsageSchema,
  gitObjectIdSchema,
  modelProfileSchema,
  workspaceRelativePathSchema,
  type DevelopmentBudget,
  type DevelopmentReviewFinding,
  type DevelopmentUsage
} from "@personal-agent/shared";
import { z } from "zod";
import type { DevelopmentContext, DevelopmentContextSection } from "./contract.js";
import { TrustedGit } from "./git.js";

export const reviewerAuthorityPaths = [
  "AGENTS.md",
  "docs/design.md",
  "docs/decisions/0001-pi-development-harness.md",
  "docs/phase-2-implementation-plan.md"
] as const;

const architectureReferenceSchema = developmentArchitectureReferenceSchema.transform(
  (reference) => {
    const separator = reference.indexOf("#");
    return {
      anchor: reference.slice(separator + 1),
      path: workspaceRelativePathSchema.parse(reference.slice(0, separator))
    };
  }
);
const evidenceSchema = z.array(
  z.object({
    criterionId: z.string().min(1).max(100),
    durationMs: z.number().int().nonnegative(),
    eventId: z.string().uuid(),
    status: z.literal("success")
  }).strict()
).max(32);

function inScope(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)
  );
}

function markdownHeadingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const nextSuffix = new Map<string, number>();
  let fence: "```" | "~~~" | undefined;
  for (const line of content.split("\n")) {
    const fenceMarker = /^\s*(```|~~~)/.exec(line)?.[1] as "```" | "~~~" | undefined;
    if (fenceMarker) {
      if (!fence) fence = fenceMarker;
      else if (fence === fenceMarker) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = heading
      .toLowerCase()
      .replaceAll("`", "")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    let suffix = nextSuffix.get(base) ?? 0;
    let anchor = suffix === 0 ? base : `${base}-${suffix}`;
    while (anchors.has(anchor)) {
      suffix += 1;
      anchor = `${base}-${suffix}`;
    }
    anchors.add(anchor);
    nextSuffix.set(base, suffix + 1);
  }
  return anchors;
}

function remainingBudget(budget: DevelopmentBudget, usage: DevelopmentUsage): DevelopmentBudget {
  if (
    usage.modelInvocations >= budget.maxModelInvocations ||
    usage.inputTokens + usage.outputTokens >= budget.maxTokens ||
    usage.toolCalls >= budget.maxToolCalls ||
    usage.commandMs >= budget.maxWallClockMs ||
    usage.costUsdMicros > budget.maxCostUsdMicros
  ) {
    throw new Error("Reviewer attempt has no remaining execution budget");
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

export type ReviewerTestEvidence = z.infer<typeof evidenceSchema>;

export class ReviewerContextCompiler {
  constructor(private readonly git: TrustedGit) {}

  async compile(input: {
    acceptanceCriteria: unknown;
    baseCommit: string;
    budget: unknown;
    candidateCommit: string;
    contextPolicy: unknown;
    modelProfile: unknown;
    specification: string;
    taskTitle: string;
    testEvidence: unknown;
    usage: unknown;
  }): Promise<DevelopmentContext> {
    const baseCommit = gitObjectIdSchema.parse(input.baseCommit);
    const candidateCommit = gitObjectIdSchema.parse(input.candidateCommit);
    const budget = developmentBudgetSchema.parse(input.budget);
    const usage = developmentUsageSchema.parse(input.usage);
    const acceptanceCriteria = developmentAcceptanceCriteriaSchema.parse(input.acceptanceCriteria);
    const contextPolicy = developmentReviewerContextPolicySchema.parse(input.contextPolicy);
    const modelProfile = modelProfileSchema.parse(input.modelProfile);
    const { forbiddenPaths, readablePaths } = contextPolicy;
    const changedPaths = await this.git.changedPaths(
      baseCommit,
      candidateCommit,
      budget.maxDiffBytes
    );
    const relevantPaths = z.array(workspaceRelativePathSchema).max(64).parse([
      ...new Set([
        ...contextPolicy.relevantPaths,
        ...changedPaths.filter(
          (path) => inScope(path, readablePaths) && !inScope(path, forbiddenPaths)
        )
      ])
    ]);
    for (const path of relevantPaths) {
      if (!inScope(path, readablePaths) || inScope(path, forbiddenPaths)) {
        throw new Error(`Reviewer context path is outside the approved read scope: ${path}`);
      }
    }

    const evidence = evidenceSchema.parse(input.testEvidence);
    const expectedCriterionIds = acceptanceCriteria.map((criterion) => criterion.id).sort();
    const evidenceCriterionIds = [...new Set(evidence.map((item) => item.criterionId))].sort();
    if (JSON.stringify(expectedCriterionIds) !== JSON.stringify(evidenceCriterionIds)) {
      throw new Error("Reviewer context is missing deterministic acceptance evidence");
    }

    const sections: DevelopmentContextSection[] = [];
    const entries: Array<{
      blobId: string;
      bytes: number;
      path: string;
      source: "authority" | "repository";
    }> = [];
    const authorityReferences: string[] = [];
    let sourceBytes = 0;
    for (const path of reviewerAuthorityPaths) {
      const blob = await this.git.readBlob(baseCommit, path);
      const bytes = Buffer.byteLength(blob.content);
      sourceBytes += bytes;
      sections.push({ content: blob.content, path, source: "authority" });
      entries.push({ blobId: blob.blobId, bytes, path, source: "authority" });
      for (const anchor of markdownHeadingAnchors(blob.content)) {
        authorityReferences.push(`${path}#${anchor}`);
      }
    }
    for (const path of [...new Set(relevantPaths)]) {
      const blob = await this.git.readBlob(candidateCommit, path);
      const bytes = Buffer.byteLength(blob.content);
      sourceBytes += bytes;
      sections.push({ content: blob.content, path, source: "repository" });
      entries.push({ blobId: blob.blobId, bytes, path, source: "repository" });
    }

    const candidateDiff = await this.git.diffRange(
      baseCommit,
      candidateCommit,
      budget.maxDiffBytes
    );
    if (candidateDiff.length === 0) throw new Error("Reviewer candidate diff is empty");
    const acceptanceCriteriaText = JSON.stringify(acceptanceCriteria);
    const deterministicEvidence = JSON.stringify(evidence);
    const metadataBytes = Buffer.byteLength(
      input.taskTitle +
        input.specification +
        acceptanceCriteriaText +
        deterministicEvidence +
        candidateDiff
    );
    if (sourceBytes + metadataBytes > budget.maxContextBytes) {
      throw new Error("Compiled Reviewer context exceeds the approved byte budget");
    }
    const manifest = developmentReviewerContextManifestSchema.parse({
      authorityReferences,
      entries,
      totalBytes: sourceBytes
    });
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          acceptanceCriteria,
          baseCommit,
          budget,
          candidateCommit,
          candidateDiff,
          deterministicEvidence: evidence,
          contextPolicy,
          manifest,
          modelProfile,
          role: "reviewer",
          specification: input.specification,
          taskTitle: input.taskTitle
        })
      )
      .digest("hex");

    return {
      acceptanceCriteria: acceptanceCriteriaText,
      allowedPaths: readablePaths,
      baseCommit,
      budget,
      candidateCommit,
      candidateDiff,
      deterministicEvidence,
      digest,
      forbiddenPaths,
      manifest,
      remainingBudget: remainingBudget(budget, usage),
      role: "reviewer",
      sections,
      specification: input.specification,
      taskTitle: input.taskTitle
    };
  }

  async validateFindings(
    context: DevelopmentContext,
    findingsInput: readonly DevelopmentReviewFinding[]
  ): Promise<void> {
    const findings = z.array(developmentReviewFindingSchema).parse(findingsInput);
    const criterionIds = new Set(
      developmentAcceptanceCriteriaSchema.parse(JSON.parse(context.acceptanceCriteria)).map(
        (criterion) => criterion.id
      )
    );
    for (const finding of findings) {
      if (!criterionIds.has(finding.acceptanceCriterionId)) {
        throw new Error("Review finding references an unknown acceptance criterion");
      }
      const reference = architectureReferenceSchema.parse(finding.architectureReference);
      const authority = context.sections.find(
        (section) => section.source === "authority" && section.path === reference.path
      );
      const manifest = developmentReviewerContextManifestSchema.parse(context.manifest);
      if (
        !authority ||
        !markdownHeadingAnchors(authority.content).has(reference.anchor) ||
        !manifest.authorityReferences.includes(finding.architectureReference)
      ) {
        throw new Error("Review finding references a nonexistent architecture authority");
      }
      if (finding.relevantPath) {
        if (
          !inScope(finding.relevantPath, context.allowedPaths) ||
          inScope(finding.relevantPath, context.forbiddenPaths)
        ) {
          throw new Error("Review finding path is outside the approved read scope");
        }
        const manifestEntry = context.manifest.entries.find(
          (entry) => entry.source === "repository" && entry.path === finding.relevantPath
        );
        if (!manifestEntry || !context.candidateCommit) {
          throw new Error("Review finding path is not bound to the exact candidate context");
        }
        const blob = await this.git.readBlob(context.candidateCommit, finding.relevantPath);
        if (blob.blobId !== manifestEntry.blobId) {
          throw new Error("Review finding path changed from the exact candidate context");
        }
      }
    }
  }
}
