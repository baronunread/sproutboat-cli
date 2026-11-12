/**
 * The kitchen-sink worker, run in this process with a fake D1 (bun:sqlite), a fake R2 and a clock the test
 * moves: file expiry, the daily upload quota, how files are served (Content-Disposition) and /healthz.
 * The harness (harness.ts) runs the compiled sprout against the real broker; this runs in a second and
 * can make an hour or a day pass.
 *
 *   bun test examples/kitchen-sink/worker.test.ts
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../../src/json";

const MIB = 1048576;
const realNow = Date.now;
// 2026-11-12 10:00 UTC: after that day's 04:00 allowance boundary, so the day runs until 04:00 tomorrow.
const START = Date.UTC(2026, 10, 12, 10, 0, 0);
let clock = START;

type Meta = Record<string, string>;
type Stored = { bytes: Uint8Array; httpMetadata: Meta; customMetadata: Meta; uploaded: Date };

function fakeBucket() {
  const objects = new Map<string, Stored>();
  const view = (key: string, o: Stored) => ({
    key,
    size: o.bytes.length,
    httpMetadata: o.httpMetadata,
    customMetadata: o.customMetadata,
    uploaded: o.uploaded,
    httpEtag: '"' + key + '"',
  });
  return {
    objects,
    async put(
      key: string,
      body: string | ArrayBuffer | Uint8Array,
      opts: { httpMetadata?: Meta; customMetadata?: Meta } = {},
    ) {
      const bytes = ArrayBuffer.isView(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new TextEncoder().encode(body);
      objects.set(key, {
        bytes: bytes.slice(),
        httpMetadata: opts.httpMetadata ?? {},
        customMetadata: opts.customMetadata ?? {},
        uploaded: new Date(clock),
      });
    },
    async head(key: string) {
      const o = objects.get(key);
      return o ? view(key, o) : null;
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        ...view(key, o),
        arrayBuffer: async () => o.bytes.slice().buffer,
        text: async () => new TextDecoder().decode(o.bytes),
      };
    },
    async list(opts: { prefix?: string; limit?: number } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      const page = keys.slice(0, opts.limit ?? 1000);
      return { objects: page.map((k) => view(k, objects.get(k)!)), truncated: keys.length > page.length };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

function fakeD1(db: Database, counter: { calls: number }) {
  return {
    async exec(sql: string) {
      counter.calls++;
      db.exec(sql);
    },
    prepare(sql: string) {
      let args: SQLQueryBindings[] = [];
      const statement = {
        bind(...a: SQLQueryBindings[]) {
          args = a;
          return statement;
        },
        async first(column?: string) {
          counter.calls++;
          const row = jsonObject(parseJsonValue(JSON.stringify(db.query(sql).get(...args))));
          return row ? (column ? row[column] : row) : null;
        },
        async run() {
          counter.calls++;
          const info = db.query(sql).run(...args);
          return { meta: { last_row_id: Number(info.lastInsertRowid), rows_read: 0 } };
        },
        async all() {
          counter.calls++;
          return { results: db.query(sql).all(...args), meta: { rows_read: 0 } };
        },
      };
      return statement;
    },
  };
}

let bucket: ReturnType<typeof fakeBucket>;
let db: Database;
const dbCalls = { calls: 0 };
/** The vars a test sets on top of the app's defaults. */
type Vars = {
  MAX_TOTAL_BYTES?: string;
  MAX_UPLOAD_BYTES?: string;
  MAX_UPLOAD_PER_HOUR?: string;
  MAX_UPLOAD_PER_DAY?: string;
  MAX_DOWNLOAD_PER_HOUR?: string;
  FILE_TTL_SECONDS?: string;
};
type Limiter = { limit(arg: { key: string }): Promise<{ success: boolean; resetAt: number }> };
type Limiters = { READS?: Limiter; WRITES?: Limiter };
type Worker = {
  fetch(request: Request): Promise<Response>;
  scheduled(event: { cron: string; scheduledTime: number }): Promise<void>;
};
let vars: Vars = {};
let limiters: Limiters = {};
let worker: Worker;
type Attachment = { name: string; ip: string; t1: number; n1: number; t10: number; n10: number; strikes: number };
type HistoryEntry = { name: string; text: string; at: number };
type RoomSocket = {
  sent: JsonObject[];
  send(text: string): void;
  close(code: number): void;
  serializeAttachment(value: Attachment): void;
  deserializeAttachment(): Attachment;
};
type RoomState = {
  getWebSockets(): RoomSocket[];
  storage: {
    get(key: string): Promise<HistoryEntry[] | undefined>;
    put(key: string, value: HistoryEntry[]): Promise<void>;
    delete(key: string): Promise<void>;
  };
};
type Room = {
  webSocketMessage(ws: RoomSocket, message: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
};
let ChatRoom: new (state: RoomState, env: Record<string, never>) => Room;

function freshEnv() {
  bucket = fakeBucket();
  db = new Database(":memory:");
  dbCalls.calls = 0;
  // The worker reads its bindings from the global `env`, as the runtime's prelude provides it.
  Object.assign(globalThis, {
    env: { ...vars, ...limiters, DB: fakeD1(db, dbCalls), UPLOADS: bucket, METRICS: { writeDataPoint() {} } },
  });
}

beforeAll(async () => {
  Date.now = () => clock;
  freshEnv();
  const module = await import("./src/index.js");
  worker = module.default;
  ChatRoom = module.ChatRoom;
});
afterAll(() => {
  Date.now = realNow;
  Reflect.deleteProperty(globalThis, "env");
});
beforeEach(() => {
  clock = START;
  vars = {};
  limiters = {};
  freshEnv();
});

const BASE = "https://kitchen-sink.test";
let nextId = 1;
const hex16 = () => (nextId++).toString(16).padStart(16, "0");

function call(path: string, init: RequestInit = {}, ip = "198.51.100.1") {
  const headers = new Headers(init.headers);
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", ip);
  return worker.fetch(new Request(BASE + path, { ...init, headers }));
}

const obj = (value: JsonValue): JsonObject => jsonObject(value) ?? {};
async function readObject(res: Response): Promise<JsonObject> {
  return obj(parseJsonValue(await res.text()));
}
const items = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

/** One whole file in one chunk (it has to be a single chunk: 1 MiB or less), as the page would send it. */
async function upload(name: string, type: string, bytes: Uint8Array | string, ip = "198.51.100.1", declared?: number) {
  const body = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  const total = declared ?? body.length;
  const count = Math.max(1, Math.ceil(total / MIB));
  const res = await call(
    `/api/r2/chunk?name=${encodeURIComponent(name)}&id=${hex16()}&n=0&count=${count}&total=${total}&type=${encodeURIComponent(type)}`,
    { method: "PUT", body },
    ip,
  );
  return { status: res.status, body: await readObject(res), headers: res.headers };
}

const file = (name: string, init?: RequestInit, extra = "") =>
  call(`/api/r2/file?name=${encodeURIComponent(name)}${extra}`, init);
const names = async () => items((await readObject(await call("/api/r2"))).objects).map((o) => obj(o).name);
const advance = (ms: number) => {
  clock += ms;
};

describe("/healthz", () => {
  test("answers 200 JSON, uncached, without touching D1, KV or R2", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await readObject(res);
    expect(body.ok).toBe(true);
    expect(body.at).toBe(clock);
    expect(dbCalls.calls).toBe(0);
    expect(bucket.objects.size).toBe(0);
  });

  test("HEAD is 200 with no body; other methods are 405 with Allow", async () => {
    const head = await call("/healthz", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await call("/healthz", { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  test("is not rate limited: a monitor polling every second is always answered", async () => {
    const limited: Limiter = { limit: async () => ({ success: false, resetAt: clock + 60000 }) };
    limiters = { READS: limited, WRITES: limited };
    freshEnv();
    for (let i = 0; i < 5; i++) expect((await call("/healthz")).status).toBe(200);
    expect((await call("/api/r2")).status).toBe(429);
  });
});

describe("Content-Disposition", () => {
  const attachments: Array<[string, string]> = [
    ["page.html", "text/html"],
    ["doc.pdf", "application/pdf"],
    ["notes.txt", "text/plain"],
    ["logo.svg", "image/svg+xml"],
    ["data.json", "application/json"],
    ["blob.bin", "application/octet-stream"],
    ["app.js", "text/javascript"],
  ];
  for (const [name, type] of attachments) {
    test(`${type} is an attachment, never sniffed`, async () => {
      expect((await upload(name, type, "<h1>hi</h1><script>alert(1)</script>")).status).toBe(201);
      const res = await file(name);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-type")?.split(";")[0]).toBe(type);
    });
  }

  test("a document or an HTML file is sandboxed as well; only a PDF has no CSP header", async () => {
    await upload("page.html", "text/html", "<script>alert(1)</script>");
    await upload("doc.pdf", "application/pdf", "%PDF-1.4");
    const html = await file("page.html");
    expect(html.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect((await file("doc.pdf")).headers.get("content-security-policy")).toBeNull();
  });

  const shown: Array<[string, string]> = [
    ["a.png", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.mp4", "video/mp4"],
    ["a.webm", "video/webm"],
    ["a.mp3", "audio/mpeg"],
    ["a.ogg", "audio/ogg"],
    ["a.wav", "audio/wav"],
  ];
  for (const [name, type] of shown) {
    test(`${type} may be shown in the browser, with nosniff`, async () => {
      await upload(name, type, "bytes");
      const res = await file(name);
      expect(res.headers.get("content-disposition")).toBe(`inline; filename="${name}"`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  }

  test("?download=1 makes even a picture an attachment", async () => {
    await upload("a.png", "image/png", "bytes");
    expect((await file("a.png", {}, "&download=1")).headers.get("content-disposition")).toBe(
      'attachment; filename="a.png"',
    );
  });

  test("media keep media-src 'self' without a sandbox; pictures are sandboxed", async () => {
    await upload("a.mp4", "video/mp4", "bytes");
    await upload("a.png", "image/png", "bytes");
    expect((await file("a.mp4")).headers.get("content-security-policy")).toBe("default-src 'none'; media-src 'self'");
    expect((await file("a.png")).headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });
});

describe("expiry", () => {
  test("a file is listed with the moment it expires, an hour after its upload", async () => {
    clock = START + 5000;
    const put = await upload("note.txt", "text/plain", "hello");
    expect(put.status).toBe(201);
    const first = obj(items((await readObject(await call("/api/r2"))).objects)[0] ?? null);
    expect(first.name).toBe("note.txt");
    expect(first.expires).toBe(START + 5000 + 3600000);
    expect((await readObject(await call("/api/info"))).file_ttl_seconds).toBe(3600);
  });

  test("it is served until its hour is up, then not served and deleted", async () => {
    await upload("a.txt", "text/plain", "hello");
    advance(59 * 60000);
    expect((await file("a.txt")).status).toBe(200);
    expect(await names()).toEqual(["a.txt"]);
    advance(61000);
    // Over: a GET, a HEAD and a Range all say 404, and the objects are gone from the bucket.
    expect((await file("a.txt")).status).toBe(404);
    expect((await file("a.txt", { method: "HEAD" })).status).toBe(404);
    expect((await file("a.txt", { headers: { range: "bytes=0-1" } })).status).toBe(404);
    expect([...bucket.objects.keys()]).toEqual([]);
  });

  test("the list drops an expired file and deletes it, chunks included", async () => {
    await upload("a.txt", "text/plain", "hello");
    await upload("b.txt", "text/plain", "world");
    advance(30 * 60000);
    await upload("c.txt", "text/plain", "fresh");
    advance(31 * 60000);
    expect(await names()).toEqual(["c.txt"]);
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((k) => k.startsWith("files/"))).toEqual(["files/c.txt"]);
    expect(keys.filter((k) => k.startsWith("chunks/")).length).toBe(1);
  });

  test("a file that is replaced gets a new hour", async () => {
    await upload("a.txt", "text/plain", "one");
    advance(50 * 60000);
    await upload("a.txt", "text/plain", "two");
    advance(30 * 60000);
    const res = await file("a.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("two");
  });

  test("the cron every 15 minutes deletes expired files and leaves fresh ones", async () => {
    await upload("old.txt", "text/plain", "old");
    advance(40 * 60000);
    await upload("new.txt", "text/plain", "new");
    advance(25 * 60000);
    // old.txt is 65 minutes old, new.txt 25. Nobody has listed or fetched anything since.
    expect([...bucket.objects.keys()].some((k) => k === "files/old.txt")).toBe(true);
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: clock });
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((k) => k.startsWith("files/"))).toEqual(["files/new.txt"]);
    expect(keys.filter((k) => k.startsWith("chunks/")).length).toBe(1);
    expect((await file("new.txt")).status).toBe(200);
  });

  test("expired files free their room before an upload is counted against the caps", async () => {
    vars = { MAX_TOTAL_BYTES: String(2 * MIB) };
    freshEnv();
    expect((await upload("a.bin", "application/octet-stream", new Uint8Array(MIB), "198.51.100.1")).status).toBe(201);
    expect((await upload("b.bin", "application/octet-stream", new Uint8Array(MIB), "198.51.100.2")).status).toBe(201);
    expect((await upload("c.bin", "application/octet-stream", new Uint8Array(MIB), "198.51.100.3")).status).toBe(409);
    advance(61 * 60000);
    expect((await upload("c.bin", "application/octet-stream", new Uint8Array(MIB), "198.51.100.3")).status).toBe(201);
    expect(await names()).toEqual(["c.bin"]);
  });

  test("FILE_TTL_SECONDS sets the hour", async () => {
    vars = { FILE_TTL_SECONDS: "120" };
    freshEnv();
    await upload("a.txt", "text/plain", "hi");
    advance(119000);
    expect((await file("a.txt")).status).toBe(200);
    advance(2000);
    expect((await file("a.txt")).status).toBe(404);
  });

  test("a file may be cached by the browser only for what is left of its hour", async () => {
    await upload("a.txt", "text/plain", "hi");
    advance(50 * 60000);
    expect(
      Number(/max-age=(\d+)/.exec((await file("a.txt")).headers.get("cache-control") ?? "")?.[1]),
    ).toBeLessThanOrEqual(600);
  });
});

describe("daily upload quota", () => {
  const body = (n: number) => new Uint8Array(n);

  test("100 MB a day per address by default, shown in /api/info", async () => {
    expect((await readObject(await call("/api/info"))).max_upload_per_day).toBe(104857600);
  });

  test("an address that has spent its day is refused with a 429 and the seconds to 04:00 UTC", async () => {
    vars = { MAX_UPLOAD_PER_DAY: String(3 * MIB) };
    freshEnv();
    for (const n of ["a", "b", "c"])
      expect((await upload(n + ".bin", "application/octet-stream", body(MIB))).status).toBe(201);
    const refused = await upload("d.bin", "application/octet-stream", body(1));
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("quota");
    expect(refused.body.window).toBe("day");
    expect(refused.body.limit).toBe(3 * MIB);
    expect(refused.body.used).toBe(3 * MIB);
    // 10:00 to 04:00 the next day is 18 hours.
    expect(refused.body.retry_after).toBe(18 * 3600);
    expect(refused.headers.get("retry-after")).toBe(String(18 * 3600));
    expect(String(refused.body.error)).toContain("a day");
    expect(await names()).toEqual(["a.bin", "b.bin", "c.bin"]);
  });

  test("another address has its own day", async () => {
    vars = { MAX_UPLOAD_PER_DAY: String(MIB) };
    freshEnv();
    expect((await upload("a.bin", "application/octet-stream", body(MIB), "198.51.100.1")).status).toBe(201);
    expect((await upload("b.bin", "application/octet-stream", body(1), "198.51.100.1")).status).toBe(429);
    expect((await upload("c.bin", "application/octet-stream", body(MIB), "198.51.100.2")).status).toBe(201);
  });

  test("the bytes a file declares are charged when its first chunk arrives, and a refusal charges nothing", async () => {
    vars = { MAX_UPLOAD_PER_DAY: String(10 * MIB), MAX_UPLOAD_BYTES: String(25 * MIB) };
    freshEnv();
    // A 6 MiB file declared, only its first chunk sent: 6 MiB spent.
    expect((await upload("a.bin", "application/octet-stream", body(MIB), "198.51.100.1", 6 * MIB)).status).toBe(200);
    const refused = await upload("b.bin", "application/octet-stream", body(MIB), "198.51.100.1", 5 * MIB);
    expect(refused.status).toBe(429);
    expect(refused.body.used).toBe(6 * MIB);
    // Nothing was charged for the refused one, so 4 MiB still fits.
    expect((await upload("c.bin", "application/octet-stream", body(MIB), "198.51.100.1", 4 * MIB)).status).toBe(200);
  });

  test("the hour turning over does not give the day back", async () => {
    vars = { MAX_UPLOAD_PER_DAY: String(2 * MIB), MAX_UPLOAD_PER_HOUR: String(10 * MIB) };
    freshEnv();
    await upload("a.bin", "application/octet-stream", body(MIB));
    await upload("b.bin", "application/octet-stream", body(MIB));
    advance(2 * 3600000);
    const refused = await upload("c.bin", "application/octet-stream", body(1));
    expect(refused.status).toBe(429);
    expect(refused.body.window).toBe("day");
    expect(refused.body.retry_after).toBe(16 * 3600);
  });

  test("the hour's allowance still applies, and names its window", async () => {
    vars = { MAX_UPLOAD_PER_HOUR: String(MIB), MAX_UPLOAD_PER_DAY: String(10 * MIB) };
    freshEnv();
    await upload("a.bin", "application/octet-stream", body(MIB));
    const refused = await upload("b.bin", "application/octet-stream", body(1));
    expect(refused.status).toBe(429);
    expect(refused.body.window).toBe("hour");
    advance(3600000);
    expect((await upload("b.bin", "application/octet-stream", body(1))).status).toBe(201);
  });

  test("a new day (04:00 UTC) starts a new allowance", async () => {
    vars = { MAX_UPLOAD_PER_DAY: String(MIB) };
    freshEnv();
    await upload("a.bin", "application/octet-stream", body(MIB));
    expect((await upload("b.bin", "application/octet-stream", body(1))).status).toBe(429);
    // 03:59 the next morning: still the same day.
    clock = Date.UTC(2026, 10, 13, 3, 59, 0);
    expect((await upload("b.bin", "application/octet-stream", body(1))).status).toBe(429);
    clock = Date.UTC(2026, 10, 13, 4, 0, 1);
    expect((await upload("b.bin", "application/octet-stream", body(1))).status).toBe(201);
  });

  test("downloads have no daily quota; only the hourly one", async () => {
    vars = { MAX_UPLOAD_PER_DAY: String(MIB), MAX_DOWNLOAD_PER_HOUR: String(1000) };
    freshEnv();
    await upload("a.bin", "application/octet-stream", body(600));
    expect((await file("a.bin")).status).toBe(200);
    const second = await file("a.bin");
    expect(second.status).toBe(429);
    expect((await readObject(second)).window).toBe("hour");
  });
});

/** A ChatRoom with a fake object state: sockets that record what they are sent, storage in a Map. */
function fakeRoom() {
  const sockets: RoomSocket[] = [];
  const store = new Map<string, HistoryEntry[]>();
  const state: RoomState = {
    getWebSockets: () => sockets,
    storage: {
      async get(key) {
        return store.get(key);
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    },
  };
  const room = new ChatRoom(state, {});
  return { room, sockets, store };
}
function fakeSocket(ip = "198.51.100.9"): RoomSocket {
  let attachment: Attachment = { name: "ada", ip, t1: 0, n1: 0, t10: 0, n10: 0, strikes: 0 };
  const sent: JsonObject[] = [];
  return {
    sent,
    send(text) {
      sent.push(obj(parseJsonValue(text)));
    },
    close() {},
    serializeAttachment(value) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
  };
}

describe("chat room: message and frame caps", () => {
  async function say(text: string, extra: Record<string, string | number> = {}) {
    const { room, sockets, store } = fakeRoom();
    const ws = fakeSocket();
    sockets.push(ws);
    await room.webSocketMessage(ws, JSON.stringify({ type: "msg", text, sent: 1, ...extra }));
    return { ws, store };
  }
  const outcome = (ws: RoomSocket) => ws.sent.map((f) => String(f.code ?? f.type));

  test("1,000 characters are accepted and broadcast whole", async () => {
    const text = "a".repeat(1000);
    const { ws, store } = await say(text);
    expect(outcome(ws)).toEqual(["msg"]);
    expect(ws.sent[0]!.text).toBe(text);
    expect(store.get("history")?.length).toBe(1);
  });

  test("1,001 characters are refused with too_long, and nothing is stored", async () => {
    const { ws, store } = await say("a".repeat(1001));
    expect(outcome(ws)).toEqual(["too_long"]);
    expect(String(ws.sent[0]!.error)).toContain("1000");
    expect(store.has("history")).toBe(false);
  });

  test("1,000 four-byte emoji are accepted: the cap counts characters, the frame is 4 KB", async () => {
    const text = "\u{1F600}".repeat(1000);
    const frame = JSON.stringify({ type: "msg", text, sent: 1731412345678 });
    expect(new TextEncoder().encode(frame).length).toBeGreaterThan(4000);
    expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(4096);
    const { ws } = await say(text, { sent: 1731412345678 });
    expect(outcome(ws)).toEqual(["msg"]);
    expect(ws.sent[0]!.text).toBe(text);
  });

  test("1,001 emoji are refused with too_long (they fit the frame, not the cap)", async () => {
    const { ws } = await say("\u{1F600}".repeat(1001));
    expect(outcome(ws)).toEqual(["too_long"]);
  });

  test("1,000 CJK characters are accepted", async () => {
    const { ws } = await say("\u4e2d".repeat(1000));
    expect(outcome(ws)).toEqual(["msg"]);
  });

  test("a frame over 4096 bytes is refused with too_large, counted in bytes not characters", async () => {
    // 1,000 emoji is within the text cap; the padding takes the frame past 4096 bytes.
    const { ws } = await say("\u{1F600}".repeat(1000), { pad: "x".repeat(120) });
    expect(outcome(ws)).toEqual(["too_large"]);
    expect(String(ws.sent[0]!.error)).toContain("4096 bytes");
    // 1,300 characters of 1-byte text are well inside 4096 bytes: only the text cap refuses them.
    const plain = await say("a".repeat(1300));
    expect(outcome(plain.ws)).toEqual(["too_long"]);
  });

  test("line breaks are kept (a run becomes one blank line) and a message of only breaks is dropped", async () => {
    const { ws } = await say("  one\r\ntwo\n\n\n\nthree  four\n");
    expect(ws.sent[0]!.text).toBe("one\ntwo\n\nthree four");
    const empty = await say("\n\n \n");
    expect(empty.ws.sent).toEqual([]);
  });

  test("a name stays on one line", async () => {
    const { room, sockets } = fakeRoom();
    const ws = fakeSocket();
    sockets.push(ws);
    await room.webSocketMessage(ws, JSON.stringify({ type: "hello", name: "A\nB" }));
    expect(ws.deserializeAttachment().name).toBe("A B");
  });

  test("the history keeps 30 short messages", async () => {
    const { room, sockets, store } = fakeRoom();
    const ws = fakeSocket();
    sockets.push(ws);
    for (let i = 0; i < 35; i++) {
      clock += 5000;
      await room.webSocketMessage(ws, JSON.stringify({ type: "msg", text: "hello " + i, sent: i }));
    }
    expect((store.get("history") ?? []).length).toBe(30);
  });

  test("full-size messages drop the oldest so the stored history stays under 96 KiB", async () => {
    const { room, sockets, store } = fakeRoom();
    const ws = fakeSocket();
    sockets.push(ws);
    for (let i = 0; i < 35; i++) {
      clock += 5000;
      await room.webSocketMessage(ws, JSON.stringify({ type: "msg", text: "\u{1F600}".repeat(1000), sent: i }));
    }
    const history = store.get("history") ?? [];
    expect(history.length).toBeGreaterThan(10);
    expect(history.length).toBeLessThan(30);
    expect(history[history.length - 1].text).toBe("\u{1F600}".repeat(1000));
    expect(new TextEncoder().encode(JSON.stringify(history)).length).toBeLessThanOrEqual(96 * 1024);
    // Two bytes per UTF-16 unit is the most a stored string can weigh: still under the 128 KiB value limit.
    expect(JSON.stringify(history).length * 2).toBeLessThan(131072);
  });

  test("the per-second strike limits are unchanged: 4 frames in a second is a rate_limited error", async () => {
    const { room, sockets } = fakeRoom();
    const ws = fakeSocket();
    sockets.push(ws);
    for (let i = 0; i < 4; i++) await room.webSocketMessage(ws, JSON.stringify({ type: "msg", text: "hi", sent: i }));
    expect(outcome(ws)).toEqual(["msg", "msg", "msg", "rate_limited"]);
  });

  test("a plain GET asks the room whether it would take the socket: 503 when full, 429 at the address cap, else 426", async () => {
    const { room, sockets } = fakeRoom();
    const probe = () =>
      room
        .fetch(new Request("https://room/", { headers: { "x-forwarded-for": "198.51.100.9" } }))
        .then((r) => r.status);
    expect(await probe()).toBe(426);
    for (let i = 0; i < 5; i++) sockets.push(fakeSocket("198.51.100.9"));
    expect(await probe()).toBe(429);
    for (let i = 0; i < 55; i++) sockets.push(fakeSocket("203.0.113." + (i + 1)));
    expect(await probe()).toBe(503);
  });
});

/** What public/reconnect.js puts on the page's global. */
type Rules = {
  FIRST: number;
  CEILING: number;
  STABLE: number;
  delay(attempt: number, random: number): number;
  isFinal(code: number): boolean;
  afterRefusal(status: number, retryAfter: string): { retry: boolean; minWait: number };
};
declare global {
  var SBReconnect: Rules;
}

describe("chat reconnect rules (public/reconnect.js)", () => {
  let rules: Rules;
  beforeAll(async () => {
    await import("./public/reconnect.js");
    rules = globalThis.SBReconnect;
  });

  test("the first retries wait about half a second to a second, then the ceiling doubles to 30 s", () => {
    expect(rules.delay(0, 0)).toBe(500);
    expect(rules.delay(0, 1)).toBe(1000);
    expect(rules.delay(1, 1)).toBe(2000);
    expect(rules.delay(2, 1)).toBe(4000);
    expect(rules.delay(4, 1)).toBe(16000);
    expect(rules.delay(5, 1)).toBe(30000);
    expect(rules.delay(40, 1)).toBe(30000);
  });

  test("the wait is jittered between the floor and the ceiling, and never below half a second", () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      for (const random of [0, 0.25, 0.5, 0.999]) {
        const wait = rules.delay(attempt, random);
        expect(wait).toBeGreaterThanOrEqual(rules.FIRST);
        expect(wait).toBeLessThanOrEqual(rules.CEILING);
      }
    }
    expect(rules.delay(3, 0.5)).toBeGreaterThan(rules.delay(3, 0.1));
    expect(rules.STABLE).toBe(10000);
  });

  test("closes the room sends on purpose are final; a lost connection is retried", () => {
    for (const code of [1008, 4008, 4000, 4999, 3000, 1002, 1003, 1007, 1009, 1010])
      expect(rules.isFinal(code)).toBe(true);
    for (const code of [1000, 1001, 1005, 1006, 1011, 1012, 1013, 1015]) expect(rules.isFinal(code)).toBe(false);
  });

  test("a socket that never opened: 503 (room full) stops, 429 waits at least what it says, the rest backs off", () => {
    expect(rules.afterRefusal(503, "")).toEqual({ retry: false, minWait: 0 });
    expect(rules.afterRefusal(429, "7")).toEqual({ retry: true, minWait: 7000 });
    expect(rules.afterRefusal(429, "")).toEqual({ retry: true, minWait: 0 });
    expect(rules.afterRefusal(426, "")).toEqual({ retry: true, minWait: 0 });
    expect(rules.afterRefusal(0, "")).toEqual({ retry: true, minWait: 0 });
  });
});
