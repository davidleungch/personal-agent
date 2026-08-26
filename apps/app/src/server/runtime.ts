import { createDatabase } from "@personal-agent/db";
import { parseAppConfiguration, type Environment } from "@personal-agent/shared";
import { createHttpApi } from "./http";
import { createProductService, readWorkerHealth } from "./product";

export function createAppRuntime(
  environment: Environment,
  dependencies: {
    createConnection?: typeof createDatabase;
    fetcher?: typeof fetch;
  } = {}
) {
  const configuration = parseAppConfiguration(environment);
  const connection = (dependencies.createConnection ?? createDatabase)(configuration.databaseUrl);
  const service = createProductService(connection.database, {
    readIntegrations: () => readWorkerHealth(configuration.workerHealthUrl, dependencies.fetcher)
  });
  return {
    api: createHttpApi(service),
    close: connection.close,
    service
  };
}

let runtime: ReturnType<typeof createAppRuntime> | undefined;

export function getAppRuntime() {
  runtime ??= createAppRuntime(process.env);
  return runtime;
}
