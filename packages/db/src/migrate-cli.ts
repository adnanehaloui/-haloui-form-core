import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL ?? "postgres://aix:aix@localhost:5432/aix";
const { db, close } = createDb(url, { max: 1 });
await runMigrations(db);
await close();
console.log("migrations applied");
