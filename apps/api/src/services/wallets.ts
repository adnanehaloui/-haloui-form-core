import { eq } from "drizzle-orm";
import { wallets, type DbOrTx } from "@aix/db";
import { newId } from "@aix/core";
import { balances, ensureWalletAccounts, walletAccountIds } from "./ledger.js";

export async function getOrCreateUserWallet(db: DbOrTx, userId: string) {
  const [existing] = await db.select().from(wallets).where(eq(wallets.ownerUserId, userId));
  if (existing) return existing;
  const [w] = await db.insert(wallets).values({ id: newId("wal"), ownerUserId: userId }).onConflictDoNothing().returning();
  const wallet = w ?? (await db.select().from(wallets).where(eq(wallets.ownerUserId, userId)))[0]!;
  await ensureWalletAccounts(db, wallet.id, wallet.currency);
  return wallet;
}

export async function getOrCreateOrgWallet(db: DbOrTx, orgId: string) {
  const [existing] = await db.select().from(wallets).where(eq(wallets.ownerOrgId, orgId));
  if (existing) return existing;
  const [w] = await db.insert(wallets).values({ id: newId("wal"), ownerOrgId: orgId }).onConflictDoNothing().returning();
  const wallet = w ?? (await db.select().from(wallets).where(eq(wallets.ownerOrgId, orgId)))[0]!;
  await ensureWalletAccounts(db, wallet.id, wallet.currency);
  return wallet;
}

export async function walletBalance(db: DbOrTx, walletId: string) {
  const ids = walletAccountIds(walletId);
  const b = await balances(db, [ids.available, ids.held]);
  return { availableCents: b[ids.available] ?? 0, heldCents: b[ids.held] ?? 0 };
}
