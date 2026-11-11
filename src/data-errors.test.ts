import { describe, expect, test } from "bun:test";
import { CAPTURE_ACTIVE, dataErrorMessage, type DataContext, type DataReply } from "./data-errors";

const d1: DataContext = { project: "hello", product: "D1", noun: "database", name: "DB", write: true };
const r2: DataContext = { project: "hello", product: "R2", noun: "bucket", name: "FILES", write: false };
const say = (reply: DataReply, context = d1) => dataErrorMessage(reply, context) ?? "";

describe("504: what happened to the write", () => {
  test("committed: no is the agent's deadline, rolled back; committed: unknown is the Cloud's, may or may not have been applied", () => {
    expect(say({ status: 504, body: { reason: "timeout", committed: "no" } })).toContain(
      "rolled back: nothing was committed",
    );
    const unknown = say({ status: 504, body: { reason: "timeout", committed: "unknown" } });
    expect(unknown).toContain("may or may not have been applied");
    expect(unknown).not.toContain("rolled back");
    expect(say({ status: 504, body: { reason: "timeout" } })).toContain("may or may not have been applied");
  });
  test("R2, and a read: no claim about a write", () => {
    expect(say({ status: 504, body: { reason: "timeout", committed: "no" } }, r2)).toContain("nothing was changed");
    const read = say({ status: 504, body: { reason: "timeout", committed: "unknown" } }, r2);
    expect(read).not.toContain("applied");
    expect(say({ status: 504, body: { committed: "unknown" } }, { ...r2, write: true })).toContain(
      "may or may not have been applied",
    );
  });
});

describe("502 and 501: 'not available yet' only when the routes are missing", () => {
  test("a 502 with a reason shows the reason and message", () => {
    const message = say({
      status: 502,
      body: { reason: "agent-error", error: "the host agent could not handle the request (500)" },
    });
    expect(message).toContain("agent-error");
    expect(message).toContain("the host agent could not handle the request (500)");
    expect(message).not.toContain("isn't available");
  });
  test("a 502 without a reason, and a 501, say it is not available yet", () => {
    expect(say({ status: 502, body: {} })).toContain("isn't available on this Cloud host yet");
    expect(say({ status: 502 })).toContain("isn't available on this Cloud host yet");
    expect(say({ status: 501 })).toContain("isn't available on this Cloud host yet");
  });
});

describe("409 capture-active and 400 invalid paths", () => {
  test("capture-active is the new, permanent wording", () => {
    expect(CAPTURE_ACTIVE).toBe(
      "remote writes are not available for a database with backup capture on; write through your app",
    );
    expect(say({ status: 409, body: { reason: "capture-active" } })).toBe(CAPTURE_ACTIVE);
    expect(say({ status: 409, body: { reason: "capture-active" } })).not.toContain("retry");
  });
  test("key, database and bucket each say what was rejected", () => {
    expect(
      say({ status: 400, body: { reason: "invalid", path: "key", error: 'the key has a ".." segment' } }, r2),
    ).toBe('the Cloud rejected the object key: the key has a ".." segment');
    expect(say({ status: 400, body: { reason: "invalid", path: "database", error: "invalid database name" } })).toBe(
      'the Cloud rejected the database name "DB": invalid database name',
    );
    expect(say({ status: 400, body: { reason: "invalid", path: "bucket", error: "invalid bucket name" } }, r2)).toBe(
      'the Cloud rejected the bucket name "FILES": invalid bucket name',
    );
    expect(say({ status: 400, body: { reason: "invalid", path: "statements[0].sql", error: "x" } })).toBe(
      "the Cloud rejected the request (statements[0].sql): x",
    );
  });
});
