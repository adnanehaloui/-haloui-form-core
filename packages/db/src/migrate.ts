import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.js";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
