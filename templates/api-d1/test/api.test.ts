import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startServer, type Server } from "./server.ts";

interface Task {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

describe("tasks API", () => {
  let server: Server;
  // The database may already hold rows (a server that was running before), so every title carries this run's tag.
  const tag = `t${Date.now().toString(36)}`;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  const send = (path: string, init?: RequestInit & { json?: unknown }) =>
    fetch(server.base + path, {
      ...init,
      headers: { ...(init?.json === undefined ? {} : { "content-type": "application/json" }), ...init?.headers },
      body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
    });
  const create = async (title: string): Promise<Task> => {
    const response = await send("/tasks", { method: "POST", json: { title } });
    assert.equal(response.status, 201);
    return (await response.json()) as Task;
  };

  test("creates a task and says where it is", async () => {
    const response = await send("/tasks", { method: "POST", json: { title: `${tag} first ` } });
    assert.equal(response.status, 201);
    const task = (await response.json()) as Task;
    assert.equal(task.title, `${tag} first`);
    assert.equal(task.done, false);
    assert.ok(task.id > 0);
    assert.ok(!Number.isNaN(Date.parse(task.createdAt)));
    assert.equal(response.headers.get("location"), `/tasks/${task.id}`);
  });

  test("reads, changes and deletes one task", async () => {
    const task = await create(`${tag} lifecycle`);
    const read = await send(`/tasks/${task.id}`);
    assert.deepEqual(await read.json(), task);

    const patched = await send(`/tasks/${task.id}`, { method: "PATCH", json: { done: true } });
    assert.equal(patched.status, 200);
    const done = (await patched.json()) as Task;
    assert.equal(done.done, true);
    assert.equal(done.title, task.title);

    const renamed = (await (
      await send(`/tasks/${task.id}`, { method: "PATCH", json: { title: `${tag} renamed` } })
    ).json()) as Task;
    assert.equal(renamed.title, `${tag} renamed`);
    assert.equal(renamed.done, true);

    assert.equal((await send(`/tasks/${task.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await send(`/tasks/${task.id}`)).status, 404);
    assert.equal((await send(`/tasks/${task.id}`, { method: "DELETE" })).status, 404);
  });

  test("lists in pages, oldest first, and filters on done", async () => {
    const made = [await create(`${tag} page 1`), await create(`${tag} page 2`), await create(`${tag} page 3`)];
    await send(`/tasks/${made[1].id}`, { method: "PATCH", json: { done: true } });

    const seen: Task[] = [];
    let after = 0;
    for (let pages = 0; pages < 1000; pages++) {
      const response = await send(`/tasks?limit=2&after=${after}`);
      const page = (await response.json()) as { tasks: Task[]; next: number | null };
      assert.ok(page.tasks.length <= 2);
      seen.push(...page.tasks);
      if (page.next === null) break;
      after = page.next;
    }
    const ours = seen.filter((task) => task.title.startsWith(`${tag} page`));
    assert.deepEqual(
      ours.map((task) => task.id),
      made.map((task) => task.id),
    );

    const finished = (await (await send("/tasks?done=true&limit=100")).json()) as { tasks: Task[] };
    assert.ok(finished.tasks.every((task) => task.done));
    assert.ok(finished.tasks.some((task) => task.id === made[1].id));
    for (const task of made) await send(`/tasks/${task.id}`, { method: "DELETE" });
  });

  test("refuses input it cannot accept, and says why", async () => {
    const empty = await send("/tasks", { method: "POST", json: { title: "  " } });
    assert.equal(empty.status, 400);
    const body = (await empty.json()) as { error: { code: string; details: string[] } };
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.details[0], /title/);

    assert.equal((await send("/tasks", { method: "POST", json: { title: "a", surprise: 1 } })).status, 400);
    assert.equal(
      (await send("/tasks", { method: "POST", body: "{", headers: { "content-type": "application/json" } })).status,
      400,
    );
    assert.equal(
      (await send("/tasks", { method: "POST", body: "title=a", headers: { "content-type": "text/plain" } })).status,
      415,
    );
    assert.equal((await send("/tasks", { method: "POST", json: { title: "x".repeat(9000) } })).status, 413);
    assert.equal((await send("/tasks?limit=1000")).status, 400);
    assert.equal((await send("/tasks/not-a-number")).status, 404);
  });

  test("answers the wrong method with Allow, and an unknown route with 404", async () => {
    const wrong = await send("/tasks", { method: "DELETE" });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "GET, POST");
    assert.equal((await send("/tasks/1", { method: "PUT", json: {} })).status, 405);
    assert.equal((await send("/nowhere")).status, 404);
    assert.equal((await send("/")).status, 200);
  });

  test("keeps quotes, emoji and SQL in a title as plain text", async () => {
    const title = `${tag} Robert'); DROP TABLE tasks;-- 🌱`;
    const task = await create(title);
    assert.equal(((await (await send(`/tasks/${task.id}`)).json()) as Task).title, title);
    await send(`/tasks/${task.id}`, { method: "DELETE" });
  });
});
