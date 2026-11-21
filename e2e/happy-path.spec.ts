import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Happy path: sign up by magic link → empty wallet → top up €20 → install Render Studio from the
 * store (permission screen) → the developer's server charges via the API → it shows in the history.
 * Expects `pnpm seed` to have run (sample apps + developer key in .env.seed).
 */
const API = "http://localhost:4000";
const seed = Object.fromEntries(
  readFileSync(require("node:path").join(__dirname, "..", ".env.seed"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => l.split(/=(.*)/s).slice(0, 2)),
) as Record<string, string>;

test("sign up, top up, install, get charged", async ({ page, request }) => {
  const email = `e2e-${Date.now()}@aix.test`;

  await page.goto("/login");
  await page.waitForLoadState("networkidle"); // wait for hydration before using client forms
  await page.getByPlaceholder("you@company.com").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByTestId("magic-sent")).toBeVisible();
  const mail = await (await request.get(`${API}/_dev/mailbox?to=${encodeURIComponent(email)}`)).json();
  await page.goto(mail.link);

  await expect(page).toHaveURL(/\/wallet/);
  await expect(page.getByTestId("balance")).toHaveText("€0.00");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/dev-checkout\//);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page).toHaveURL(/topup=success/);
  await expect(page.getByTestId("balance")).toHaveText("€20.00");

  await page.goto("/?q=render");
  await page.getByTestId("store-app").filter({ hasText: "Render Studio" }).click();
  await expect(page.getByText("€0.50 / render (first 3 free)")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByTestId("install").click();
  await expect(page.getByTestId("permissions")).toContainText("Read your email");
  await page.getByRole("button", { name: "Allow & install" }).click();
  await expect(page.getByText("Installed")).toBeVisible();

  // The developer's backend charges with its secret key (never the browser): 4 renders, 3 free → €0.50.
  const me = await (await page.request.get("/api/me")).json();
  const hold = await request.post(`${API}/v1/holds`, {
    headers: { authorization: `Bearer ${seed.AIX_SECRET_KEY}` },
    data: { userId: me.user.id, priceId: "render", quantity: 4, idempotencyKey: `e2e-${Date.now()}` },
  });
  expect(hold.ok()).toBeTruthy();
  const h = await hold.json();
  expect(h.display).toBe("€0.50");
  expect((await request.post(`${API}/v1/holds/${h.id}/capture`, { headers: { authorization: `Bearer ${seed.AIX_SECRET_KEY}` } })).ok()).toBeTruthy();

  await page.goto("/wallet");
  await expect(page.getByTestId("balance")).toHaveText("€19.50");
  await expect(page.getByTestId("history")).toContainText("Charge · Render Studio");
});
