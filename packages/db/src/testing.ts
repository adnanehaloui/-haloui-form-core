import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { runMigrations } from "./migrate.js";

/** Drop everything and re-run migrations. Test databases only. */
export async function resetDatabase(db: Db) {
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await runMigrations(db);
}
