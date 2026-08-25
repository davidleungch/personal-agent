import { fileURLToPath } from "node:url";
import { parseAppConfiguration, type Environment } from "@personal-agent/shared";
import { migrateDatabase } from "./database.js";

export async function migrateFromEnvironment(environment: Environment): Promise<void> {
  const configuration = parseAppConfiguration(environment);
  const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
  await migrateDatabase(configuration.databaseUrl, migrationsFolder);
}
