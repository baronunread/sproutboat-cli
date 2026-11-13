import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startServer, type Server } from "./server.ts";

interface Record {
  id: string;
  status: string;
  digest?: { total: number; byName: { [name: string]: number } };
}

describe("jobs, end to end", () => {
  let server: Server;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  const post = (path: string, body: unknown) =>
    fetch(server.base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /** The consumer runs out of band, so poll rather than assume it already has. */
  async function until(id: string, status: string): Promise<Record> {
    for (let i = 0; i < 80; i++) {
      const record = (await (await fetch(`${server.base}/jobs/${id}`)).json()) as Record;
      if (record.status === status) return record;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`job ${id} never reached ${status}`);
  }

  test("a queued digest job is processed by the consumer and stored", async () => {
    const name = `t${Date.now().toString(36)}`;
    for (let i = 0; i < 3; i++) assert.equal((await post("/events", { name })).status, 201);

    const queued = await post("/jobs", {});
    assert.equal(queued.status, 202);
    const job = (await queued.json()) as { id: string; date: string };
    assert.equal(queued.headers.get("location"), `/jobs/${job.id}`);

    const done = await until(job.id, "done");
    assert.ok((done.digest?.byName[name] ?? 0) >= 3);
    const stored = (await (await fetch(`${server.base}/digests/${job.date}`)).json()) as { total: number };
    assert.ok(stored.total >= 3);
  });

  test("refuses what it cannot queue or record", async () => {
    assert.equal((await post("/events", { name: "Not Valid" })).status, 400);
    assert.equal((await post("/events", {})).status, 400);
    assert.equal((await post("/jobs", { date: "yesterday" })).status, 400);
    assert.equal((await post("/jobs", { date: "2026-13-45" })).status, 400);
    assert.equal((await fetch(`${server.base}/jobs/unknown-id`)).status, 404);
    assert.equal((await fetch(`${server.base}/digests/1999-01-01`)).status, 404);
  });
});
