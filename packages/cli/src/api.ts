import type { CliConfig } from "./config.js";

export class CliApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export async function api<T = any>(cfg: CliConfig, method: string, path: string, body?: unknown): Promise<T> {
  if (!cfg.secretKey) throw new CliApiError(401, "unauthorized", "not logged in — run `aix login` (or set AIX_SECRET_KEY)");
  const res = await fetch(cfg.apiUrl.replace(/\/$/, "") + path, {
    method,
    headers: { authorization: `Bearer ${cfg.secretKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliApiError(res.status, json.error?.code ?? "error", json.error?.message ?? res.statusText, json.error?.details);
  return json as T;
}
