#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { basename, resolve } from "node:path";
import { Command, Option } from "commander";
import { slugify } from "@aix/manifest";
import { api, CliApiError } from "./api.js";
import { CONFIG_PATH, loadCliConfig, saveCliConfig } from "./config.js";
import { DEV_SECRET_KEY, DEV_USER_TOKEN, startMockApi } from "./mock.js";
import { addSkills, AGENT_DIRS } from "./add.js";
import { describePermissions, initApp, packApp, readManifest, TEMPLATES, type Template } from "./project.js";

const program = new Command().name("aix").description("AIX developer CLI").version("0.1.0");
const fail = (m: string): never => {
  console.error(`✖ ${m}`);
  process.exit(1);
};

program
  .command("login")
  .description("Save a developer secret key (create one in the developer portal → Keys)")
  .option("--key <secret>", "secret key (otherwise prompted)")
  .option("--api-url <url>", "AIX API URL")
  .action(async (o) => {
    const cfg = await loadCliConfig();
    let key: string = o.key;
    if (!key) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      key = (await rl.question("Secret key (aixsk_…): ")).trim();
      rl.close();
    }
    if (!key.startsWith("aixsk_")) fail("that doesn't look like an AIX secret key");
    const next = { apiUrl: o.apiUrl ?? cfg.apiUrl, secretKey: key };
    const me = await api(next, "GET", "/developer").catch((e) => fail(e.message));
    await saveCliConfig(next);
    console.log(`✔ Logged in as ${me.developer.displayName}. Saved to ${CONFIG_PATH}`);
  });

program
  .command("add <app>")
  .description("Install an app's skills into Claude Code, Cursor, Codex… (get the command with a token on the app's AIX page)")
  .requiredOption("--token <token>", "install token from the app page (valid 15 minutes)")
  .addOption(new Option("--agent <agent>", "where to install").choices(Object.keys(AGENT_DIRS)).default("claude-code"))
  .option("-g, --global", "install for your user instead of this project")
  .option("--api-url <url>", "AIX API URL")
  .action(async (slug: string, o) => {
    const cfg = await loadCliConfig();
    const r = await addSkills({ slug, token: o.token, apiUrl: o.apiUrl ?? cfg.apiUrl, agent: o.agent, global: !!o.global }).catch((e) => fail(e.message));
    console.log(`✔ Installed ${r.app.name} ${r.app.version} for ${r.agentLabel}:`);
    for (const w of r.written) console.log(`  ${w}`);
    if (o.agent === "claude-code") console.log("\nRestart Claude Code (or start a new session) to load the skills.");
  });

const appCmd = program.command("app").description("Create, validate and publish apps");

appCmd
  .command("init [dir]")
  .description("Create a new app from a template")
  .addOption(new Option("--template <t>", "app type").choices(TEMPLATES).default("server"))
  .option("--name <name>", "app name")
  .option("--id <id>", "reverse-DNS app id, e.g. com.acme.videostudio")
  .action(async (dir: string | undefined, o) => {
    const target = dir ?? "my-aix-app";
    const name = o.name ?? basename(resolve(target)).replace(/[-_]/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    const id = o.id ?? `com.example.${slugify(name).replace(/-/g, "")}`;
    const out = await initApp(target, o.template as Template, { name, id }).catch((e) => fail(e.message));
    console.log(`✔ Created ${o.template} app "${name}" (${id}) in ${out}\n\nNext:\n  cd ${target}\n  aix app validate\n  aix dev`);
  });

appCmd
  .command("validate [dir]")
  .description("Check aix.json and declared permissions")
  .action(async (dir = ".") => {
    const r = await readManifest(dir);
    for (const w of r.warnings) console.log(`⚠ ${w}`);
    if (!r.ok) {
      for (const e of r.errors) console.error(`✖ ${e.path}: ${e.message}`);
      process.exit(1);
    }
    console.log(`✔ ${r.manifest!.name} ${r.manifest!.version} (${r.manifest!.type}) is valid.\n\nUsers will be asked to allow:`);
    for (const l of describePermissions(r.manifest!)) console.log(`  • ${l}`);
  });

appCmd
  .command("publish [dir]")
  .description("Package, hash, upload and submit for review")
  .option("--notes <text>", "release notes for the reviewer")
  .action(async (dir = ".", o) => {
    const r = await readManifest(dir);
    if (!r.ok) fail(`aix.json is invalid:\n${r.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
    const { pkg, sha256, files } = await packApp(dir);
    console.log(`Packaged ${files.length} files (${(pkg.length / 1024).toFixed(1)} KB), sha256 ${sha256}`);
    const res = await api(await loadCliConfig(), "POST", "/developer/publish", { packageBase64: pkg.toString("base64"), ...(o.notes ? { releaseNotes: o.notes } : {}) }).catch((e: CliApiError) =>
      fail(`${e.message}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ""}`),
    );
    if (res.sha256 !== sha256) fail("server hash does not match local hash — upload corrupted");
    console.log(`✔ Submitted ${r.manifest!.name} ${res.version} for review (app ${res.slug}, version ${res.versionId}).`);
  });

program
  .command("dev [dir]")
  .description("Run your app against a local mock AIX API with a test wallet (fake money)")
  .option("--port <port>", "mock API port", "4900")
  .option("--no-run", "only start the mock API, don't run `npm run dev`")
  .action(async (dir = ".", o) => {
    const r = await readManifest(dir);
    if (!r.ok) fail("aix.json is invalid — run `aix app validate`");
    const { url } = await startMockApi(r.manifest!, Number(o.port));
    console.log(`✔ Mock AIX API on ${url} — test wallet €100.00 (fake money)`);
    console.log(`  AIX_API_URL=${url}\n  AIX_SECRET_KEY=${DEV_SECRET_KEY}\n  user token for requests: ${DEV_USER_TOKEN}\n  wallet state: ${url}/_mock/wallet`);
    if (o.run) {
      const child = spawn("npm", ["run", "dev"], { cwd: resolve(dir), stdio: "inherit", env: { ...process.env, AIX_API_URL: url, AIX_SECRET_KEY: DEV_SECRET_KEY, AIX_DEV: "1" } });
      child.on("exit", (code) => process.exit(code ?? 0));
    }
  });

const keys = program.command("keys").description("Manage secret keys");
keys
  .command("create")
  .option("--name <name>", "key name", "cli")
  .action(async (o) => {
    const k = await api(await loadCliConfig(), "POST", "/developer/keys", { name: o.name }).catch((e) => fail(e.message));
    console.log(`✔ Created key ${k.prefix}… — store it now, it won't be shown again:\n\n${k.secret}\n`);
  });
keys.command("list").action(async () => {
  const k = await api(await loadCliConfig(), "GET", "/developer/keys").catch((e) => fail(e.message));
  for (const x of k.data) console.log(`${x.id}  ${x.prefix}…  ${x.name}  ${x.revokedAt ? "revoked" : "active"}`);
});
keys.command("revoke <id>").action(async (id: string) => {
  await api(await loadCliConfig(), "DELETE", `/developer/keys/${id}`).catch((e) => fail(e.message));
  console.log("✔ Revoked");
});

program
  .command("prices")
  .description("Manage catalog prices (the only prices AIX charges)")
  .command("create")
  .requiredOption("--app <slug>", "app slug or id")
  .addOption(new Option("--kind <kind>").choices(["free", "one_time", "subscription", "metered"]).makeOptionMandatory())
  .option("--unit <unit>", "unit name, e.g. render", "run")
  .option("--amount <cents>", "unit amount in euro cents", "0")
  .option("--lookup <key>", "lookup key used by the SDK, e.g. render")
  .option("--included <n>", "free included units", "0")
  .option("--interval <interval>", "month | year (subscriptions)")
  .action(async (o) => {
    const p = await api(await loadCliConfig(), "POST", `/developer/apps/${o.app}/prices`, {
      kind: o.kind,
      unit: o.unit,
      unitAmountCents: Number(o.amount),
      includedUnits: Number(o.included),
      ...(o.lookup ? { lookupKey: o.lookup } : {}),
      ...(o.interval ? { interval: o.interval } : {}),
    }).catch((e) => fail(e.message));
    console.log(`✔ Created ${p.id} (${p.kind}, ${p.unitAmountCents} cents / ${p.unit})`);
  });

await program.parseAsync();
