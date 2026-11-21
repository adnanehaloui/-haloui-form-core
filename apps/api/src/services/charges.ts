/**
 * Charges: hold → capture | release, and refunds. The only code path that moves wallet money
 * for app usage. Called exclusively from developer-secret-key routes (hard rule 3).
 */
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { apps, approvalRequests, charges, installs, orgMembers, prices, spendLimits, type DbOrTx } from "@aix/db";
import {
  evaluateSpend,
  formatMoney,
  multiplyCents,
  newId,
  periodStart,
  postCapture,
  postHold,
  postRefund,
  postRelease,
  type Currency,
  type SpendLimitRule,
} from "@aix/core";
import type { Deps } from "../context.js";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors.js";
import { balance, ensureDeveloperAccount, lockAccount, PLATFORM, postTransaction, walletAccountIds } from "./ledger.js";
import { audit } from "./audit.js";
import { getOrCreateOrgWallet, getOrCreateUserWallet } from "./wallets.js";
import { assertAppAllowedForUser } from "./policies.js";
import { notifyDeveloper } from "./dev-webhooks.js";

const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_HOLD_TTL_SEC = 24 * 3600;

export type Charge = typeof charges.$inferSelect;

export interface HoldInput {
  userId: string;
  /** AIX price id (price_…) or the developer's lookup key (e.g. "render"). */
  priceId: string;
  /** Required when a lookup key is used by more than one of the developer's apps. */
  appId?: string | undefined;
  quantity: number;
  idempotencyKey: string;
  runId?: string | undefined;
  holdTtlSeconds?: number | undefined;
}

export function publicCharge(c: Charge, appName?: string) {
  return {
    id: c.id,
    object: "charge" as const,
    status: c.status,
    appId: c.appId,
    ...(appName ? { appName } : {}),
    userId: c.userId,
    walletId: c.walletId,
    orgId: c.orgId,
    priceId: c.priceId,
    quantity: c.quantity,
    freeUnits: c.freeUnits,
    amountCents: c.amountCents,
    currency: c.currency,
    display: formatMoney(c.amountCents, c.currency as Currency),
    idempotencyKey: c.idempotencyKey,
    runId: c.runId,
    holdExpiresAt: c.holdExpiresAt,
    capturedAt: c.capturedAt,
    releasedAt: c.releasedAt,
    refundedAt: c.refundedAt,
    failureReason: c.failureReason,
    createdAt: c.createdAt,
  };
}

/** Resolve a price owned by this developer. Prices always come from the server-side catalog (hard rule 6). */
export async function resolvePrice(db: DbOrTx, developerId: string, priceRef: string, appId?: string) {
  const rows = await db
    .select({ price: prices, app: apps })
    .from(prices)
    .innerJoin(apps, eq(apps.id, prices.appId))
    .where(and(eq(apps.developerId, developerId), or(eq(prices.id, priceRef), eq(prices.lookupKey, priceRef)), appId ? or(eq(apps.id, appId), eq(apps.manifestId, appId)) : undefined));
  if (rows.length === 0) throw notFound(`price ${priceRef} not found for this developer`);
  const exact = rows.filter((r) => r.price.id === priceRef);
  if (exact.length === 1) return exact[0]!;
  if (rows.length > 1) throw badRequest(`price lookup key "${priceRef}" is used by several apps — pass appId`);
  return rows[0]!;
}

async function activeInstall(db: DbOrTx, userId: string, appId: string) {
  const [i] = await db.select().from(installs).where(and(eq(installs.userId, userId), eq(installs.appId, appId), isNull(installs.uninstalledAt)));
  return i ?? null;
}

async function spentSince(db: DbOrTx, where: ReturnType<typeof and>, since: Date) {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${charges.amountCents}), 0)` })
    .from(charges)
    .where(and(where, inArray(charges.status, ["held", "captured"]), gte(charges.createdAt, since)));
  return Number(r?.s ?? 0);
}

/** Collect every spend rule that applies to this charge, with current period spend. */
export async function collectSpendRules(db: DbOrTx, p: { userId: string; appId: string; orgId: string | null; now: Date }): Promise<SpendLimitRule[]> {
  const rows = await db
    .select()
    .from(spendLimits)
    .where(
      or(
        and(eq(spendLimits.scope, "user"), eq(spendLimits.userId, p.userId)),
        and(eq(spendLimits.scope, "app"), eq(spendLimits.userId, p.userId), eq(spendLimits.appId, p.appId)),
        p.orgId ? and(eq(spendLimits.scope, "org_member"), eq(spendLimits.orgId, p.orgId), or(eq(spendLimits.userId, p.userId), isNull(spendLimits.userId))) : undefined,
      ),
    );
  const rules: SpendLimitRule[] = [];
  for (const r of rows) {
    const since = periodStart(r.period, p.now);
    let spent: number;
    if (r.scope === "user") spent = await spentSince(db, and(eq(charges.userId, p.userId)), since);
    else if (r.scope === "app") spent = await spentSince(db, and(eq(charges.userId, p.userId), eq(charges.appId, p.appId)), since);
    else spent = await spentSince(db, and(eq(charges.userId, p.userId), eq(charges.orgId, p.orgId!)), since);
    rules.push({
      label: `${r.scope === "org_member" ? "org member" : r.scope} ${r.period}`,
      period: r.period,
      capCents: r.capCents,
      autoApproveThresholdCents: r.autoApproveThresholdCents,
      spentCents: spent,
    });
  }
  return rules;
}

/** Reserve money before expensive work. Idempotent on (app, idempotencyKey). */
export async function hold(deps: Deps, developerId: string, input: HoldInput): Promise<Charge> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw badRequest("quantity must be a positive integer");
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw badRequest("idempotencyKey is required (≤ 200 chars)");
  const now = deps.now();

  const { price, app } = await resolvePrice(deps.db, developerId, input.priceId, input.appId);
  if (!price.active) throw badRequest("price is not active");
  if (price.kind === "subscription") throw badRequest("subscription prices are billed by Stripe, not with holds — use entitlements.check");
  if (app.status !== "published") throw new ApiError(403, "forbidden", "app is not published");

  // Idempotent replay (fast path, re-checked under lock below).
  const replay = await findCharge(deps.db, app.id, input.idempotencyKey);
  if (replay) return assertSameRequest(replay, input, price.id);

  const install = await activeInstall(deps.db, input.userId, app.id);
  if (!install) throw new ApiError(403, "not_installed", "user has not installed this app");
  await assertAppAllowedForUser(deps, input.userId, app.id, install.orgId);

  const wallet = install.orgId ? await getOrCreateOrgWallet(deps.db, install.orgId) : await getOrCreateUserWallet(deps.db, input.userId);
  const acct = walletAccountIds(wallet.id);

  // Errors that must COMMIT their side effects (a new approval request) are returned, then thrown.
  const result = await deps.db.transaction(async (tx): Promise<Charge | { deferredError: ApiError }> => {
    await lockAccount(tx, acct.available);
    const again = await findCharge(tx, app.id, input.idempotencyKey);
    if (again) return assertSameRequest(again, input, price.id);

    // Free units (lifetime per user per price, see docs/decisions.md).
    let freeUnits = 0;
    if (price.includedUnits > 0) {
      const [u] = await tx
        .select({ used: sql<string>`coalesce(sum(${charges.freeUnits}), 0)` })
        .from(charges)
        .where(and(eq(charges.userId, input.userId), eq(charges.priceId, price.id), inArray(charges.status, ["held", "captured"])));
      freeUnits = Math.min(input.quantity, Math.max(0, price.includedUnits - Number(u?.used ?? 0)));
    }
    const billableUnits = input.quantity - freeUnits;
    const amountCents = price.kind === "free" || billableUnits === 0 ? 0 : multiplyCents(price.unitAmountCents, billableUnits);

    // Spend limits + approval.
    const [approval] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.appId, app.id), eq(approvalRequests.idempotencyKey, input.idempotencyKey)));
    if (approval?.status === "denied") throw new ApiError(402, "needs_user_approval", "the user declined this charge", { approvalId: approval.id, status: "denied" });
    const preApproved = approval?.status === "approved" && approval.amountCents >= amountCents && approval.expiresAt > now;
    const rules = await collectSpendRules(tx, { userId: input.userId, appId: app.id, orgId: install.orgId, now });
    const decision = evaluateSpend(amountCents, rules, { preApproved });
    if (decision.decision === "exceeded") {
      throw new ApiError(402, "spend_limit_exceeded", decision.reason, { rule: decision.rule, capCents: decision.capCents, spentCents: decision.spentCents });
    }
    if (decision.decision === "needs_approval") {
      let a = approval && approval.status === "pending" && approval.expiresAt > now ? approval : null;
      if (!a) {
        const id = newId("apr");
        const values = {
          id,
          userId: input.userId,
          appId: app.id,
          priceId: price.id,
          quantity: input.quantity,
          amountCents,
          currency: price.currency,
          idempotencyKey: input.idempotencyKey,
          status: "pending" as const,
          expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        };
        const inserted = await tx
          .insert(approvalRequests)
          .values(values)
          .onConflictDoUpdate({ target: [approvalRequests.appId, approvalRequests.idempotencyKey], set: { ...values, id: sql`approval_requests.id`, decidedAt: null } })
          .returning();
        a = inserted[0] ?? null;
      }
      return { deferredError: new ApiError(402, "needs_user_approval", `This costs ${formatMoney(amountCents)} — the user must approve it`, {
        approvalId: a!.id,
        approvalUrl: `${deps.config.AIX_WEB_URL}/approve/${a!.id}`,
        amountCents,
        display: formatMoney(amountCents),
        appName: app.name,
        expiresAt: a!.expiresAt,
      }) };
    }

    if (amountCents > 0) {
      const available = await balance(tx, acct.available);
      if (available < amountCents) {
        throw new ApiError(402, "insufficient_funds", `wallet balance ${formatMoney(available)} is below ${formatMoney(amountCents)}`, {
          availableCents: available,
          requiredCents: amountCents,
          topUpUrl: `${deps.config.AIX_WEB_URL}/wallet`,
        });
      }
    }

    const ttl = Math.min(input.holdTtlSeconds ?? deps.config.AIX_HOLD_TTL_SECONDS, MAX_HOLD_TTL_SEC);
    const [charge] = await tx
      .insert(charges)
      .values({
        id: newId("chg"),
        appId: app.id,
        walletId: wallet.id,
        userId: input.userId,
        orgId: install.orgId,
        priceId: price.id,
        quantity: input.quantity,
        freeUnits,
        amountCents,
        currency: price.currency,
        idempotencyKey: input.idempotencyKey,
        runId: input.runId ?? null,
        status: "held",
        holdExpiresAt: new Date(now.getTime() + ttl * 1000),
      })
      .returning();
    if (amountCents > 0) {
      await postTransaction(tx, postHold({ walletAvailable: acct.available, walletHeld: acct.held }, amountCents, price.currency as Currency), {
        chargeId: charge!.id,
        description: `Hold for ${app.name}`,
      });
    }
    if (approval?.status === "approved") await tx.update(approvalRequests).set({ status: "used" }).where(eq(approvalRequests.id, approval.id));
    await audit(tx, {
      actorUserId: input.userId,
      actorType: "developer",
      orgId: install.orgId,
      action: "charge.held",
      targetType: "charge",
      targetId: charge!.id,
      metadata: { appId: app.id, amountCents, quantity: input.quantity, freeUnits, runId: input.runId ?? null },
    });
    return charge!;
  });
  if ("deferredError" in result) throw result.deferredError;
  return result;
}

async function findCharge(db: DbOrTx, appId: string, idempotencyKey: string) {
  const [c] = await db.select().from(charges).where(and(eq(charges.appId, appId), eq(charges.idempotencyKey, idempotencyKey)));
  return c ?? null;
}

function assertSameRequest(c: Charge, input: HoldInput, priceId: string): Charge {
  if (c.userId !== input.userId || c.priceId !== priceId || c.quantity !== input.quantity) {
    throw new ApiError(409, "idempotency_mismatch", "idempotencyKey was already used with different parameters", { chargeId: c.id });
  }
  return c;
}

async function lockCharge(tx: DbOrTx, developerId: string, chargeId: string) {
  const [row] = await tx
    .select({ charge: charges, app: apps })
    .from(charges)
    .innerJoin(apps, eq(apps.id, charges.appId))
    .where(and(eq(charges.id, chargeId), eq(apps.developerId, developerId)))
    .for("update", { of: charges });
  if (!row) throw notFound("charge not found");
  return row;
}

/** Take the money: held → developer payable + platform revenue. Idempotent. */
export async function capture(deps: Deps, developerId: string, chargeId: string): Promise<Charge> {
  const updated = await deps.db.transaction(async (tx) => {
    const { charge, app } = await lockCharge(tx, developerId, chargeId);
    if (charge.status === "captured") return { charge, fresh: false };
    if (charge.status !== "held") throw conflict(`charge is ${charge.status}, cannot capture`);
    if (charge.holdExpiresAt && charge.holdExpiresAt < deps.now()) throw conflict("hold has expired; create a new hold");
    let developerCents = 0;
    let platformCents = 0;
    if (charge.amountCents > 0) {
      const acct = walletAccountIds(charge.walletId);
      const payable = await ensureDeveloperAccount(tx, app.developerId, charge.currency);
      const draft = postCapture(
        { walletHeld: acct.held, developerPayable: payable, platformRevenue: PLATFORM.revenue },
        charge.amountCents,
        app.commissionBps,
        charge.currency as Currency,
      );
      developerCents = draft.entries.find((e) => e.account === payable)?.amountCents ?? 0;
      platformCents = charge.amountCents - developerCents;
      await postTransaction(tx, draft, { chargeId: charge.id, description: `${app.name}` });
    }
    const [c] = await tx
      .update(charges)
      .set({ status: "captured", capturedAt: deps.now(), developerCents, platformCents })
      .where(eq(charges.id, charge.id))
      .returning();
    await audit(tx, { actorUserId: charge.userId, actorType: "developer", orgId: charge.orgId, action: "charge.captured", targetType: "charge", targetId: charge.id, metadata: { appId: app.id, amountCents: charge.amountCents } });
    return { charge: c!, fresh: true };
  });
  if (updated.fresh) notifyDeveloper(deps, developerId, "charge.captured", publicCharge(updated.charge));
  return updated.charge;
}

/** Work failed / cancelled: held → available. Idempotent. */
export async function release(deps: Deps, developerId: string | null, chargeId: string, reason?: string): Promise<Charge> {
  return deps.db.transaction(async (tx) => {
    let charge: Charge;
    if (developerId) charge = (await lockCharge(tx, developerId, chargeId)).charge;
    else {
      const [c] = await tx.select().from(charges).where(eq(charges.id, chargeId)).for("update");
      if (!c) throw notFound("charge not found");
      charge = c;
    }
    if (charge.status === "released") return charge;
    if (charge.status !== "held") throw conflict(`charge is ${charge.status}, cannot release`);
    if (charge.amountCents > 0) {
      const acct = walletAccountIds(charge.walletId);
      await postTransaction(tx, postRelease({ walletHeld: acct.held, walletAvailable: acct.available }, charge.amountCents, charge.currency as Currency), {
        chargeId: charge.id,
        description: reason ? `Released: ${reason.slice(0, 100)}` : "Released",
      });
    }
    const [c] = await tx
      .update(charges)
      .set({ status: "released", releasedAt: deps.now(), failureReason: reason?.slice(0, 200) ?? null })
      .where(eq(charges.id, charge.id))
      .returning();
    await audit(tx, { actorUserId: charge.userId, actorType: developerId ? "developer" : "system", orgId: charge.orgId, action: "charge.released", targetType: "charge", targetId: charge.id, metadata: { reason: reason ?? null } });
    return c!;
  });
}

/** Admin refund of a captured charge: reverse the capture split back into the wallet. */
export async function refund(deps: Deps, chargeId: string, actorUserId: string, reason: string): Promise<Charge> {
  const result = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ charge: charges, app: apps }).from(charges).innerJoin(apps, eq(apps.id, charges.appId)).where(eq(charges.id, chargeId)).for("update", { of: charges });
    if (!row) throw notFound("charge not found");
    const { charge, app } = row;
    if (charge.status === "refunded") return { charge, developerId: app.developerId };
    if (charge.status !== "captured") throw conflict(`charge is ${charge.status}, only captured charges can be refunded`);
    if (charge.amountCents > 0) {
      const acct = walletAccountIds(charge.walletId);
      const payable = await ensureDeveloperAccount(tx, app.developerId, charge.currency);
      await postTransaction(
        tx,
        postRefund(
          { walletAvailable: acct.available, developerPayable: payable, platformRevenue: PLATFORM.revenue },
          { developerCents: charge.developerCents ?? 0, platformCents: charge.platformCents ?? 0 },
          charge.currency as Currency,
        ),
        { chargeId: charge.id, description: `Refund: ${reason.slice(0, 100)}` },
      );
    }
    const [c] = await tx.update(charges).set({ status: "refunded", refundedAt: deps.now() }).where(eq(charges.id, charge.id)).returning();
    await audit(tx, { actorUserId, actorType: "admin", orgId: charge.orgId, action: "charge.refunded", targetType: "charge", targetId: charge.id, metadata: { reason } });
    return { charge: c!, developerId: app.developerId };
  });
  notifyDeveloper(deps, result.developerId, "charge.refunded", publicCharge(result.charge));
  return result.charge;
}

/** Job: release holds past their expiry. Returns how many were released. */
export async function expireHolds(deps: Deps): Promise<number> {
  const expired = await deps.db.select({ id: charges.id }).from(charges).where(and(eq(charges.status, "held"), lt(charges.holdExpiresAt, deps.now())));
  let n = 0;
  for (const c of expired) {
    try {
      await release(deps, null, c.id, "hold_expired");
      n++;
    } catch {
      // raced with a capture — fine
    }
  }
  return n;
}

/** Is the user a member of the org right now? (Used when an org install pays.) */
export async function isOrgMember(db: DbOrTx, orgId: string, userId: string) {
  const [m] = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
  return m ?? null;
}
