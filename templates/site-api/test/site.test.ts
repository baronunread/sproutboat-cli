import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startServer, type Server } from "./server.ts";

describe("site and API", () => {
  let server: Server;
  // The list may already hold addresses (a server that was running before), so each run uses its own.
  const tag = `t${Date.now().toString(36)}`;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  const subscribe = (body: string, type = "application/json") =>
    fetch(server.base + "/api/subscribe", { method: "POST", headers: { "content-type": type }, body });
  const count = async () =>
    ((await (await fetch(server.base + "/api/subscribers/count")).json()) as { count: number }).count;

  test("serves the page and its files from public/", async () => {
    const home = await fetch(server.base + "/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await home.text(), /Site with an API/);
    const script = await fetch(server.base + "/app.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match((await fetch(server.base + "/style.css")).headers.get("content-type") ?? "", /css/);
  });

  test("answers a path with no file with the 404 page", async () => {
    const missing = await fetch(server.base + "/no/such/page");
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Not found/);
  });

  test("keeps /api/* for the handler", async () => {
    const health = await fetch(server.base + "/api/health");
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get("cache-control"), "no-store");
    const unknown = await fetch(server.base + "/api/nothing");
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "no such route" });
  });

  test("subscribes an address once, in any case", async () => {
    const before = await count();
    const first = await subscribe(JSON.stringify({ email: `  Ada.${tag}@Example.com ` }));
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { subscribed: true, already: false });
    const again = await subscribe(JSON.stringify({ email: `ada.${tag}@example.com` }));
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { subscribed: true, already: true });
    assert.equal(await count(), before + 1);
  });

  test("refuses what is not an address, and the wrong method or media type", async () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ email: "nope" }), JSON.stringify({ email: 5 }), "{"])
      assert.equal((await subscribe(body)).status, 400, body);
    assert.equal((await subscribe("email=a@b.co", "application/x-www-form-urlencoded")).status, 415);
    const wrong = await fetch(server.base + "/api/subscribe");
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
  });
});
