import { createHash, randomUUID } from "node:crypto";
import {
  createDatabase,
  createPhase2DRepositories,
  migrateDatabase,
  type Database
} from "@personal-agent/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPhase2DCandidateFixture } from "./phase2d-fixture";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

let database: Database;
let pool: Pool;
let closeDatabase: () => Promise<void>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

beforeAll(async () => {
  const reset = new Pool({ connectionString: databaseUrl });
  await reset.query("drop schema public cascade");
  await reset.query("drop schema if exists drizzle cascade");
  await reset.query("create schema public");
  await reset.end();
  await migrateDatabase(databaseUrl, new URL("../../db/migrations", import.meta.url).pathname);
  const connection = createDatabase(databaseUrl);
  database = connection.database;
  pool = connection.pool;
  closeDatabase = connection.close;
});

afterAll(async () => {
  await closeDatabase();
});

describe("Phase 2D M1 durable gates", () => {
  it("binds exact review evidence, CI receipt, action journal, and admission", async () => {
    const fixture = await createPhase2DCandidateFixture(database);
    try {
      const approved = await fixture.approve();
      const manifestEntries = approved.context.manifest.entries
        .filter((entry) => entry.source === "authority")
        .map((entry) => ({ blobId: entry.blobId, path: entry.path }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const requiredChecks = ["lint", "test", "coverage"];
      const phase2d = createPhase2DRepositories(database, ["PHASE2D_CANARY"]);
      const policy = await phase2d.createPolicy({
        authorityCatalogDigest: digest(manifestEntries),
        environmentId: "local-main",
        policyDigest: "a".repeat(64),
        policyRevision: "phase2d-m1-v1",
        requiredChecks,
        remoteUrl: "https://example.invalid/personal-agent.git",
        repositoryId: "fixture-repository",
        requiredChecksDigest: digest(requiredChecks),
        targetRef: "refs/heads/main"
      });
      const stalePolicy = await phase2d.createPolicy({
        authorityCatalogDigest: "e".repeat(64),
        environmentId: "stale-main",
        policyDigest: "f".repeat(64),
        policyRevision: "phase2d-m1-stale",
        requiredChecks,
        remoteUrl: "https://example.invalid/stale.git",
        repositoryId: "stale-repository",
        requiredChecksDigest: digest(requiredChecks),
        targetRef: "refs/heads/main"
      });
      await phase2d.setPolicyEnabled({ enabled: true, policyId: stalePolicy.id });
      await expect(phase2d.createCiValidation({
        attemptId: fixture.attemptId,
        candidateCommit: fixture.candidate.commit,
        candidateRef: fixture.candidate.ref,
        policyId: stalePolicy.id,
        reviewId: approved.review.id,
        taskId: fixture.task.id
      })).rejects.toThrow("authority catalog is stale");
      await expect(phase2d.createCiValidation({
        attemptId: fixture.attemptId,
        candidateCommit: fixture.candidate.commit,
        candidateRef: fixture.candidate.ref,
        policyId: stalePolicy.id,
        reviewId: randomUUID(),
        taskId: fixture.task.id
      })).rejects.toThrow("Candidate review does not exist");
      await expect(phase2d.createCiValidation({
        attemptId: fixture.attemptId,
        candidateCommit: fixture.candidate.commit,
        candidateRef: fixture.candidate.ref,
        policyId: policy.id,
        reviewId: approved.review.id,
        taskId: fixture.task.id
      })).rejects.toThrow("policy is disabled");
      await phase2d.setPolicyEnabled({ enabled: true, policyId: policy.id });
      await expect(phase2d.setPolicyEnabled({ enabled: true, policyId: randomUUID() })).rejects.toThrow("policy does not exist");

      const validation = await phase2d.createCiValidation({
        attemptId: fixture.attemptId,
        candidateCommit: fixture.candidate.commit,
        candidateRef: fixture.candidate.ref,
        policyId: policy.id,
        reviewId: approved.review.id,
        taskId: fixture.task.id
      });
      await expect(phase2d.createCiValidation({
        attemptId: fixture.attemptId,
        candidateCommit: fixture.candidate.commit,
        candidateRef: fixture.candidate.ref,
        policyId: policy.id,
        reviewId: approved.review.id,
        taskId: fixture.task.id,
        validationId: validation.validationId
      })).resolves.toMatchObject({ id: validation.id, validationId: validation.validationId });
      await expect(phase2d.createCiValidation({
        attemptId: fixture.attemptId,
        candidateCommit: fixture.candidate.commit,
        candidateRef: fixture.candidate.ref,
        policyId: policy.id,
        reviewId: approved.review.id,
        taskId: fixture.task.id,
        validationId: "wrong-validation-id"
      })).rejects.toThrow("deterministic");

      const runnerId = "ci-runner-1";
      const claimed = await phase2d.claimCiValidation({ runnerId, validationId: validation.id });
      await expect(phase2d.heartbeatCiValidation({
        leaseGeneration: claimed.leaseGeneration,
        runnerId,
        validationId: validation.id
      })).resolves.toMatchObject({ status: "running" });
      await phase2d.appendCiValidationAction({
        actionKey: "workflow/main",
        kind: "trigger",
        leaseGeneration: claimed.leaseGeneration,
        metadata: { workflow: "phase2d-m1" },
        retryClass: "retry_safe",
        runnerId,
        status: "started",
        validationId: validation.id
      });
      const action = await phase2d.appendCiValidationAction({
        actionKey: "workflow/main",
        kind: "trigger",
        leaseGeneration: claimed.leaseGeneration,
        retryClass: "retry_safe",
        runnerId,
        status: "success",
        validationId: validation.id
      });
      expect(action.status).toBe("success");
      await phase2d.appendCiValidationAction({
        actionKey: "observe/status",
        kind: "observation",
        leaseGeneration: claimed.leaseGeneration,
        retryClass: "no_automatic_retry",
        runnerId,
        status: "started",
        validationId: validation.id
      });
      const duplicateObservation = await phase2d.appendCiValidationAction({
        actionKey: "observe/status",
        kind: "observation",
        leaseGeneration: claimed.leaseGeneration,
        retryClass: "no_automatic_retry",
        runnerId,
        status: "unknown",
        validationId: validation.id
      });
      expect(duplicateObservation.actionKey).toBe("observe/status/outcome");
      await phase2d.appendCiValidationAction({
        actionKey: "observe/status",
        kind: "observation",
        leaseGeneration: claimed.leaseGeneration,
        retryClass: "no_automatic_retry",
        runnerId,
        status: "unknown",
        validationId: validation.id
      });

      const receipt = {
        authorityCatalogDigest: policy.authorityCatalogDigest,
        checkoutCommit: fixture.candidate.commit,
        coverage: {
          branches: { covered: 10, percentage: 100, total: 10 },
          functions: { covered: 10, percentage: 100, total: 10 },
          lines: { covered: 20, percentage: 100, total: 20 },
          statements: { covered: 20, percentage: 100, total: 20 }
        },
        gates: requiredChecks.map((name) => ({ name, status: "passed" as const, summary: `${name} passed` })),
        policyDigest: policy.policyDigest,
        policyRevision: policy.policyRevision,
        requiredChecksDigest: policy.requiredChecksDigest,
        repositoryId: policy.repositoryId,
        runAttempt: 1,
        runId: "fixture-run-1",
        sourceTreeDigest: "b".repeat(64),
        validatedCommit: fixture.candidate.commit,
        validationId: validation.validationId,
        workflowRevision: policy.policyRevision
      };
      await expect(phase2d.issueCiSuccess({
        leaseGeneration: claimed.leaseGeneration,
        receipt: { ...receipt, validatedCommit: "d".repeat(40) },
        runnerId,
        validationId: validation.id
      })).rejects.toThrow();
      const succeeded = await phase2d.issueCiSuccess({
        leaseGeneration: claimed.leaseGeneration,
        receipt,
        runnerId,
        validationId: validation.id
      });
      expect(succeeded.status).toBe("succeeded");
      await expect(phase2d.issueCiSuccess({
        leaseGeneration: claimed.leaseGeneration,
        receipt,
        runnerId,
        validationId: validation.id
      })).rejects.toThrow();

      const release = await phase2d.admitRelease({
        environmentId: policy.environmentId,
        policyId: policy.id,
        runnerId: "release-runner-1",
        validationId: validation.id
      });
      expect(release.status).toBe("merge_pending");
      expect(release.candidateCommit).toBe(fixture.candidate.commit);
      await expect(phase2d.admitRelease({
        environmentId: policy.environmentId,
        policyId: policy.id,
        runnerId: "release-runner-1",
        validationId: validation.id
      })).resolves.toMatchObject({ id: release.id });
      await expect(phase2d.getCiValidation(validation.id)).resolves.toMatchObject({ status: "succeeded" });
      await expect(phase2d.getDevelopmentRelease(release.id)).resolves.toMatchObject({ status: "merge_pending" });

      const journal = await phase2d.listCiValidationActions(validation.id);
      expect(journal.map((row) => row.actionKey)).toEqual([
        "workflow/main",
        "workflow/main/outcome",
        "observe/status",
        "observe/status/outcome"
      ]);
      await expect(pool.query("update ci_validations set candidate_commit = $1 where id = $2", ["d".repeat(40), validation.id])).rejects.toBeDefined();
      await expect(pool.query("delete from ci_validation_actions where validation_id = $1", [validation.id])).rejects.toBeDefined();
      await expect(pool.query("delete from development_release_events where release_id = $1", [release.id])).rejects.toBeDefined();
      await expect(pool.query("select has_table_privilege('phase2d_ci_issuer', 'public.ci_validations', 'UPDATE')")).resolves.toMatchObject({ rows: [{ has_table_privilege: false }] });
      await expect(pool.query("select has_function_privilege('phase2d_ci_issuer', 'public.phase2d_issue_ci_success(uuid,jsonb,text,integer)', 'EXECUTE')")).resolves.toMatchObject({ rows: [{ has_function_privilege: true }] });

      const failedFixture = await createPhase2DCandidateFixture(database);
      try {
        const failedApproved = await failedFixture.approve();
        const failedEntries = failedApproved.context.manifest.entries
          .filter((entry) => entry.source === "authority")
          .map((entry) => ({ blobId: entry.blobId, path: entry.path }))
          .sort((left, right) => left.path.localeCompare(right.path));
        const failedPolicy = await phase2d.createPolicy({
          authorityCatalogDigest: digest(failedEntries),
          environmentId: "local-failed",
          policyDigest: "c".repeat(64),
          policyRevision: "phase2d-m1-failed",
          requiredChecks: ["lint"],
          remoteUrl: "https://example.invalid/failed.git",
          repositoryId: "failed-repository",
          requiredChecksDigest: digest(["lint"]),
          targetRef: "refs/heads/main"
        });
        await phase2d.setPolicyEnabled({ enabled: true, policyId: failedPolicy.id });
        const failedValidation = await phase2d.createCiValidation({
          attemptId: failedFixture.attemptId,
          candidateCommit: failedFixture.candidate.commit,
          candidateRef: failedFixture.candidate.ref,
          policyId: failedPolicy.id,
          reviewId: failedApproved.review.id,
          taskId: failedFixture.task.id
        });
        const claims = await Promise.allSettled([
          phase2d.claimCiValidation({ runnerId: "ci-runner-failed-a", validationId: failedValidation.id }),
          phase2d.claimCiValidation({ runnerId: "ci-runner-failed-b", validationId: failedValidation.id })
        ]);
        expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
        const winner = claims.find((result) => result.status === "fulfilled");
        if (!winner || winner.status !== "fulfilled") throw new Error("Concurrent CI claim did not produce a winner");
        const failedClaim = winner.value;
        const failedRunner = claims[0]?.status === "fulfilled" ? "ci-runner-failed-a" : "ci-runner-failed-b";
        await expect(phase2d.failCiValidation({
          failureClass: "infrastructure",
          runnerId: failedRunner,
          validationId: failedValidation.id,
          leaseGeneration: failedClaim.leaseGeneration
        })).resolves.toMatchObject({ status: "needs_human" });
      } finally {
        await failedFixture.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
