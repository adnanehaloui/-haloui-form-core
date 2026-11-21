import { and, eq } from "drizzle-orm";
import { spendLimits, users, type DbOrTx } from "@aix/db";
import { DEFAULT_USER_LIMITS, newId } from "@aix/core";
import { getOrCreateUserWallet } from "./wallets.js";
import { audit } from "./audit.js";

export function normalizeEmail(e: string) {
  return e.trim().toLowerCase();
}

/** Sign-up and sign-in share this: a new user gets a wallet and default spend limits. */
export async function findOrCreateUserByEmail(db: DbOrTx, email: string, name?: string | null) {
  const em = normalizeEmail(email);
  const [existing] = await db.select().from(users).where(eq(users.email, em));
  if (existing) return { user: existing, created: false };
  const [user] = await db.insert(users).values({ id: newId("usr"), email: em, name: name ?? null }).onConflictDoNothing().returning();
  if (!user) return { user: (await db.select().from(users).where(eq(users.email, em)))[0]!, created: false };
  await getOrCreateUserWallet(db, user.id);
  await db.insert(spendLimits).values({
    id: newId("lim"),
    scope: "user",
    userId: user.id,
    period: "monthly",
    capCents: DEFAULT_USER_LIMITS.monthlyCapCents,
    autoApproveThresholdCents: DEFAULT_USER_LIMITS.autoApproveThresholdCents,
  });
  await audit(db, { actorUserId: user.id, actorType: "user", action: "user.signup", targetType: "user", targetId: user.id });
  return { user, created: true };
}

export async function getUser(db: DbOrTx, id: string) {
  const [u] = await db.select().from(users).where(and(eq(users.id, id)));
  return u ?? null;
}
