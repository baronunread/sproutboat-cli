import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startServer, type Server } from "./server.ts";

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** A WebSocket client that keeps every frame it receives, so a test can wait for the one it expects. */
class Client {
  private readonly frames: Frame[] = [];
  private readonly listeners: Array<() => void> = [];

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      this.frames.push(data === "pong" ? { type: "pong" } : JSON.parse(String(data)));
      this.wake();
    });
  }

  static async join(base: string, room: string, name: string): Promise<Client> {
    const socket = new WebSocket(`${base.replace("http", "ws")}/rooms/${room}?name=${encodeURIComponent(name)}`);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error(`could not join ${room} as ${name}`)));
    });
    return client;
  }

  private wake() {
    for (const listener of this.listeners.splice(0)) listener();
  }

  /** The next frame of this type that has not been taken, or a failure after `ms`. */
  async next(type: string, ms = 5000): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const at = this.frames.findIndex((frame) => frame.type === type);
      if (at >= 0) return this.frames.splice(at, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${type} frame within ${ms} ms; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        this.listeners.push(resolve);
        setTimeout(resolve, left);
      });
    }
  }

  /** Whether a frame of this type shows up in the next `ms`. */
  async receives(type: string, ms = 400): Promise<boolean> {
    return this.next(type, ms).then(
      () => true,
      () => false,
    );
  }

  say(text: string) {
    this.socket.send(JSON.stringify({ type: "chat", text }));
  }

  sendRaw(data: string) {
    this.socket.send(data);
  }

  async close() {
    const closed = new Promise<void>((resolve) => this.socket.addEventListener("close", () => resolve()));
    this.socket.close(1000);
    await closed;
  }
}

describe("realtime room", () => {
  let server: Server;
  // A room per run, so a server that was already running (BASE_URL) starts each run with an empty one.
  const run = Date.now().toString(36);
  const room = (name: string) => `${name}-${run}`;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  test("serves the chat page", async () => {
    const page = await fetch(server.base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /Realtime room/);
  });

  test("welcomes a new socket with who is here and what was said", async () => {
    const ada = await Client.join(server.base, room("welcome"), "ada");
    const welcome = await ada.next("welcome");
    assert.deepEqual(welcome.presence, ["ada"]);
    assert.deepEqual(welcome.history, []);
    await ada.close();
  });

  test("delivers a message to everyone in the room, and to no other room", async () => {
    const [ada, bob, eve] = await Promise.all([
      Client.join(server.base, room("talk"), "ada"),
      Client.join(server.base, room("talk"), "bob"),
      Client.join(server.base, room("elsewhere"), "eve"),
    ]);
    await bob.next("welcome");
    ada.say("hello room");
    const heard = await bob.next("message");
    assert.equal(heard.from, "ada");
    assert.equal(heard.text, "hello room");
    assert.equal((await ada.next("message")).text, "hello room");
    assert.equal(await eve.receives("message"), false);
    await Promise.all([ada.close(), bob.close(), eve.close()]);
  });

  test("announces joins and leaves, and lists who is present", async () => {
    const name = room("presence");
    const ada = await Client.join(server.base, name, "ada");
    await ada.next("welcome");
    const bob = await Client.join(server.base, name, "bob");
    assert.deepEqual((await ada.next("join")).presence, ["ada", "bob"]);

    const listed = await fetch(`${server.base}/rooms/${name}/presence`);
    assert.deepEqual(await listed.json(), ["ada", "bob"]);

    await bob.close();
    const left = await ada.next("leave");
    assert.equal(left.name, "bob");
    assert.deepEqual(left.presence, ["ada"]);
    await ada.close();
  });

  test("replays the history to a late joiner", async () => {
    const name = room("history");
    const ada = await Client.join(server.base, name, "ada");
    await ada.next("welcome");
    ada.say("first");
    ada.say("second");
    await ada.next("message");
    await ada.next("message");
    const late = await Client.join(server.base, name, "late");
    const history = (await late.next("welcome")).history as Array<{ text: string }>;
    assert.deepEqual(
      history.map((message) => message.text),
      ["first", "second"],
    );
    await Promise.all([ada.close(), late.close()]);
  });

  test("answers a ping without involving the room", async () => {
    const ada = await Client.join(server.base, room("ping"), "ada");
    await ada.next("welcome");
    ada.sendRaw("ping");
    assert.equal((await ada.next("pong")).type, "pong");
    await ada.close();
  });

  test("answers a bad frame with an error and keeps the socket", async () => {
    const ada = await Client.join(server.base, room("errors"), "ada");
    await ada.next("welcome");
    ada.sendRaw("not json");
    assert.match(String((await ada.next("error")).error), /JSON/);
    ada.sendRaw(JSON.stringify({ type: "chat", text: "x".repeat(501) }));
    assert.match(String((await ada.next("error")).error), /1 to 500/);
    ada.say("still here");
    assert.equal((await ada.next("message")).text, "still here");
    await ada.close();
  });

  test("refuses what it cannot serve before upgrading", async () => {
    const name = room("refusals");
    const bad = await fetch(`${server.base}/rooms/Not_Valid?name=ada`);
    assert.equal(bad.status, 400);
    const anonymous = await fetch(`${server.base}/rooms/${name}`);
    assert.equal(anonymous.status, 400);
    const plain = await fetch(`${server.base}/rooms/${name}?name=ada`);
    assert.equal(plain.status, 426);

    const ada = await Client.join(server.base, name, "ada");
    await ada.next("welcome");
    const taken = await fetch(`${server.base}/rooms/${name}?name=ada`);
    assert.equal(taken.status, 409);
    await ada.close();
    assert.equal((await fetch(server.base + "/nowhere")).status, 404);
  });
});
