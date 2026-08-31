import {
  developmentBudgetSchema,
  developmentContextManifestSchema,
  developmentRoleSchema,
  developmentUsageSchema,
  emptyDevelopmentUsage,
  modelProfileSchema,
  type DevelopmentBudget,
  type DevelopmentContextManifest,
  type DevelopmentReviewResult,
  type DevelopmentRole,
  type DevelopmentUsage,
  type JsonObject,
  type ModelProfile
} from "@personal-agent/shared";
import { z } from "zod";

export const developmentToolNameSchema = z.enum([
  "sandbox.read",
  "sandbox.list",
  "sandbox.search",
  "sandbox.write",
  "sandbox.edit",
  "sandbox.exec",
  "git.status",
  "git.diff",
  "review.run_check",
  "review.submit"
]);
export type DevelopmentToolName = z.infer<typeof developmentToolNameSchema>;

export const implementerToolNames = [
  "sandbox.read",
  "sandbox.list",
  "sandbox.search",
  "sandbox.write",
  "sandbox.edit",
  "sandbox.exec",
  "git.status",
  "git.diff"
] as const satisfies readonly DevelopmentToolName[];

export const reviewerToolNames = [
  "sandbox.read",
  "sandbox.list",
  "sandbox.search",
  "git.status",
  "git.diff",
  "review.run_check",
  "review.submit"
] as const satisfies readonly DevelopmentToolName[];

export type DevelopmentContextSection = {
  content: string;
  path: string;
  source: "authority" | "repository";
};

export type DevelopmentContext = {
  acceptanceCriteria: string;
  allowedPaths: readonly string[];
  baseCommit: string;
  candidateCommit?: string;
  candidateDiff?: string;
  deterministicEvidence?: string;
  budget: DevelopmentBudget;
  digest: string;
  forbiddenPaths: readonly string[];
  manifest: DevelopmentContextManifest;
  remainingBudget: DevelopmentBudget;
  role: DevelopmentRole;
  sections: readonly DevelopmentContextSection[];
  specification: string;
  taskTitle: string;
};

export type DevelopmentToolResult = {
  content: string;
  safeMetadata: JsonObject;
};

export interface DevelopmentToolSet {
  readonly names: readonly DevelopmentToolName[];
  invoke(
    name: DevelopmentToolName,
    input: unknown,
    signal?: AbortSignal
  ): Promise<DevelopmentToolResult>;
}

export type DevelopmentEvent =
  | {
      kind: "execution_started";
      safeMetadata: JsonObject;
    }
  | {
      kind: "tool";
      safeMetadata: JsonObject;
      status: "started" | "success" | "failed";
      tool: DevelopmentToolName;
    }
  | {
      kind: "usage";
      delta: DevelopmentUsage;
      safeMetadata: JsonObject;
    }
  | {
      kind: "completed";
      result: "completion_proposed";
      safeMetadata: JsonObject;
    }
  | {
      kind: "completed";
      result: "review_proposed";
      review: DevelopmentReviewResult;
      safeMetadata: JsonObject;
    }
  | {
      failureClass: "aborted" | "malformed_output" | "provider" | "budget" | "timeout";
      kind: "failed";
      safeMetadata: JsonObject;
    };

export type DevelopmentHarnessInput = {
  attemptId: string;
  budget: DevelopmentBudget;
  context: DevelopmentContext;
  modelProfile: ModelProfile;
  role: DevelopmentRole;
  signal?: AbortSignal;
  tools: DevelopmentToolSet;
};

export type DevelopmentExecution = {
  events: AsyncIterable<DevelopmentEvent>;
  executionId: string;
};

export interface DevelopmentHarness {
  execute(input: DevelopmentHarnessInput): Promise<DevelopmentExecution>;
  abort(executionId: string): Promise<void>;
}

export const developmentHarnessInputSchema = z.object({
  attemptId: z.string().uuid(),
  budget: developmentBudgetSchema,
  context: z.object({
    baseCommit: z.string(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: developmentContextManifestSchema,
    role: developmentRoleSchema
  }),
  modelProfile: modelProfileSchema,
  role: developmentRoleSchema
});

export function zeroUsage(): DevelopmentUsage {
  return developmentUsageSchema.parse(emptyDevelopmentUsage());
}
