/**
 * `aix dev` mock of the AIX developer API: an in-memory test wallet with FAKE money.
 * Same routes and error codes as the real /v1 API, so @aix/sdk works unchanged.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { Manifest } from "@aix/manifest";

export const DEV_SECRET_KEY = "aixsk_test_local_dev";
export const DEV_USER_TOKEN = "aix_dev_user_token";
export const DEV_USER = { id: "usr_dev", email: "dev@aix.local", name: "Dev User" };

interface MockCharge { id: string; status: "held" | "captured" | "released"; amountCents: number; quantity: number; priceId: string; idempotencyKey: string; runId: string | null; createdAt: string }

export interface MockState { availableCents: number; heldCents: number; charges: MockCharge[]; autoApproveThresholdCents: number; approvals: Map<string, "pending" | "approved" | "denied"> }

function parseDisplayPrice(s: string | undefined): number {
  const m = /(\d+)(?:[.,](\d{1,2}))?/.exec(s ?? "");
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : 0;
}

export function mockPrices(m: Manifest) {
  const free = m.pricing.find((p) => p.kind === "free") as { includedUnits?: number } | undefined;
  return m.pricing
    .filter((p) => p.kind === "metered" || p.kind === "one_time")
    .map((p: any) => ({ id: `price_dev_${p.unit ?? "run"}`, lookupKey: p.unit ?? "run", unit: p.unit ?? "run", unitAmountCents: parseDisplayPrice(p.displayPrice) || 50, includedUnits: free?.includedUnits ?? 0 }));
}

export function startMockApi(manifest: Manifest, port = 4900, opts: { startingBalanceCents?: number } = {}): Promise<{ server: Server; state: MockState; url: string }> {
  const state: MockState = { availableCents: opts.startingBalanceCents ?? 10_000, heldCents: 0, charges: [], autoApproveThresholdCents: 100, approvals: new Map() };
  const prices = mockPrices(manifest);
  const err = (code: string, message: string, details?: unknown) => ({ status: code === "unauthorized" ? 401 : code === "not_found" ? 404 : code === "idempotency_mismatch" ? 409 : 402, body: { error: { code, message, details } } });
  const fmt = (c: number) => `€${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  const view = (c: MockCharge) => ({ ...c, object: "charge", userId: DEV_USER.id, currency: "EUR", display: fmt(c.amountCents) });

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/_mock/wallet") return send(200, { ...state, approvals: Object.fromEntries(state.approvals) });
    if (url.pathname.startsWith("/_mock/approve/")) {
      state.approvals.set(url.pathname.split("/").pop()!, "approved");
      return send(200, { ok: true });
    }
    if (req.headers.authorization !== `Bearer ${DEV_SECRET_KEY}`) return send(401, { error: { code: "unauthorized", message: `use AIX_SECRET_KEY=${DEV_SECRET_KEY} with aix dev` } });

    const route = `${req.method} ${url.pathname}`;
    let r: { status: number; body: unknown } = { status: 404, body: { error: { code: "not_found", message: route } } };
    if (route === "POST /v1/auth/verify") {
      r = body.token === DEV_USER_TOKEN || String(body.token).startsWith("aix_dev_") ? { status: 200, body: { user: { ...DEV_USER, appId: "app_dev", manifestId: manifest.id, orgId: null, runId: null } } } : err("unauthorized", "invalid AIX user token (dev: use aix_dev_user_token)");
    } else if (route === "POST /v1/holds") {
      const p = prices.find((x) => x.id === body.priceId || x.lookupKey === body.priceId);
      const existing = state.charges.find((c) => c.idempotencyKey === body.idempotencyKey);
      const qty = body.quantity ?? 1;
      if (existing) r = existing.quantity === qty ? { status: 200, body: view(existing) } : err("idempotency_mismatch", "idempotencyKey reused with different parameters");
      else if (!p) r = err("not_found", `price ${body.priceId} not in aix.json pricing`);
      else {
        const usedFree = state.charges.filter((c) => c.priceId === p.id && c.status !== "released").length;
        const free = Math.min(qty, Math.max(0, p.includedUnits - usedFree));
        const amount = (qty - free) * p.unitAmountCents;
        const approvalId = `apr_dev_${body.idempotencyKey}`;
        if (amount > state.autoApproveThresholdCents && state.approvals.get(approvalId) !== "approved") {
          state.approvals.set(approvalId, "pending");
          r = err("needs_user_approval", `This costs ${fmt(amount)} — the user must approve it`, { approvalId, approvalUrl: `http://localhost:${port}/_mock/approve/${approvalId}`, amountCents: amount, display: fmt(amount) });
        } else if (amount > state.availableCents) r = err("insufficient_funds", "test wallet is empty", { availableCents: state.availableCents });
        else {
          const c: MockCharge = { id: `chg_dev_${randomBytes(4).toString("hex")}`, status: "held", amountCents: amount, quantity: qty, priceId: p.id, idempotencyKey: body.idempotencyKey, runId: body.runId ?? null, createdAt: new Date().toISOString() };
          state.availableCents -= amount;
          state.heldCents += amount;
          state.charges.push(c);
          r = { status: 200, body: view(c) };
        }
      }
    } else if (/^POST \/v1\/holds\/[^/]+\/(capture|release)$/.test(route)) {
      const [, , , id, action] = url.pathname.split("/");
      const c = state.charges.find((x) => x.id === id);
      if (!c) r = err("not_found", "charge not found");
      else {
        if (c.status === "held") {
          state.heldCents -= c.amountCents;
          if (action === "capture") c.status = "captured";
          else {
            c.status = "released";
            state.availableCents += c.amountCents;
          }
        }
        r = { status: 200, body: view(c) };
      }
    } else if (route === "POST /v1/entitlements/check") {
      r = { status: 200, body: { entitled: true, kind: "metered", freeUnitsRemaining: 0 } };
    } else if (route === "POST /v1/usage") {
      r = { status: 200, body: { results: (body.records ?? []).map((x: any) => ({ idempotencyKey: x.idempotencyKey, ok: true })) } };
    }
    send(r.status, r.body);
  });
  return new Promise((ok) => server.listen(port, () => ok({ server, state, url: `http://localhost:${port}` })));
}
