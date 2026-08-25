import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    close: () => pool.end(),
    database: drizzle(pool, { schema }),
    pool
  };
}

export async function migrateDatabase(databaseUrl: string, migrationsFolder: string): Promise<void> {
  const connection = createDatabase(databaseUrl);

  try {
    await migrate(connection.database, { migrationsFolder });
  } finally {
    await connection.close();
  }
}
