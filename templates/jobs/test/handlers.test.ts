// The scheduled and queue handlers, called directly with fakes: a cron tick cannot be waited for in a test, and these
// two are where the logic is.
import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import worker from "../src/index.ts";
import { recordEvent } from "../src/digest.ts";
import { fakeEnv, fakeMessage } from "./fakes.ts";

const scheduled = (time: number) =>
  ({ scheduledTime: time, cron: "0 * * * *", noRetry() {} }) as unknown as ScheduledController;
const batch = (...messages: Array<ReturnType<typeof fakeMessage<{ id: string; date: string }>>["message"]>) =>
  ({ queue: "JOBS", messages }) as unknown as MessageBatch<{ id: string; date: string }>;

describe("scheduled()", () => {
  test("enqueues one digest job for the day, keyed by the hour", async () => {
    const { env, sent } = fakeEnv();
    const time = Date.UTC(2026, 10, 13, 9, 30);
    await worker.scheduled!(scheduled(time), env);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { id: `hourly-${Math.floor(time / 3_600_000)}`, date: "2026-11-13" });
  });

  test("a trigger that fires twice for the same hour enqueues once", async () => {
    const { env, sent } = fakeEnv();
    const time = Date.UTC(2026, 10, 13, 9, 0);
    await worker.scheduled!(scheduled(time), env);
    await worker.scheduled!(scheduled(time + 1000), env);
    assert.equal(sent.length, 1);
  });
});

describe("queue()", () => {
  test("counts the day's events, stores the digest and acks", async () => {
    const { env, state } = fakeEnv();
    const now = new Date("2026-11-13T10:00:00Z");
    for (const name of ["signup", "signup", "login"]) await recordEvent(env.STATE, name, now);
    await recordEvent(env.STATE, "signup", new Date("2026-11-12T10:00:00Z"));

    const { message, calls } = fakeMessage({ id: "job-1", date: "2026-11-13" });
    await worker.queue!(batch(message), env);
    assert.deepEqual(calls, ["ack"]);

    const digest = JSON.parse(state.store.get("digest:2026-11-13") ?? "null");
    assert.equal(digest.total, 3);
    assert.deepEqual(digest.byName, { signup: 2, login: 1 });
    assert.equal(JSON.parse(state.store.get("job:job-1") ?? "null").status, "done");
  });

  test("a redelivered message is acked without doing the work again", async () => {
    const { env, state } = fakeEnv();
    const first = fakeMessage({ id: "job-2", date: "2026-11-13" });
    await worker.queue!(batch(first.message), env);
    const stored = state.store.get("digest:2026-11-13");
    await recordEvent(env.STATE, "late", new Date("2026-11-13T11:00:00Z"));
    const again = fakeMessage({ id: "job-2", date: "2026-11-13" }, 2);
    await worker.queue!(batch(again.message), env);
    assert.deepEqual(again.calls, ["ack"]);
    assert.equal(state.store.get("digest:2026-11-13"), stored);
  });

  test("a failure is retried with a growing delay, then recorded and acked", async () => {
    const { env, state } = fakeEnv();
    mock.method(console, "error", () => {}); // the consumer logs each failed attempt; this test makes three
    state.list = async () => {
      throw new Error("list is down");
    };
    const job = { id: "job-3", date: "2026-11-13" };
    for (const [attempt, expected] of [
      [1, "retry:2"],
      [2, "retry:4"],
      [3, "ack"],
    ] as const) {
      const { message, calls } = fakeMessage(job, attempt);
      await worker.queue!(batch(message), env);
      assert.deepEqual(calls, [expected], `attempt ${attempt}`);
    }
    const record = JSON.parse(state.store.get("job:job-3") ?? "null");
    assert.equal(record.status, "failed");
    assert.equal(record.error, "list is down");
    assert.equal(record.attempts, 3);
  });
});
