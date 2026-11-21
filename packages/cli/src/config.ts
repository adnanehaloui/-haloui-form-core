import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig { apiUrl: string; secretKey?: string }
export const CONFIG_PATH = process.env.AIX_CONFIG_PATH ?? join(homedir(), ".aix", "config.json");

export async function loadCliConfig(): Promise<CliConfig> {
  let file: Partial<CliConfig> = {};
  try {
    file = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {}
  const secretKey = process.env.AIX_SECRET_KEY ?? file.secretKey;
  return { apiUrl: process.env.AIX_API_URL ?? file.apiUrl ?? "http://localhost:4000", ...(secretKey ? { secretKey } : {}) };
}

export async function saveCliConfig(c: CliConfig) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(c, null, 2));
  await chmod(CONFIG_PATH, 0o600); // contains a secret key
}
