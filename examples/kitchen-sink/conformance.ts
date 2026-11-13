/**
 * The kitchen-sink demo's checks, driven over HTTP against a running app: the dashboard's API, what it protects
 * itself with (rate limits, input caps, daily upload quotas, file expiry), the chat room and the cron jobs.
 *
 * The binding conformance checks (KV, D1, R2, queues, crypto, egress, the secret gate...) are in
 * test/fixtures/conformance, which has its own worker for them. Both are held to both backends: the broker-backed
 * harness runs these against a host sprout plus an in-process broker, the standalone harness against one binary.
 *
 * Deliberately free of any knowledge of how the app is running: it gets a base URL and a trigger token.
 */
import { isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../../src/json";
import type { RunContext } from "../../test/fixtures/lib/backends";
import { runR2RoundTrip } from "./r2-roundtrip";

const obj = (value: JsonValue | undefined): JsonObject => jsonObject(value ?? null) ?? {};
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

export type ConformanceOptions = {
  /**
   * Skip the checks that post an internal `x-sb-trigger` request. An embedded standalone binary runs its own cron
   * and queue timers in-process, so there is no broker to impersonate: the behaviour is covered, just not
   * reachable this way.
   */
  skipTriggers?: boolean;
  /** The app has no service binding: a standalone binary has no edge to route a worker-to-worker call through. */
  skipServices?: boolean;
};

export async function runConformance(context: RunContext, options: ConformanceOptions = {}): Promise<void> {
  const { base, token: TOKEN, check, harness } = context;
  const step = (name: string) => harness.step(name);
  // The app keys its rate limits on the client address. Behind a proxy that is X-Forwarded-For, which the app
  // believes when the TCP peer is a private address, as it is here. So each run gets its own address: a second run
  // inside the same minute has a fresh budget, and a check that wants its own budget sends its own header.
  const runAddress = `198.51.100.${20 + (Date.now() % 200)}`;
  const addressed = (init: RequestInit | undefined, address: string): RequestInit => {
    const headers = new Headers(init?.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", address);
    return { ...init, headers };
  };
  const fetch = (url: string, init?: RequestInit): Promise<Response> => harness.fetch(url, addressed(init, runAddress));
  /** A request from its own client address, for the checks that spend a whole budget. */
  const jfrom = async (address: string, p: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("x-forwarded-for", address);
    const r = await fetch(base + p, { ...init, headers });
    const t = await r.text();
    let body: JsonValue = t;
    try {
      body = parseJsonValue(t);
    } catch {}
    return { status: r.status, body, headers: r.headers };
  };
  const jget = async (p: string, init?: RequestInit): Promise<{ status: number; body: JsonValue }> => {
    const r = await fetch(base + p, init);
    const t = await r.text();
    try {
      return { status: r.status, body: parseJsonValue(t) };
    } catch {
      return { status: r.status, body: t };
    }
  };
  const trigger = (cron: string, scheduledTime: number) =>
    fetch(base + "/", {
      method: "POST",
      headers: { "x-sb-trigger": "scheduled", "x-sb-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ cron, scheduledTime }),
    });

  console.log("\nthe dashboard:");

  step("the page");
  const home = await fetch(base + "/");
  check(
    "assets: GET / serves the dashboard with an html content-type",
    home.status === 200 &&
      (home.headers.get("content-type") || "").includes("text/html") &&
      (await home.text()).includes("<h1>Sproutboat Notes"),
  );
  const spa = await fetch(base + "/some/client/route");
  check(
    "assets: unknown GET falls back to the SPA shell (200)",
    spa.status === 200 && (await spa.text()).includes("<h1>Sproutboat Notes"),
  );

  step("the API: info, KV, queue, quote and secrets tiles");
  const info = obj((await jget("/api/info")).body);
  const bindings = obj(info.bindings);
  check(
    "info: /api/info says which bindings this build has",
    bindings.kv === true &&
      bindings.d1 === true &&
      bindings.r2 === true &&
      bindings.queue === true &&
      bindings.durable_object === true &&
      bindings.service === !options.skipServices,
    info.bindings ?? null,
  );
  const counter1 = obj((await jget("/api/kv/incr", { method: "POST" })).body);
  const counter2 = obj((await jget("/api/kv/incr", { method: "POST" })).body);
  check("KV: the counter tile increments across requests", Number(counter2.n) === Number(counter1.n) + 1, {
    first: counter1.n,
    second: counter2.n,
  });
  const quoted = obj((await jget("/api/quote")).body);
  if (options.skipServices)
    check(
      "service binding: a build without one says so",
      quoted.ok === false && quoted.reason === "no-binding",
      quoted,
    );
  else
    check(
      "service binding: the quote tile reaches the peer through env.PEER",
      quoted.ok === true && isString(obj(quoted.quote).content),
      quoted,
    );
  const secrets = arr(obj((await jget("/api/secrets")).body).secrets).map(obj);
  check(
    "secrets: the tile reports ADMIN_TOKEN as set, and never its value",
    secrets.some((entry) => entry.name === "ADMIN_TOKEN" && entry.set === true) &&
      !JSON.stringify(secrets).includes("s3cr3t-admin"),
    secrets,
  );
  await jget("/api/queue/enqueue", { method: "POST", body: JSON.stringify({ label: "conformance" }) });
  let processed = 0;
  for (let i = 0; i < 30; i++) {
    processed = Number(obj(obj((await jget("/api/queue")).body).counts).processed || 0);
    if (processed > 0) break;
    await Bun.sleep(300);
  }
  check("queue: an enqueued job is consumed and recorded as an event", processed > 0, { processed });

  step("rate limits per client address");
  // Every route that writes has a per-address budget (WRITES, 30 a minute). The 31st call
  // answers 429 with a retry-after and a JSON body the page can show; another address, and the
  // reads, are unaffected.
  const spender = `203.0.113.${20 + (Date.now() % 200)}`;
  const spent: number[] = [];
  let last = await jfrom(spender, "/api/kv/incr", { method: "POST" });
  spent.push(last.status);
  for (let i = 1; i < 31; i++) {
    last = await jfrom(spender, "/api/kv/incr", { method: "POST" });
    spent.push(last.status);
  }
  check(
    "ratelimit: a write route allows 30 a minute per address, then answers 429",
    spent.slice(0, 30).every((status) => status === 200) && spent[30] === 429,
    spent,
  );
  const retryAfter = Number(last.headers.get("retry-after"));
  check(
    "ratelimit: the 429 carries retry-after and a clear JSON error",
    retryAfter >= 1 &&
      retryAfter <= 60 &&
      obj(last.body).code === "rate_limited" &&
      Number(obj(last.body).retry_after) === retryAfter &&
      String(obj(last.body).error).includes("slow down"),
    { retryAfter, body: last.body },
  );
  const guestBlocked = await jfrom(spender, "/api/guestbook", {
    method: "POST",
    body: JSON.stringify({ name: "a", msg: "b" }),
  });
  const otherAddress = await jfrom(`203.0.113.${220 + (Date.now() % 30)}`, "/api/kv/incr", { method: "POST" });
  const readStillOpen = await jfrom(spender, "/api/info");
  check(
    "ratelimit: the budget is per address and shared by every write route; reads have their own",
    guestBlocked.status === 429 && otherAddress.status === 200 && readStillOpen.status === 200,
    { guestBlocked: guestBlocked.status, otherAddress: otherAddress.status, readStillOpen: readStillOpen.status },
  );

  step("R2: large files, binary round trip");
  // Bytes survive at 5 MB and at the 25 MB cap: binary, PNG and JPEG come back with the same sha256,
  // with their own content type and Range support; an SVG and anything unlisted is an attachment, so
  // an upload cannot run script here. Each file comes from its own client address, so its upload
  // has its own per-minute and per-hour budget, as it would from a different visitor.
  const fileAddress = new Map<string, string>();
  let nextHost = 20 + (Date.now() % 100);
  await runR2RoundTrip(base, check, (url, init) => {
    const name = new URL(url).searchParams.get("name") ?? "-";
    if (!fileAddress.has(name)) fileAddress.set(name, `192.0.2.${20 + ((nextHost++ - 20) % 200)}`);
    return fetch(url, addressed(init, fileAddress.get(name) ?? runAddress));
  });

  step("public hardening: healthz, expiry, daily quota");
  // GET /healthz is what an uptime monitor polls: cheap JSON, no rate limit, and it needs no address.
  const health = await globalThis.fetch(base + "/healthz");
  const healthBody = obj(parseJsonValue(await health.text()));
  const healthHead = await globalThis.fetch(base + "/healthz", { method: "HEAD" });
  const healthPost = await globalThis.fetch(base + "/healthz", { method: "POST", body: "{}" });
  await healthPost.text();
  check(
    "healthz: GET answers 200 {ok: true} uncached, HEAD 200, POST 405",
    health.status === 200 &&
      healthBody.ok === true &&
      (health.headers.get("content-type") ?? "").includes("application/json") &&
      health.headers.get("cache-control") === "no-store" &&
      healthHead.status === 200 &&
      healthPost.status === 405,
    { status: health.status, body: healthBody, head: healthHead.status, post: healthPost.status },
  );
  let health429 = 0;
  for (let i = 0; i < 300; i++) if ((await globalThis.fetch(base + "/healthz")).status !== 200) health429++;
  check("healthz: 300 polls in a row are all answered (it has no rate limit)", health429 === 0, { refused: health429 });
  const limits = obj((await jget("/api/info")).body);
  check(
    "limits: /api/info states how long a file lives and how much an address may upload a day",
    Number(limits.file_ttl_seconds) > 0 && Number(limits.max_upload_per_day) > 0,
    { ttl: limits.file_ttl_seconds, day: limits.max_upload_per_day },
  );
  // The first chunk of a declared 25 MB file is charged 25 MB. Four of them spend 100 MB, the next is
  // refused with the 429 a quota gives; that address has nothing left today, another address does.
  // 198.18.0.0/15 (benchmarking) is used by no other step, so no earlier upload in this hour can share the address.
  const hoarder = `198.18.${Date.now() % 256}.1`;
  const spend = (id: string, address: string, total: number) =>
    jfrom(
      address,
      `/api/r2/chunk?name=q-${id}.bin&id=${id.padStart(16, "0")}&n=0&count=${Math.ceil(total / 1048576)}&total=${total}&type=application%2Foctet-stream`,
      {
        method: "PUT",
        body: new Uint8Array(1048576),
      },
    );
  const daily = Number(limits.max_upload_per_day) || 104857600;
  const piece = Math.floor(daily / 4);
  if (piece > Number(limits.max_upload_bytes)) {
    // The standalone build takes 1 MB files: four claims cannot add up to the day. worker.test.ts covers the quota.
    console.log(
      "  --  quota: skipped, a file here is at most " + limits.max_upload_bytes + " bytes (see worker.test.ts)",
    );
  } else {
    const spent = [];
    for (let i = 1; i <= 4; i++) spent.push((await spend("a" + i, hoarder, piece)).status);
    const over = await spend("a5", hoarder, 2097152);
    const fresh = await spend("b1", `198.18.${Date.now() % 256}.2`, piece);
    check(
      "quota: an address that has uploaded its whole day gets a 429 with code quota and a Retry-After; another address does not",
      spent.every((s) => s === 200) &&
        over.status === 429 &&
        obj(over.body).code === "quota" &&
        Number(over.headers.get("retry-after")) > 0 &&
        fresh.status === 200,
      { spent, over: over.status, body: over.body, fresh: fresh.status },
    );
  }

  step("input caps");
  // Every input is capped and validated with a 4xx, never a 500.
  const writer = `192.0.2.${20 + (Date.now() % 200)}`;
  const sign = (body: string) => jfrom(writer, "/api/guestbook", { method: "POST", body });
  const refused = [
    (await sign(JSON.stringify({ name: { a: 1 }, msg: "x" }))).status,
    (await sign(JSON.stringify({ name: "n".repeat(21), msg: "x" }))).status,
    (await sign(JSON.stringify({ name: "n", msg: "m".repeat(61) }))).status,
    (await sign(JSON.stringify({ name: "n", msg: "   " }))).status,
    (await sign("{not json")).status,
    (await sign("x".repeat(5000))).status,
  ];
  check(
    "input: the guestbook refuses non-text, too-long, blank, malformed and oversized input with a 4xx",
    JSON.stringify(refused) === "[400,400,400,400,400,413]",
    refused,
  );
  const signed = await sign(JSON.stringify({ name: "  Zoë\u202e  ", msg: "line\none\u0000two" }));
  const signedRow = obj(arr(obj(signed.body).rows)[0]);
  check(
    "input: control and bidi-override characters are cleaned before they are stored",
    signed.status === 201 && signedRow.name === "Zoë" && signedRow.msg === "line one two",
    signed.body,
  );
  const chunkUrl = (name: string, total: number, id = "0123456789abcdef", n = 0, count = 1) =>
    `/api/r2/chunk?name=${name}&id=${id}&n=${n}&count=${count}&total=${total}&type=text%2Fplain`;
  const longName = await jfrom(writer, chunkUrl("n".repeat(65), 1), { method: "PUT", body: "x" });
  const tooBig = await jfrom(writer, chunkUrl("big.txt", 26214401, "0123456789abcdef", 0, 26), {
    method: "PUT",
    body: "x",
  });
  const wrongSize = await jfrom(writer, chunkUrl("short.txt", 5), { method: "PUT", body: "x" });
  const badId = await jfrom(writer, chunkUrl("badid.txt", 1, "nothex"), { method: "PUT", body: "x" });
  const orphan = await jfrom(writer, chunkUrl("orphan.txt", 2097152, "fedcba9876543210", 1, 2), {
    method: "PUT",
    body: "x".repeat(1048576),
  });
  const emptyFile = await jfrom(writer, chunkUrl("empty.txt", 0), { method: "PUT", body: "" });
  check(
    "input: R2 refuses a long name, a file over the 25 MB cap, a chunk of the wrong size, a bad id and a chunk without its first; a 0-byte file is stored",
    longName.status === 400 &&
      tooBig.status === 413 &&
      wrongSize.status === 400 &&
      badId.status === 400 &&
      orphan.status === 409 &&
      emptyFile.status === 201,
    [longName.status, tooBig.status, wrongSize.status, badId.status, orphan.status, emptyFile.status],
  );
  await jfrom(writer, "/api/r2?name=empty.txt", { method: "DELETE" });
  const secretFlood = await jfrom(writer, "/api/secrets/check", {
    method: "POST",
    body: JSON.stringify({ token: "t".repeat(300) }),
  });
  const queueLabel = await jfrom(writer, "/api/queue/enqueue", {
    method: "POST",
    body: JSON.stringify({ label: "L".repeat(41) }),
  });
  check(
    "input: the secret check and the queue label are capped too",
    secretFlood.status === 400 && queueLabel.status === 400,
    [secretFlood.status, queueLabel.status],
  );

  step("chat room limits");
  // The room caps a frame, the rate per connection and the connections per address.
  const wsUrl = base.replace("http", "ws") + "/api/chat";
  const chatter = `198.18.0.${20 + (Date.now() % 200)}`;
  const openChat = (address: string) =>
    new Promise<{ socket: WebSocket; frames: JsonObject[] }>((resolve, reject) => {
      const frames: JsonObject[] = [];
      const socket = new WebSocket(wsUrl, { headers: { "x-forwarded-for": address } });
      socket.onmessage = (event) => {
        const frame = jsonObject(parseJsonValue(String(event.data)));
        if (frame) frames.push(frame);
      };
      socket.onopen = () => resolve({ socket, frames });
      socket.onerror = () => reject(new Error("the chat socket did not open"));
    });
  const room = await openChat(chatter);
  room.socket.send(JSON.stringify({ type: "hello", name: "\u202e" + "n".repeat(30) }));
  room.socket.send(JSON.stringify({ type: "hello", name: "Ada\u0000" }));
  await Bun.sleep(1100);
  room.socket.send(JSON.stringify({ type: "msg", text: "x".repeat(1001) }));
  room.socket.send("null");
  await Bun.sleep(1100);
  for (let i = 0; i < 30; i++)
    room.socket.send(JSON.stringify({ type: "msg", text: "flood " + i, sent: { evil: true } }));
  await Bun.sleep(800);
  const errors = room.frames.filter((f) => f.type === "error").map((f) => String(f.code));
  const said = room.frames.filter((f) => f.type === "msg");
  check(
    "chat: a message over 1,000 characters and a non-object frame get an error frame",
    errors.includes("too_long") && errors.includes("bad_frame"),
    errors,
  );
  check(
    "chat: a flood is answered with rate_limited errors; at most 3 messages a second pass",
    errors.includes("rate_limited") && said.length >= 1 && said.length <= 6,
    { errors: errors.length, said: said.length },
  );
  check(
    "chat: the name is cleaned and a non-numeric sent field is not echoed",
    said.length > 0 && said.every((f) => f.name === "Ada" && f.sent === 0),
    said[0] ?? null,
  );
  // The flood above closed that socket (too many strikes), so the cap is tried from a new address.
  const crowd = `198.18.1.${20 + (Date.now() % 200)}`;
  const sockets: WebSocket[] = [];
  let turnedAway = 0;
  for (let i = 0; i < 7; i++) {
    try {
      sockets.push((await openChat(crowd)).socket);
    } catch {
      turnedAway++;
    }
  }
  check("chat: five connections per address, the rest are refused", sockets.length === 5 && turnedAway === 2, {
    opened: sockets.length,
    turnedAway,
  });
  for (const socket of sockets) socket.close();
  room.socket.close();

  // cron: fire the scheduled trigger the way the broker would. An embedded binary has no broker and no token, so it
  // refuses external triggers by design (#15) and drives its own on a timer instead.
  if (options.skipTriggers) return;

  // The file sweep (*/15) deletes files whose hour is up. Its scheduledTime is its clock, so a run
  // "two hours from now" finds a file uploaded just now expired; one "now" leaves it alone.
  step("cron: the file sweep");
  const sweeper = `192.0.2.${20 + ((Date.now() + 53) % 200)}`;
  const kept = await jfrom(
    sweeper,
    "/api/r2/chunk?name=sweep.txt&id=00000000000000aa&n=0&count=1&total=4&type=text%2Fplain",
    {
      method: "PUT",
      body: "keep",
    },
  );
  const early = await trigger("*/15 * * * *", Date.now());
  const stillThere = await jfrom(sweeper, "/api/r2/file?name=sweep.txt");
  const late = await trigger("*/15 * * * *", Date.now() + 2 * 3600000);
  const afterSweep = await jfrom(sweeper, "/api/r2");
  check(
    "cron: the */15 sweep keeps a fresh file and deletes one whose hour is up",
    kept.status === 201 &&
      early.status === 204 &&
      stillThere.status === 200 &&
      late.status === 204 &&
      !arr(obj(afterSweep.body).objects).some((o) => obj(o).name === "sweep.txt"),
    { kept: kept.status, early: early.status, stillThere: stillThere.status, late: late.status, list: afterSweep.body },
  );

  // The daily reset is its own cron (0 4 * * *), told apart by event.cron: it empties the bucket, goes back to the
  // three seed guestbook rows, starts the KV counter over and clears the chat history.
  step("cron: the daily reset");
  const resetter = `192.0.2.${20 + ((Date.now() + 71) % 200)}`;
  await jfrom(resetter, "/api/kv/incr", { method: "POST" });
  await jfrom(resetter, "/api/guestbook", { method: "POST", body: JSON.stringify({ name: "x", msg: "to be reset" }) });
  await jfrom(resetter, "/api/r2/chunk?name=reset.txt&id=00000000000000bb&n=0&count=1&total=4&type=text%2Fplain", {
    method: "PUT",
    body: "gone",
  });
  const reset = await trigger("0 4 * * *", Date.now());
  check("cron: the daily reset runs (204)", reset.status === 204, reset.status);
  const afterReset = await jfrom(resetter, "/api/r2");
  const seeded = obj((await jfrom(resetter, "/api/guestbook")).body);
  const counter = obj((await jfrom(resetter, "/api/kv")).body);
  check(
    "cron: the daily reset empties R2 and the KV counter and goes back to the seed guestbook",
    arr(obj(afterReset.body).objects).length === 0 && Number(counter.n) === 0 && Number(seeded.total) === 3,
    { objects: obj(afterReset.body).objects, counter: counter.n, total: seeded.total },
  );
}
