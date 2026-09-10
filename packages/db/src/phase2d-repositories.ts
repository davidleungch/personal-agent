import { createHash, randomUUID } from "node:crypto";
import {
  createSecretFreeJsonSchema,
  createSecretFreeTextSchema,
  gitObjectIdSchema,
  isDurableJson,
  phase2dActionStatusSchema,
  phase2dCiActionKindSchema,
  phase2dCiReceiptSchema,
  phase2dRetryClassSchema,
  developmentReviewerContextManifestSchema,
  type JsonObject,
} from "@personal-agent/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import {
  ciValidationActions,
  ciValidations,
  developmentReleases,
  developmentReviews,
  phase2dEnvironments,
  phase2dPolicies
} from "./schema.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const commit = gitObjectIdSchema;
const targetRef = z.literal("refs/heads/main");
const shortText = z.string().trim().min(1).max(500);
export class Phase2DAuthorityError extends Error {}
export class Phase2DLeaseError extends Error {}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertAuthorityCatalog(review: typeof developmentReviews.$inferSelect, policy: typeof phase2dPolicies.$inferSelect): void {
  const manifest = developmentReviewerContextManifestSchema.parse(review.contextManifest);
  const authorityBlobs = manifest.entries
    .filter((entry) => entry.source === "authority")
    .map((entry) => ({ blobId: entry.blobId, path: entry.path }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (policy.authorityCatalogDigest !== canonicalDigest(authorityBlobs)) {
    throw new Phase2DAuthorityError("Review authority catalog is stale");
  }
}

export type Phase2DRepositories = ReturnType<typeof createPhase2DRepositories>;

export function createPhase2DRepositories(database: Database, knownSecrets: readonly string[] = []) {
  const secretFreeText = createSecretFreeTextSchema(knownSecrets);
  const metadataSchema = createSecretFreeJsonSchema(knownSecrets)
    .refine((value) => JSON.stringify(value).length <= 8_192, "Metadata is too large")
    .refine(isDurableJson, "Metadata is not safe durable JSON");

  const policyInput = z.object({
    authorityCatalogDigest: digest,
    environmentId: shortText,
    policyDigest: digest,
    policyRevision: shortText,
    requiredChecks: z.array(shortText).min(1).max(128).refine(
      (checks) => new Set(checks).size === checks.length,
      "Required CI checks must be unique"
    ),
    remoteUrl: shortText,
    repositoryId: shortText,
    requiredChecksDigest: digest,
    targetRef
  }).strict();

  return {
    createPolicy: async (input: z.input<typeof policyInput>) => {
      const value = policyInput.parse(input);
      const now = new Date();
      return database.transaction(async (transaction) => {
        const [policy] = await transaction.insert(phase2dPolicies).values({
          authorityCatalogDigest: value.authorityCatalogDigest,
          createdAt: now,
          environmentId: value.environmentId,
          id: randomUUID(),
          policyDigest: value.policyDigest,
          policyRevision: value.policyRevision,
          remoteUrl: secretFreeText.parse(value.remoteUrl),
          repositoryId: secretFreeText.parse(value.repositoryId),
          requiredChecksDigest: value.requiredChecksDigest,
          requiredCheckNames: value.requiredChecks,
          targetRef: value.targetRef,
          updatedAt: now
        }).returning();
        await transaction.insert(phase2dEnvironments).values({
          environmentId: value.environmentId,
          id: randomUUID(),
          policyId: policy!.id
        });
        return policy!;
      });
    },

    setPolicyEnabled: async (input: { enabled: boolean; policyId: string }) => {
      const policyId = uuid.parse(input.policyId);
      return database.transaction(async (transaction) => {
        const [policy] = await transaction.select().from(phase2dPolicies).where(eq(phase2dPolicies.id, policyId)).limit(1).for("update");
        if (!policy) throw new Phase2DAuthorityError("Phase 2D policy does not exist");
        const [updated] = await transaction.update(phase2dPolicies)
          .set({ enabled: input.enabled, updatedAt: new Date() })
          .where(eq(phase2dPolicies.id, policyId))
          .returning();
        return updated;
      });
    },

    createCiValidation: async (input: {
      attemptId: string;
      candidateCommit: string;
      candidateRef: string;
      policyId: string;
      reviewId: string;
      taskId: string;
      validationId?: string;
    }) => {
      const value = z.object({
        attemptId: uuid,
        candidateCommit: commit,
        candidateRef: z.string().regex(/^refs\/personal-agent\/development-attempts\/[0-9a-f-]{36}$/),
        policyId: uuid,
        reviewId: uuid,
        taskId: uuid,
        validationId: shortText.optional()
      }).strict().parse(input);
      return database.transaction(async (transaction) => {
        const policy = (await transaction.select().from(phase2dPolicies).where(eq(phase2dPolicies.id, value.policyId)).limit(1))[0];
        if (!policy || !policy.enabled) throw new Phase2DAuthorityError("Phase 2D policy is disabled");
        const review = (await transaction.select().from(developmentReviews).where(eq(developmentReviews.id, value.reviewId)).limit(1))[0];
        if (!review) throw new Phase2DAuthorityError("Candidate review does not exist");
        assertAuthorityCatalog(review, policy);
        const stableValidationId = canonicalDigest({
          candidateCommit: value.candidateCommit,
          policyDigest: policy.policyDigest,
          repositoryId: policy.repositoryId,
          requiredChecksDigest: policy.requiredChecksDigest
        });
        if (value.validationId && value.validationId !== stableValidationId) {
          throw new Phase2DAuthorityError("Validation identity is not deterministic");
        }
        const validationRowId = randomUUID();
        await transaction.execute(sql`select * from public.phase2d_create_ci_validation(
          ${validationRowId}::uuid, ${stableValidationId}, ${value.taskId}::uuid,
          ${value.attemptId}::uuid, ${value.reviewId}::uuid, ${value.policyId}::uuid,
          ${value.candidateCommit}, ${value.candidateRef}
        )`);
        const [validation] = await transaction.select().from(ciValidations).where(eq(ciValidations.validationId, stableValidationId)).limit(1);
        return validation!;
      });
    },

    claimCiValidation: async (input: { runnerId: string; validationId: string }) => {
      const value = z.object({ runnerId: shortText, validationId: uuid }).parse(input);
      secretFreeText.parse(value.runnerId);
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select * from public.phase2d_claim_ci_validation(${value.validationId}::uuid, ${value.runnerId})`);
        const [updated] = await transaction.select().from(ciValidations).where(eq(ciValidations.id, value.validationId)).limit(1);
        return updated!;
      });
    },

    heartbeatCiValidation: async (input: { runnerId: string; validationId: string; leaseGeneration: number }) => {
      const value = z.object({ leaseGeneration: z.number().int().positive(), runnerId: shortText, validationId: uuid }).parse(input);
      secretFreeText.parse(value.runnerId);
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select * from public.phase2d_heartbeat_ci_validation(${value.validationId}::uuid, ${value.runnerId}, ${value.leaseGeneration})`);
        const [updated] = await transaction.select().from(ciValidations).where(eq(ciValidations.id, value.validationId)).limit(1);
        return updated!;
      });
    },

    appendCiValidationAction: async (input: {
      actionKey: string;
      kind: string;
      leaseGeneration: number;
      metadata?: JsonObject;
      retryClass: string;
      runnerId: string;
      status: string;
      validationId: string;
    }) => {
      const value = z.object({
        actionKey: shortText,
        kind: phase2dCiActionKindSchema,
        leaseGeneration: z.number().int().positive(),
        metadata: metadataSchema.optional(),
        retryClass: phase2dRetryClassSchema,
        runnerId: shortText,
        status: phase2dActionStatusSchema.exclude(["not_started"]),
        validationId: uuid
      }).strict().parse(input);
      secretFreeText.parse(value.actionKey);
      secretFreeText.parse(value.runnerId);
      return database.transaction(async (transaction) => {
        if (value.status === "started") {
          await transaction.execute(sql`select * from public.phase2d_ci_action_intent(
            ${randomUUID()}::uuid, ${value.validationId}::uuid, ${value.runnerId}, ${value.leaseGeneration},
            ${value.actionKey}, ${value.kind}, ${value.retryClass}, ${value.metadata ?? {}}::jsonb
          )`);
        } else {
          await transaction.execute(sql`select * from public.phase2d_ci_action_outcome(
            ${randomUUID()}::uuid, ${value.validationId}::uuid, ${value.runnerId}, ${value.leaseGeneration},
            ${value.actionKey}, ${value.status}, ${value.retryClass}, NULL::jsonb, ${value.metadata ?? {}}::jsonb
          )`);
        }
        const [action] = await transaction.select().from(ciValidationActions)
          .where(and(
            eq(ciValidationActions.validationId, value.validationId),
            eq(ciValidationActions.actionKey, value.status === "started" ? value.actionKey : `${value.actionKey}/outcome`)
          ))
          .orderBy(asc(ciValidationActions.sequence)).limit(1);
        return action!;
      });
    },

    issueCiSuccess: async (input: { receipt: unknown; runnerId: string; validationId: string; leaseGeneration: number }) => {
      const receipt = phase2dCiReceiptSchema.parse(createSecretFreeJsonSchema(knownSecrets).parse(input.receipt));
      const value = z.object({ leaseGeneration: z.number().int().positive(), runnerId: shortText, validationId: uuid }).parse(input);
      secretFreeText.parse(value.runnerId);
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select * from public.phase2d_issue_ci_success(
          ${value.validationId}::uuid, ${receipt}::jsonb, ${value.runnerId}, ${value.leaseGeneration}
        )`);
        const [updated] = await transaction.select().from(ciValidations).where(eq(ciValidations.id, value.validationId)).limit(1);
        return updated!;
      });
    },

    failCiValidation: async (input: { failureClass: string; runnerId: string; validationId: string; leaseGeneration: number }) => {
      const value = z.object({ failureClass: shortText, runnerId: shortText, validationId: uuid, leaseGeneration: z.number().int().positive() }).parse(input);
      secretFreeText.parse(value.failureClass);
      secretFreeText.parse(value.runnerId);
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select * from public.phase2d_fail_ci_validation(
          ${value.validationId}::uuid, ${value.runnerId}, ${value.leaseGeneration}, ${value.failureClass}
        )`);
        const [updated] = await transaction.select().from(ciValidations).where(eq(ciValidations.id, value.validationId)).limit(1);
        return updated!;
      });
    },

    admitRelease: async (input: { environmentId: string; policyId: string; runnerId: string; validationId: string }) => {
      const value = z.object({ environmentId: shortText, policyId: uuid, runnerId: shortText, validationId: uuid }).parse(input);
      secretFreeText.parse(value.environmentId);
      secretFreeText.parse(value.runnerId);
      return database.transaction(async (transaction) => {
        const operationId = randomUUID();
        const releaseId = randomUUID();
        await transaction.execute(sql`select * from public.phase2d_admit_release(
          ${releaseId}::uuid, ${operationId}, ${value.environmentId}, ${value.policyId}::uuid,
          ${value.validationId}::uuid, ${value.runnerId}
        )`);
        const [release] = await transaction.select().from(developmentReleases).where(eq(developmentReleases.validationId, value.validationId)).limit(1);
        return release!;
      });
    },

    getCiValidation: async (validationId: string) => (await database.select().from(ciValidations).where(eq(ciValidations.id, uuid.parse(validationId))).limit(1))[0],
    getDevelopmentRelease: async (releaseId: string) => (await database.select().from(developmentReleases).where(eq(developmentReleases.id, uuid.parse(releaseId))).limit(1))[0],
    listCiValidationActions: async (validationId: string) => database.select().from(ciValidationActions).where(eq(ciValidationActions.validationId, uuid.parse(validationId))).orderBy(asc(ciValidationActions.sequence))
  };
}
