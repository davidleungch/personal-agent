import { z } from "zod";

const databaseUrlSchema = z.string().min(1).refine((value) => {
  try {
    return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "DATABASE_URL must be a PostgreSQL URL");

const nonnegativeIntegerSchema = z.coerce.number().int().nonnegative();
const positiveIntegerSchema = z.coerce.number().int().positive();

const environmentSchema = z.object({
  AGENT_MAX_ESCALATION_DEPTH: nonnegativeIntegerSchema.max(2).default(2),
  AGENT_MAX_MODEL_INVOCATIONS: positiveIntegerSchema.default(12),
  AGENT_MAX_REASONING_RETRIES: nonnegativeIntegerSchema.default(1),
  BROWSER_PROFILE_DIR: z.string().min(1).default("/var/lib/personal-agent/browser-profile"),
  DATABASE_URL: databaseUrlSchema,
  GOOGLE_CLIENT_ID_FILE: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET_FILE: z.string().min(1).optional(),
  GOOGLE_REFRESH_TOKEN_FILE: z.string().min(1).optional(),
  MODEL_BALANCED: z.string().min(1).default("gpt-5.6-terra"),
  MODEL_FAST: z.string().min(1).default("gpt-5.6-luna"),
  MODEL_REASONING: z.string().min(1).default("gpt-5.6-sol"),
  OPENAI_API_KEY_FILE: z.string().min(1).optional(),
  WORKER_HEALTH_URL: z.url().default("http://127.0.0.1:3001/health")
});

export type Environment = Record<string, string | undefined>;

export function parseAppConfiguration(environment: Environment) {
  const configuration = environmentSchema
    .pick({ DATABASE_URL: true, WORKER_HEALTH_URL: true })
    .parse(environment);
  return {
    databaseUrl: configuration.DATABASE_URL,
    workerHealthUrl: configuration.WORKER_HEALTH_URL
  };
}

export function parseWorkerConfiguration(environment: Environment) {
  const configuration = environmentSchema.parse(environment);
  const googleAvailable = Boolean(
    configuration.GOOGLE_CLIENT_ID_FILE &&
      configuration.GOOGLE_CLIENT_SECRET_FILE &&
      configuration.GOOGLE_REFRESH_TOKEN_FILE
  );

  return {
    agentLimits: {
      maxEscalationDepth: configuration.AGENT_MAX_ESCALATION_DEPTH,
      maxModelInvocations: configuration.AGENT_MAX_MODEL_INVOCATIONS,
      maxReasoningRetries: configuration.AGENT_MAX_REASONING_RETRIES
    },
    browserProfileDirectory: configuration.BROWSER_PROFILE_DIR,
    credentialFiles: {
      googleClientId: configuration.GOOGLE_CLIENT_ID_FILE,
      googleClientSecret: configuration.GOOGLE_CLIENT_SECRET_FILE,
      googleRefreshToken: configuration.GOOGLE_REFRESH_TOKEN_FILE,
      openaiApiKey: configuration.OPENAI_API_KEY_FILE
    },
    databaseUrl: configuration.DATABASE_URL,
    integrations: {
      google: googleAvailable ? "available" : "unavailable",
      openai: configuration.OPENAI_API_KEY_FILE ? "available" : "unavailable"
    },
    models: {
      balanced: configuration.MODEL_BALANCED,
      fast: configuration.MODEL_FAST,
      reasoning: configuration.MODEL_REASONING
    }
  } as const;
}
