import { describe, expect, it } from "vitest";
import {
  automationRunStatusSchema,
  automationRunTriggerSchema,
  canTransitionDevelopmentAttempt,
  canTransitionDevelopmentTask,
  canTransitionAutomationRun,
  commandStatusSchema,
  completionModeSchema,
  createSecretFreeJsonSchema,
  createSecretFreeTextSchema,
  developmentAcceptanceCriteriaSchema,
  developmentAttemptEventKindSchema,
  developmentAttemptStatusSchema,
  developmentBudgetSchema,
  developmentContextManifestSchema,
  developmentEventStatusSchema,
  developmentImplementerContextPolicySchema,
  developmentNeedsHumanReasonSchema,
  developmentRoleSchema,
  developmentTaskStatusSchema,
  developmentUsageSchema,
  emptyDevelopmentUsage,
  gitObjectIdSchema,
  idempotencyStateSchema,
  intentTypeSchema,
  isDurableJson,
  isSecretFreeText,
  jsonObjectSchema,
  jsonValueSchema,
  modelProfileSchema,
  parseAppConfiguration,
  parseWorkerConfiguration,
  redactJson,
  redactText,
  sideEffectClassSchema,
  toolPolicySchema,
  toolStatusSchema,
  workspaceRelativePathSchema
} from "../src/index";

describe("domain validation", () => {
  it("accepts every durable state enum", () => {
    expect(modelProfileSchema.options.map((value) => modelProfileSchema.parse(value))).toEqual([
      "fast",
      "balanced",
      "reasoning"
    ]);
    expect(commandStatusSchema.options.map((value) => commandStatusSchema.parse(value))).toHaveLength(5);
    expect(intentTypeSchema.options.map((value) => intentTypeSchema.parse(value))).toHaveLength(8);
    expect(automationRunStatusSchema.options.map((value) => automationRunStatusSchema.parse(value))).toHaveLength(9);
    expect(automationRunTriggerSchema.options.map((value) => automationRunTriggerSchema.parse(value))).toHaveLength(3);
    expect(toolStatusSchema.options.map((value) => toolStatusSchema.parse(value))).toHaveLength(3);
    expect(idempotencyStateSchema.options.map((value) => idempotencyStateSchema.parse(value))).toHaveLength(3);
    expect(sideEffectClassSchema.options.map((value) => sideEffectClassSchema.parse(value))).toHaveLength(3);
    expect(toolPolicySchema.options).toHaveLength(7);
    expect(completionModeSchema.options).toEqual(["continue", "stop_after_success"]);
    expect(canTransitionAutomationRun("needs_human", "queued")).toBe(true);
    expect(canTransitionAutomationRun("succeeded", "queued")).toBe(false);
  });

  it("accepts JSON values and objects but rejects non-JSON numbers", () => {
    const value = { array: ["text", 1, true, null, { nested: false }] };

    expect(jsonValueSchema.parse(value)).toEqual(value);
    expect(jsonObjectSchema.parse(value)).toEqual(value);
    expect(() => jsonValueSchema.parse(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("validates the complete development domain and transition policy", () => {
    expect(developmentRoleSchema.parse("implementer")).toBe("implementer");
    expect(developmentTaskStatusSchema.options).toHaveLength(11);
    expect(developmentAttemptStatusSchema.options).toHaveLength(8);
    expect(developmentAttemptEventKindSchema.options).toHaveLength(7);
    expect(developmentEventStatusSchema.options).toHaveLength(5);
    expect(gitObjectIdSchema.parse("a".repeat(40))).toHaveLength(40);
    expect(gitObjectIdSchema.parse("a".repeat(64))).toHaveLength(64);
    expect(() => gitObjectIdSchema.parse("short")).toThrow();
    expect(workspaceRelativePathSchema.parse("packages/shared/src/domain.ts")).toContain("domain.ts");
    for (const invalid of ["/absolute", "../escape", "a\\b", "a//b", "a/./b", ""]) {
      expect(() => workspaceRelativePathSchema.parse(invalid)).toThrow();
    }

    const criteria = [
      {
        check: { executable: "pnpm" as const, timeoutMs: 1_000 },
        description: "Run tests",
        id: "tests"
      }
    ];
    expect(developmentAcceptanceCriteriaSchema.parse(criteria)[0]?.check.arguments).toEqual([]);
    expect(() => developmentAcceptanceCriteriaSchema.parse([...criteria, ...criteria])).toThrow(
      "unique"
    );
    expect(
      developmentBudgetSchema.parse({
        maxCommandMs: 1,
        maxCommandOutputBytes: 1,
        maxContextBytes: 1,
        maxCostUsdMicros: 0,
        maxDiffBytes: 1,
        maxModelInvocations: 1,
        maxTokens: 1,
        maxToolCalls: 1,
        maxWallClockMs: 1,
        maxWorkspaceBytes: 1
      }).maxCostUsdMicros
    ).toBe(0);
    const usage = emptyDevelopmentUsage();
    expect(developmentUsageSchema.parse(usage)).toEqual(usage);
    expect(() => developmentBudgetSchema.parse({
      maxCommandMs: 1,
      maxCommandOutputBytes: 1,
      maxContextBytes: 1,
      maxCostUsdMicros: 0,
      maxDiffBytes: 1,
      maxModelInvocations: 1,
      maxTokens: 1,
      maxToolCalls: 1,
      maxWallClockMs: 1,
      maxWorkspaceBytes: 1,
      unsupported: true
    })).toThrow();
    expect(() => developmentUsageSchema.parse({ ...usage, unsupported: 1 })).toThrow();
    expect(
      developmentContextManifestSchema.parse({
        entries: [{ blobId: "b".repeat(40), bytes: 1, path: "AGENTS.md", source: "authority" }],
        totalBytes: 1
      }).entries
    ).toHaveLength(1);
    expect(canTransitionDevelopmentTask("ready", "preparing")).toBe(true);
    expect(canTransitionDevelopmentTask("candidate_ready", "fix_required")).toBe(true);
    expect(canTransitionDevelopmentTask("candidate_ready", "approved_candidate")).toBe(true);
    expect(canTransitionDevelopmentTask("fix_required", "preparing")).toBe(true);
    expect(canTransitionDevelopmentTask("candidate_ready", "failed")).toBe(false);
    expect(developmentNeedsHumanReasonSchema.parse("non_convergence")).toBe("non_convergence");
    expect(developmentImplementerContextPolicySchema.parse({
      allowedPaths: ["src"],
      forbiddenPaths: [".git"],
      relevantPaths: ["src/value.ts"]
    }).allowedPaths).toEqual(["src"]);
    expect(canTransitionDevelopmentAttempt("preparing", "implementing")).toBe(true);
    expect(canTransitionDevelopmentAttempt("succeeded", "failed")).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts known values and recognized credential formats deterministically", () => {
    const knownSecrets = ["a.b*", "same", "size", "a.b*", ""];
    const source = [
      "a.b*",
      "sk-abcdefghijklmnop",
      "ya29.abcdefghijklmno",
      "1//abcdefghijklmno",
      "Bearer abcdefghijklmno",
      "eyJheader.payload.signature"
    ].join(" ");

    const first = redactText(source, knownSecrets);
    const second = redactText(source, knownSecrets);

    expect(first).toBe(second);
    expect(first).toBe(Array(6).fill("[REDACTED]").join(" "));
    expect(redactText("ordinary text")).toBe("ordinary text");
    expect(isSecretFreeText("ordinary text")).toBe(true);
    expect(isSecretFreeText("contains canary", ["canary"])).toBe(false);
  });

  it("redacts nested JSON values and sensitive fields", () => {
    const value = {
      count: 2,
      items: ["safe", "canary", null, false],
      nested: { api_key: "not-even-a-key", note: "safe" }
    };

    expect(redactJson(value, ["canary"])).toEqual({
      count: 2,
      items: ["safe", "[REDACTED]", null, false],
      nested: { api_key: "[REDACTED]", note: "safe" }
    });
  });

  it("validates secret-free text and JSON", () => {
    const textSchema = createSecretFreeTextSchema(["canary"]);
    const jsonSchema = createSecretFreeJsonSchema(["canary"]);

    expect(textSchema.parse("safe")).toBe("safe");
    expect(() => textSchema.parse("canary")).toThrow("Secret material is not allowed");
    expect(jsonSchema.parse({ safe: [1, true] })).toEqual({ safe: [1, true] });
    expect(() => jsonSchema.parse({ cookie: "value" })).toThrow("Secret material is not allowed");
    expect(() => jsonSchema.parse({ nested: "canary" })).toThrow("Secret material is not allowed");
  });

  it("rejects non-durable JSON structures and provider model policy", () => {
    expect(isDurableJson("safe")).toBe(true);
    expect(isDurableJson("gpt-5.6-provider-id")).toBe(false);
    expect(isDurableJson("Luna")).toBe(false);
    expect(isDurableJson(["safe", 1])).toBe(true);
    expect(isDurableJson(["safe", "claude-provider-id"])).toBe(false);
    expect(isDurableJson({ nested: { value: null } })).toBe(true);
    expect(isDurableJson({ prompt: "do something" })).toBe(false);
    expect(isDurableJson({ nested: "gemini-provider-id" })).toBe(false);
    expect(isDurableJson(false)).toBe(true);
  });
});

describe("configuration", () => {
  const databaseUrl = "postgresql://user:password@localhost:5432/personal_agent";

  it("parses app database configuration", () => {
    expect(parseAppConfiguration({ DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      workerHealthUrl: "http://127.0.0.1:3001/health"
    });
    expect(parseAppConfiguration({ DATABASE_URL: "postgres://localhost/database" })).toEqual({
      databaseUrl: "postgres://localhost/database",
      workerHealthUrl: "http://127.0.0.1:3001/health"
    });
    expect(parseAppConfiguration({ DATABASE_URL: databaseUrl, WORKER_HEALTH_URL: "http://worker:3001/health" }).workerHealthUrl).toBe("http://worker:3001/health");
  });

  it("rejects absent, malformed, and non-PostgreSQL database URLs", () => {
    expect(() => parseAppConfiguration({})).toThrow();
    expect(() => parseAppConfiguration({ DATABASE_URL: "not a URL" })).toThrow(
      "DATABASE_URL must be a PostgreSQL URL"
    );
    expect(() => parseAppConfiguration({ DATABASE_URL: "https://example.com/database" })).toThrow(
      "DATABASE_URL must be a PostgreSQL URL"
    );
    expect(() => parseAppConfiguration({ DATABASE_URL: databaseUrl, WORKER_HEALTH_URL: "invalid" })).toThrow();
  });

  it("keeps integrations unavailable without credentials and applies model defaults", () => {
    expect(parseWorkerConfiguration({ DATABASE_URL: databaseUrl })).toMatchObject({
      agentLimits: {
        maxEscalationDepth: 2,
        maxModelInvocations: 12,
        maxReasoningRetries: 1
      },
      integrations: { google: "unavailable", openai: "unavailable" },
      models: {
        balanced: "gpt-5.6-terra",
        fast: "gpt-5.6-luna",
        reasoning: "gpt-5.6-sol"
      }
    });
  });

  it("validates configured agent-runtime limits", () => {
    expect(
      parseWorkerConfiguration({
        AGENT_MAX_ESCALATION_DEPTH: "0",
        AGENT_MAX_MODEL_INVOCATIONS: "4",
        AGENT_MAX_REASONING_RETRIES: "3",
        DATABASE_URL: databaseUrl
      }).agentLimits
    ).toEqual({ maxEscalationDepth: 0, maxModelInvocations: 4, maxReasoningRetries: 3 });
    expect(() =>
      parseWorkerConfiguration({ AGENT_MAX_MODEL_INVOCATIONS: "0", DATABASE_URL: databaseUrl })
    ).toThrow();
    expect(() =>
      parseWorkerConfiguration({ AGENT_MAX_REASONING_RETRIES: "1.5", DATABASE_URL: databaseUrl })
    ).toThrow();
    expect(() =>
      parseWorkerConfiguration({ AGENT_MAX_ESCALATION_DEPTH: "3", DATABASE_URL: databaseUrl })
    ).toThrow();
  });

  it("requires all Google files and independently derives OpenAI availability", () => {
    const base = { DATABASE_URL: databaseUrl, GOOGLE_CLIENT_ID_FILE: "/run/secrets/id" };
    expect(parseWorkerConfiguration(base).integrations.google).toBe("unavailable");
    expect(
      parseWorkerConfiguration({
        ...base,
        GOOGLE_CLIENT_SECRET_FILE: "/run/secrets/secret"
      }).integrations.google
    ).toBe("unavailable");

    const configured = parseWorkerConfiguration({
      ...base,
      GOOGLE_CLIENT_SECRET_FILE: "/run/secrets/secret",
      GOOGLE_REFRESH_TOKEN_FILE: "/run/secrets/refresh",
      MODEL_BALANCED: "balanced-provider",
      MODEL_FAST: "fast-provider",
      MODEL_REASONING: "reasoning-provider",
      OPENAI_API_KEY_FILE: "/run/secrets/openai"
    });

    expect(configured.integrations).toEqual({ google: "available", openai: "available" });
    expect(configured.models).toEqual({
      balanced: "balanced-provider",
      fast: "fast-provider",
      reasoning: "reasoning-provider"
    });
    expect(configured.credentialFiles.googleRefreshToken).toBe("/run/secrets/refresh");
  });
});
