import "server-only";
import { cookies } from "next/headers";

const API = process.env.AIX_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Server-side call to the AIX API, forwarding the user's session cookie. */
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const jar = await cookies();
  const session = jar.get("aix_session")?.value;
  const res = await fetch(API + path, {
    ...init,
    cache: "no-store",
    headers: { ...(init.headers ?? {}), ...(session ? { cookie: `aix_session=${session}` } : {}) },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? "error", json.error?.message ?? res.statusText);
  return json as T;
}

/** Like api() but returns null on 401/403/404 instead of throwing. */
export async function apiOrNull<T = any>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) return null;
    throw e;
  }
}

export interface Me {
  user: { id: string; email: string; name: string | null };
  isAdmin: boolean;
  wallet: { id: string; availableCents: number; heldCents: number };
  orgs: { id: string; name: string; slug: string; role: string }[];
  developer: { id: string; displayName: string; payoutStatus: string } | null;
}

export const getMe = () => apiOrNull<Me>("/me");

export function money(cents: number) {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}€${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
