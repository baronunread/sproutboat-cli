import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_LIMIT, MAX_TITLE, parseId, parseListQuery, parseNewTask, parseTaskPatch } from "../src/validate.ts";

describe("validation", () => {
  test("a task id is a positive whole number", () => {
    assert.equal(parseId("42"), 42);
    for (const bad of ["0", "-1", "1.5", "abc", "007", "", "9".repeat(20)]) assert.equal(parseId(bad), null, bad);
  });

  test("a new task needs a title, trimmed, and nothing else", () => {
    assert.deepEqual(parseNewTask({ title: "  write tests  " }), { ok: true, value: { title: "write tests" } });
    for (const body of [
      null,
      [],
      "x",
      {},
      { title: 1 },
      { title: "   " },
      { title: "x".repeat(MAX_TITLE + 1) },
      { title: "a", done: true },
    ])
      assert.equal(parseNewTask(body).ok, false, JSON.stringify(body));
  });

  test("a patch changes title, done or both, and says what is wrong", () => {
    assert.deepEqual(parseTaskPatch({ done: true }), { ok: true, value: { done: true } });
    assert.deepEqual(parseTaskPatch({ title: " a ", done: false }), { ok: true, value: { title: "a", done: false } });
    assert.equal(parseTaskPatch({}).ok, false);
    assert.equal(parseTaskPatch({ extra: 1 }).ok, false);
    const bad = parseTaskPatch({ title: 5, done: "yes" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.errors.length, 2);
  });

  test("list queries have defaults and bounds", () => {
    assert.deepEqual(parseListQuery(new URLSearchParams()), { ok: true, value: { limit: 20, after: 0 } });
    assert.deepEqual(parseListQuery(new URLSearchParams("after=0")), { ok: true, value: { limit: 20, after: 0 } });
    assert.deepEqual(parseListQuery(new URLSearchParams("limit=5&after=9&done=true")), {
      ok: true,
      value: { limit: 5, after: 9, done: true },
    });
    for (const query of ["limit=0", `limit=${MAX_LIMIT + 1}`, "limit=x", "after=-3", "after=abc", "done=maybe"])
      assert.equal(parseListQuery(new URLSearchParams(query)).ok, false, query);
  });
});
