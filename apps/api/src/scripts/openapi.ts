/** Writes the generated OpenAPI spec to apps/api/openapi.json. */
import { writeFile } from "node:fs/promises";
import { createDb } from "@aix/db";
import { buildApp, buildDeps } from "../app.js";
import { loadConfig } from "../config.js";

const config = loadConfig({ ...process.env, NODE_ENV: "test" });
const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
const app = await buildApp(buildDeps(config, { db }));
await app.ready();
await writeFile("openapi.json", JSON.stringify(app.swagger(), null, 2));
console.log("wrote openapi.json");
await app.close();
await close();
