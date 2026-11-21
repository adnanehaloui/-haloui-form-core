/** Calls the AIX API as the signed-in user (their AIX OAuth access token). */
export class AixApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export class AixApi {
  constructor(private apiUrl: string, private accessToken: string) {}
  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.apiUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.accessToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new AixApiError(res.status, json.error?.code ?? "error", json.error?.message ?? res.statusText, json.error?.details);
    return json as T;
  }
  get = <T = any>(p: string) => this.req<T>("GET", p);
  post = <T = any>(p: string, b: unknown = {}) => this.req<T>("POST", p, b);
}
