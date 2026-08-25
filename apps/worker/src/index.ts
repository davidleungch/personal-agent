import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { OpenAIAgentsModelTransport, type ModelTransport } from "@personal-agent/agents";
import { createDatabase } from "@personal-agent/db";
import { parseWorkerConfiguration, type Environment } from "@personal-agent/shared";
import {
  createDatabaseToolPersistence,
  createGoogleCalendarTransport,
  createGoogleGmailTransport,
  createGoogleOAuthClient,
  createProductionToolRegistry,
  createToolGateway,
  PlaywrightBrowserOperations,
  type BrowserOperations
} from "@personal-agent/tools";
import {
  createAgentRuntime,
  createDatabaseAgentRuntimePersistence
} from "./agent-runtime.js";
import { createRunState } from "./run-state.js";
import { createDurablePolling } from "./runtime.js";

export * from "./agent-runtime.js";
export * from "./run-state.js";
export * from "./runtime.js";
export * from "./scheduler.js";

export function createHealthServer(
  integrations: { google: "available" | "unavailable"; openai: "available" | "unavailable" } = {
    google: "unavailable",
    openai: "unavailable"
  }
): Server {
  const healthPayload = JSON.stringify({ integrations, service: "worker", status: "ok" });
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json");

    if (request.url !== "/health") {
      response.writeHead(404);
      response.end(JSON.stringify({ status: "not_found" }));
      return;
    }

    response.writeHead(200);
    response.end(healthPayload);
  });
}

type ClosableBrowser = BrowserOperations & { close(): Promise<void> };

export async function createConfiguredAgentExecutor(
  database: ReturnType<typeof createDatabase>["database"],
  configuration: ReturnType<typeof parseWorkerConfiguration>,
  dependencies: {
    browser?: ClosableBrowser;
    clock?: () => Date;
    modelTransportFactory?: (apiKey: string) => ModelTransport;
    readCredential?: (path: string) => Promise<string>;
    workerId?: string;
  } = {}
) {
  const readCredential = dependencies.readCredential ?? (async (path: string) => {
    const value = (await readFile(path, "utf8")).trim();
    if (!value) throw new Error("Configured credential file is empty");
    return value;
  });
  const openaiApiKey = configuration.credentialFiles.openaiApiKey
    ? await readCredential(configuration.credentialFiles.openaiApiKey)
    : undefined;
  const googleCredentials = configuration.integrations.google === "available"
    ? {
        clientId: await readCredential(configuration.credentialFiles.googleClientId!),
        clientSecret: await readCredential(configuration.credentialFiles.googleClientSecret!),
        refreshToken: await readCredential(configuration.credentialFiles.googleRefreshToken!)
      }
    : undefined;
  const browser = dependencies.browser ?? await PlaywrightBrowserOperations.launch({
    profileDirectory: configuration.browserProfileDirectory
  });
  const googleClient = googleCredentials ? createGoogleOAuthClient(googleCredentials) : undefined;
  const registry = createProductionToolRegistry({
    browser,
    ...(googleClient
      ? {
          calendar: createGoogleCalendarTransport(googleClient),
          gmail: createGoogleGmailTransport(googleClient)
        }
      : {})
  });
  const knownSecrets = [
    openaiApiKey,
    googleCredentials?.clientId,
    googleCredentials?.clientSecret,
    googleCredentials?.refreshToken
  ].filter((value): value is string => Boolean(value));
  const gateway = createToolGateway({
    knownSecrets,
    persistence: createDatabaseToolPersistence(database),
    registry
  });
  const runtime = createAgentRuntime({
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    gateway,
    integrations: {
      browser: "available",
      google: configuration.integrations.google
    },
    knownSecrets,
    limits: configuration.agentLimits,
    models: configuration.models,
    persistence: createDatabaseAgentRuntimePersistence(database, knownSecrets),
    ...(openaiApiKey
      ? {
          transport: (dependencies.modelTransportFactory ??
            ((apiKey) => new OpenAIAgentsModelTransport(apiKey)))(openaiApiKey)
        }
      : {})
  });
  const runState = createRunState(database, knownSecrets);
  const workerId = dependencies.workerId ?? randomUUID();

  return {
    close: () => browser.close(),
    executeRun: async (now: Date) => {
      const run = await runState.claimRun(workerId, now, 60_000);
      if (run) await runtime.execute(run.id, workerId);
    }
  };
}

export async function startWorker(
  port: number,
  environment: Environment = process.env,
  dependencies: Parameters<typeof createConfiguredAgentExecutor>[2] = {}
) {
  const configuration = parseWorkerConfiguration(environment);
  const connection = createDatabase(configuration.databaseUrl);
  const executor = await createConfiguredAgentExecutor(
    connection.database,
    configuration,
    dependencies
  );
  const polling = createDurablePolling(connection.database, { executeRun: executor.executeRun });
  const server = createHealthServer(configuration.integrations);

  await polling.tick();
  polling.start();
  server.listen(port, "0.0.0.0");

  return {
    server,
    stop: async () => {
      polling.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await executor.close();
      await connection.close();
    }
  };
}
