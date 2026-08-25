import { createServer, type Server } from "node:http";
import { createDatabase } from "@personal-agent/db";
import { parseWorkerConfiguration, type Environment } from "@personal-agent/shared";
import { createDurablePolling } from "./runtime.js";

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

export async function startWorker(port: number, environment: Environment = process.env) {
  const configuration = parseWorkerConfiguration(environment);
  const connection = createDatabase(configuration.databaseUrl);
  const polling = createDurablePolling(connection.database);
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
      await connection.close();
    }
  };
}
