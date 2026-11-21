import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { developers } from "@aix/db";
import { webhooks } from "@aix/sdk";
import { setup, type Ctx, fixtureApp } from "./helpers.js";
import { notifyDeveloper } from "../src/services/dev-webhooks.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(() => ctx.close());

describe("developer webhooks", () => {
  it("are signed, verifiable with the SDK, and retried after a failure", async () => {
    const received: { body: string; sig: string }[] = [];
    let attempts = 0;
    const srv = createServer(async (req, res) => {
      attempts++;
      let body = "";
      for await (const c of req) body += c;
      if (attempts === 1) return void res.writeHead(503).end(); // first attempt fails
      received.push({ body, sig: String(req.headers["aix-signature"]) });
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;

    const fx = await fixtureApp(ctx);
    const r = await ctx.app.inject({ method: "PUT", url: "/developer/webhook", headers: { authorization: `Bearer ${fx.secret}` }, payload: { url } });
    const secret = r.json().secret;
    const [d] = await ctx.db.select().from(developers).where(eq(developers.id, fx.developerId));
    expect(d!.webhookSecretEnc).not.toContain(secret); // encrypted at rest

    expect(await notifyDeveloper(ctx.deps, fx.developerId, "charge.captured", { id: "chg_1" }, [0, 10, 10])).toBe(true);
    expect(attempts).toBe(2);
    expect(webhooks.verify(received[0]!.body, received[0]!.sig, secret)).toBe(true);
    expect(webhooks.verify(received[0]!.body, received[0]!.sig, "wrong")).toBe(false);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: "charge.captured", data: { id: "chg_1" } });
    srv.close();
  });
});
