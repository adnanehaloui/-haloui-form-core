import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { resetDatabase } from "./testing.js";
import { ledgerAccounts, ledgerEntries, ledgerTransactions, users, wallets } from "./schema.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://aix:aix@localhost:5432/aix_test";
const { db, close } = createDb(url, { max: 2 });

beforeAll(async () => {
  await resetDatabase(db);
  await db.insert(users).values({ id: "usr_1", email: "a@example.com" });
  await db.insert(wallets).values({ id: "wal_1", ownerUserId: "usr_1" });
  await db.insert(ledgerAccounts).values({ id: "acct_w", kind: "wallet_available", walletId: "wal_1" });
});
afterAll(() => close());

describe("database ledger guards", () => {
  it("accepts a balanced transaction", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(ledgerTransactions).values({ id: "tx_ok", kind: "seed", currency: "EUR" });
      await tx.insert(ledgerEntries).values([
        { id: "e1", transactionId: "tx_ok", accountId: "acct_stripe_clearing_eur", direction: "debit", amountCents: 100 },
        { id: "e2", transactionId: "tx_ok", accountId: "acct_w", direction: "credit", amountCents: 100 },
      ]);
    });
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, "tx_ok"))).toHaveLength(2);
  });

  it("rejects an unbalanced transaction at commit", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(ledgerTransactions).values({ id: "tx_bad", kind: "seed", currency: "EUR" });
        await tx.insert(ledgerEntries).values([
          { id: "e3", transactionId: "tx_bad", accountId: "acct_stripe_clearing_eur", direction: "debit", amountCents: 100 },
          { id: "e4", transactionId: "tx_bad", accountId: "acct_w", direction: "credit", amountCents: 99 },
        ]);
      }),
    ).rejects.toThrow();
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, "tx_bad"))).toHaveLength(0);
  });

  it("rejects non-positive amounts", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(ledgerTransactions).values({ id: "tx_neg", kind: "seed", currency: "EUR" });
        await tx.insert(ledgerEntries).values({ id: "e5", transactionId: "tx_neg", accountId: "acct_w", direction: "credit", amountCents: -1 });
      }),
    ).rejects.toThrow();
  });

  it("forbids UPDATE and DELETE on ledger rows", async () => {
    await expect(db.update(ledgerEntries).set({ amountCents: 1 }).where(eq(ledgerEntries.id, "e1"))).rejects.toThrow();
    await expect(db.delete(ledgerEntries).where(eq(ledgerEntries.id, "e1"))).rejects.toThrow();
    await expect(db.delete(ledgerTransactions).where(eq(ledgerTransactions.id, "tx_ok"))).rejects.toThrow();
  });
});
