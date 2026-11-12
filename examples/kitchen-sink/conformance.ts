/**
 * The conformance checks: every binding, driven over HTTP against a running
 * kitchen-sink.
 *
 * Extracted from harness.ts so more than one backend can be held to it. The
 * broker-backed harness runs these against a host sprout plus an in-process
 * broker; the standalone harness runs the same list against a single binary
 * with its bindings compiled in. Two implementations of the binding ops is the
 * failure mode that argues against having a second backend at all — this file
 * is what makes `env.KV.get` mean one thing in both.
 *
 * Deliberately free of any knowledge of how the app is running: it gets a base
 * URL and a trigger token, and asserts on responses.
 */
import { isSafeInteger, isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../../src/json";
import { request as httpRequest } from "node:http";
import { egressRefusal } from "@sproutboat/runtime";
import type { Harness } from "../lib/harness";
import { runR2RoundTrip } from "./r2-roundtrip";

const obj = (value: JsonValue | undefined): JsonObject => jsonObject(value ?? null) ?? {};
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

async function rawGetFrom(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, signal }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

export type CheckFn = (name: string, cond: boolean, detail?: JsonValue) => void;

/**
 * Run every binding check against `base`. `token` is SB_BROKER_TOKEN, needed to
 * post the internal trigger requests (cron / queue) the broker would normally
 * send. `check` reports; it is expected to abort on failure.
 */
export type ConformanceOptions = {
  /**
   * Skip the checks that post an internal `x-sb-trigger` request. An embedded
   * standalone binary runs its own cron and queue timers in-process, so there is
   * no broker to impersonate — the behaviour is covered, just not reachable this
   * way.
   */
  skipTriggers?: boolean;
  /**
   * Skip the service-binding check. A standalone binary has no edge to route a
   * worker-to-worker call through, so the build refuses the binding outright.
   */
  skipServices?: boolean;
  /** Broker-mode ticket URLs are handled by its separate transfer listener. */
  skipDirectTransfer?: boolean;
  /** The stub upstream's origin; its /redirect answers 302 to a private address. */
  upstream?: string;
  /**
   * The harness that owns the child under test (#276). Every request then has a
   * deadline, the current step is recorded before each group of checks, and a
   * stalled response or a child that exits fails with a report instead of waiting.
   */
  harness?: Harness;
};

export async function runConformance(
  base: string,
  TOKEN: string,
  check: CheckFn,
  options: ConformanceOptions = {},
): Promise<void> {
  const harness = options.harness;
  const step = (name: string) => harness?.step(name);
  // The app keys its rate limits on the client address. Behind a proxy that is X-Forwarded-For,
  // which the app believes when the TCP peer is a private address, as it is here. So each
  // run gets its own address: a second run inside the same minute has a fresh budget, and a
  // check that wants its own budget sends its own header.
  const runAddress = `198.51.100.${20 + (Date.now() % 200)}`;
  const addressed = (init: RequestInit | undefined, address: string): RequestInit => {
    const headers = new Headers(init?.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", address);
    return { ...init, headers };
  };
  // Without a harness (a caller that does not own the child) requests are unbounded, as before.
  const fetch = (url: string, init?: RequestInit): Promise<Response> =>
    harness ? harness.fetch(url, addressed(init, runAddress)) : globalThis.fetch(url, addressed(init, runAddress));
  const rawGet = (url: string, headers: Record<string, string>) =>
    harness
      ? harness.bounded("request-timeout", `GET ${new URL(url).pathname}`, harness.requestTimeoutMs, (signal) =>
          rawGetFrom(url, { "x-forwarded-for": runAddress, ...headers }, signal),
        )
      : rawGetFrom(url, { "x-forwarded-for": runAddress, ...headers });
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

  console.log("\nbindings:");

  step("vars: GET / uses env.SITE_NAME");
  // vars
  check("vars: GET / uses env.SITE_NAME", String((await jget("/")).body).includes("Sproutboat Notes"));

  step("static assets");
  // static assets: env.ASSETS.fetch serves index.html; SPA fallback for unknown GET
  const home = await fetch(base + "/");
  check(
    "assets: GET / serves index.html with html content-type",
    home.status === 200 &&
      (home.headers.get("content-type") || "").includes("text/html") &&
      (await home.text()).includes("<h1>Sproutboat Notes"),
  );
  const spa = await fetch(base + "/some/client/route");
  check(
    "assets: unknown GET falls back to the SPA shell (200)",
    spa.status === 200 && (await spa.text()).includes("<h1>Sproutboat Notes"),
  );
  // #176: a reserved x-sb-raw-body response header tells the C write path to
  // pass an asset's bytes through untouched instead of re-encoding them as if
  // they were a JS string a handler built (porf_native_fetch_read_raw_bytes).
  const binaryAsset = new Uint8Array(await (await fetch(base + "/binary-fixture.bin")).arrayBuffer());
  check(
    "assets: binary bytes are unchanged",
    binaryAsset.length === 256 && binaryAsset.every((byte, index) => byte === index),
  );

  step("KV: login and whoami");
  // KV (login -> whoami)
  const login = await jget("/login", { method: "POST" });
  const token = String(obj(login.body).token);
  check("KV: login issues a token", token.length > 10, login.body);
  const who = await jget("/whoami", { headers: { authorization: "Bearer " + token } });
  check("KV: whoami resolves the session", who.status === 200 && obj(who.body).user === "demo", who.body);

  step("D1: create, list, unicode");
  // D1 (create + list + get)
  const created = await jget("/notes", { method: "POST", body: JSON.stringify({ title: "hello", body: "world" }) });
  check("D1: POST /notes inserts", created.status === 201 && isSafeInteger(obj(created.body).id), created.body);
  const noteId = Number(obj(created.body).id);
  const list = await jget("/notes");
  check("D1: GET /notes lists it", arr(list.body).length >= 1, list.body);
  // baronunread/sproutboat#189: non-ASCII text used to come back as Latin-1 mojibake.
  const unicodeTitle = "café 日本 😀";
  await jget("/notes", { method: "POST", body: JSON.stringify({ title: unicodeTitle, body: "" }) });
  const titles = arr((await jget("/notes")).body).map((row) => obj(row).title);
  check("D1: non-ASCII text round-trips", titles.includes(unicodeTitle), titles);

  step("Durable Object: view counter");
  // Durable Object (view counter increments atomically)
  const v1 = await jget(`/notes/${noteId}`);
  const v2 = await jget(`/notes/${noteId}`);
  check("DO: view count increments across requests", Number(obj(v2.body).views) === Number(obj(v1.body).views) + 1, {
    v1: obj(v1.body).views,
    v2: obj(v2.body).views,
  });

  step("R2: attach, fetch back, list");
  // R2 (attach + fetch back + list)
  const att = await jget(`/notes/${noteId}/attach`, { method: "POST", body: "the file contents" });
  check("R2: attach stores a key", isString(obj(att.body).key), att.body);
  const file = await fetch(base + `/attach/${encodeURIComponent(String(obj(att.body).key))}`);
  check(
    "R2: GET /attach returns the body + etag",
    (await file.text()) === "the file contents" && !!file.headers.get("etag"),
  );
  const atts = await jget("/attachments");
  check(
    "R2: GET /attachments lists the object",
    arr(atts.body).some((o) => obj(o).key === obj(att.body).key),
    atts.body,
  );

  if (!options.skipDirectTransfer) {
    // This exceeds the normal 1 MiB native-fetch Request limit. A standalone
    // binary must stream the ticket PUT through the native bridge instead.
    const direct = await jget("/r2/direct-upload", { method: "POST" });
    const directInfo = obj(direct.body);
    step("R2 direct upload: 2 MiB PUT through the ticket");
    const largeBody = "x".repeat(2 * 1024 * 1024);
    const directPut = await fetch(base + String(directInfo.url), { method: "PUT", body: largeBody });
    check("R2 direct upload: native ticket accepts a 2 MiB body", directPut.status === 201, directPut.status);
    step("R2 direct upload: read the published object back");
    const directRead = await fetch(base + "/attach/" + encodeURIComponent(String(directInfo.key)));
    check(
      "R2 direct upload: published object reads back intact",
      directRead.status === 200 && (await directRead.text()) === largeBody,
      directRead.status,
    );
    step("R2 direct download: byte range 1024-2047");
    const rangedTicket = await jget("/r2/direct-download?key=" + encodeURIComponent(String(directInfo.key)));
    const ranged = await rawGet(base + String(obj(rangedTicket.body).url), { Range: "bytes=1024-2047" });
    check(
      "R2 direct download: native ticket serves a byte range",
      ranged.status === 206 &&
        ranged.headers["content-range"] === `bytes 1024-2047/${largeBody.length}` &&
        ranged.body === largeBody.slice(1024, 2048),
      ranged.status,
    );
    step("R2 direct download: complete 2 MiB object");
    const download = await jget("/r2/direct-download?key=" + encodeURIComponent(String(directInfo.key)));
    const directDownload = await fetch(base + String(obj(download.body).url));
    check(
      "R2 direct download: native ticket streams the complete object",
      directDownload.status === 200 && (await directDownload.text()) === largeBody,
      directDownload.status,
    );
    step("R2 direct download: If-None-Match");
    const conditionalTicket = await jget("/r2/direct-download?key=" + encodeURIComponent(String(directInfo.key)));
    const conditional = await rawGet(base + String(obj(conditionalTicket.body).url), { "If-None-Match": "*" });
    check(
      "R2 direct download: native ticket honors If-None-Match",
      conditional.status === 304 && Boolean(conditional.headers.etag),
      conditional.status,
    );
  }

  step("async handler");
  // async handler: the prelude must return the handler's own promise untouched
  const asyncRes = await jget("/async");
  check(
    "async: a promise-returning route resolves",
    asyncRes.status === 200 && obj(asyncRes.body).async === true,
    asyncRes.body,
  );

  step("outbound fetch");
  // outbound fetch
  const quote = await jget("/quote");
  check(
    "fetch: /quote proxies the upstream",
    quote.status === 200 && isString(obj(quote.body).content) && String(obj(quote.body).author).length > 0,
    quote.body,
  );

  step("egress refusals");
  // #174 — fetch() never reaches a private address, and both backends refuse
  // with the same words. The harness allows 127.0.0.1 only, for its stub.
  const refusals: Array<[url: string, hostname: string, address: string]> = [
    ["http://127.0.0.2:9/", "127.0.0.2", "127.0.0.2"],
    ["http://169.254.169.254/latest/meta-data/", "169.254.169.254", "169.254.169.254"],
    ["http://10.0.0.1/", "10.0.0.1", "10.0.0.1"],
    ["http://[::1]:9/", "[::1]", "::1"],
    ["http://[64:ff9b::7f00:2]:9/", "[64:ff9b::7f00:2]", "64:ff9b::7f00:2"],
  ];
  for (const [url, hostname, address] of refusals) {
    const refused = await jget(`/egress?to=${encodeURIComponent(url)}`);
    check(
      `egress: fetch(${url}) is refused`,
      obj(refused.body).error === `sproutboat fetch: ${egressRefusal(hostname, address, [])}`,
      refused.body,
    );
  }
  if (options.upstream) {
    const hop = await jget(`/egress?to=${encodeURIComponent(`${options.upstream}/redirect`)}`);
    check(
      "egress: a redirect to a private address comes back unfollowed",
      obj(hop.body).status === 302 && obj(hop.body).location === "http://127.0.0.2/",
      hop.body,
    );
  }

  step("secret gate");
  // secret gate
  const denied = await jget("/admin/stats", { headers: { "x-admin-token": "wrong" } });
  check("secret: /admin/stats rejects a bad ADMIN_TOKEN", denied.status === 403);
  const allowed = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
  check(
    "secret: /admin/stats accepts the real ADMIN_TOKEN",
    allowed.status === 200 && obj(allowed.body).site === "Sproutboat Notes",
    allowed.body,
  );

  step("analytics engine");
  // analytics engine — env.METRICS.query() feeds the dashboard
  check(
    "analytics: METRICS.query reports data points",
    Number(obj(allowed.body).analytics_points) > 0 && Array.isArray(obj(allowed.body).analytics_recent),
    allowed.body,
  );

  // service binding (#48): env.PEER.fetch() reaches a second deployment through
  // the edge, so a 200 here means the shim -> broker -> Host path works.
  if (!options.skipServices) {
    step("service binding: PEER.fetch");
    const peer = await jget("/peer");
    check(
      "service binding: env.PEER.fetch reaches another deployment",
      peer.status === 200 && Number(obj(peer.body).status) === 200 && String(obj(peer.body).body).includes("author"),
      peer.body,
    );
  }

  step("crypto.subtle and scrypt");
  // crypto.subtle (#133): a known SHA-256 vector and an HMAC round-trip.
  const h = obj((await jget("/hash")).body);
  check(
    "crypto.subtle: SHA-256 digest matches the known vector",
    h.digest === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    h.digest,
  );
  check(
    "crypto.subtle: HMAC sign + verify round-trips, a tampered message fails",
    isString(h.hmac) && h.hmac.length === 64 && h.verifyOk === true && h.verifyBad === false,
    h,
  );
  const rounds = arr(h.rounds);
  check(
    "crypto.subtle: repeated HMAC uses raw digest bytes between rounds",
    rounds[0] === "e94df4f03406bc36299dd6e6961b22b50fc963fbbf8aeb773f8d7960a77e741e" &&
      rounds[1] === "1321aaf34d2ad833bd0c8af3ab6c3a91f2be090fd9631538c88ec3986b6eac28",
    h.rounds,
  );
  check(
    "crypto.scryptVerify: a matching hash verifies, a wrong password does not (#153)",
    h.scryptOk === true && h.scryptBad === false,
    h,
  );

  step("rate limiter");
  // rate limiter (#69): a unique key gets `limit` successes then a failure, and
  // every reply carries resetAt (epoch ms) so a 429 can send Retry-After.
  const rlKey = "conf-" + Date.now();
  const rl = [];
  const rlResets = [];
  for (let i = 0; i < 4; i++) {
    const res = obj((await jget("/throttle?key=" + rlKey)).body);
    rl.push(res.success);
    rlResets.push(Number(res.resetAt));
  }
  check("ratelimit: THROTTLE allows 3 then blocks the 4th", JSON.stringify(rl) === "[true,true,true,false]", rl);
  check(
    "ratelimit: every reply carries resetAt within one period ahead",
    rlResets.every((t) => t > Date.now() && t <= Date.now() + 61 * 1000),
    rlResets,
  );

  step("rate limits per client address");
  // Every route that writes has a per-address budget (WRITES, 30 a minute). The 31st call
  // answers 429 with a retry-after and a JSON body the page can show; another address, and the
  // reads, are unaffected.
  const spender = `203.0.113.${20 + (Date.now() % 200)}`;
  const spent: number[] = [];
  let last = await jfrom(spender, "/login", { method: "POST" });
  spent.push(last.status);
  for (let i = 1; i < 31; i++) {
    last = await jfrom(spender, "/login", { method: "POST" });
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
  const otherAddress = await jfrom(`203.0.113.${220 + (Date.now() % 30)}`, "/login", { method: "POST" });
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
  const hoarder = `192.0.2.${20 + (Date.now() % 200)}`;
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
    const fresh = await spend("b1", `192.0.2.${20 + ((Date.now() + 97) % 200)}`, piece);
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
  const notesBody = await jfrom(writer, "/notes", {
    method: "POST",
    body: JSON.stringify({ title: "t", body: "b".repeat(4001) }),
  });
  check(
    "input: the secret check, the queue label and a note body are capped too",
    secretFlood.status === 400 && queueLabel.status === 400 && notesBody.status === 400,
    [secretFlood.status, queueLabel.status, notesBody.status],
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
  room.socket.send(JSON.stringify({ type: "msg", text: "x".repeat(121) }));
  room.socket.send("null");
  await Bun.sleep(1100);
  for (let i = 0; i < 30; i++)
    room.socket.send(JSON.stringify({ type: "msg", text: "flood " + i, sent: { evil: true } }));
  await Bun.sleep(800);
  const errors = room.frames.filter((f) => f.type === "error").map((f) => String(f.code));
  const said = room.frames.filter((f) => f.type === "msg");
  check(
    "chat: a message over 120 characters and a non-object frame get an error frame",
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

  step("Durable Object alarm roll-up");
  // DO alarms (#125): viewing a note debounces an alarm a second out, whose
  // handler rolls the count up into D1. Poll, because the whole point is that
  // it happens after the request that scheduled it has gone.
  let rollups = 0;
  for (let i = 0; i < 20; i++) {
    const stats = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
    rollups = Number(obj(stats.body).do_alarm_rollups || 0);
    if (rollups > 0) break;
    await Bun.sleep(300);
  }
  check("DO alarm: the debounced roll-up ran and wrote to D1", rollups > 0, { rollups });

  step("queue consumer");
  // queue: POST /notes enqueued an EMAILS job; the broker consumer delivers it
  let emailLogged = 0;
  for (let i = 0; i < 20; i++) {
    const stats = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
    emailLogged = Number(obj(stats.body).queue_emails_processed || 0);
    if (emailLogged > 0) break;
    await Bun.sleep(300);
  }
  check("queue: EMAILS job consumed -> email_log row", emailLogged > 0, { emailLogged });

  // cron: fire the scheduled trigger the way the broker would. An embedded
  // binary has no broker and no token, so it refuses external triggers by
  // design (#15) and drives its own on a timer instead.
  if (options.skipTriggers) return;
  step("cron: scheduled trigger");
  const sched = await fetch(base + "/", {
    method: "POST",
    headers: { "x-sb-trigger": "scheduled", "x-sb-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ cron: "*/1 * * * *", scheduledTime: Date.now() }),
  });
  check("cron: scheduled() runs (204)", sched.status === 204, sched.status);
  const afterCron = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
  check("cron: heartbeat row written by scheduled()", Number(obj(afterCron.body).cron_heartbeats) > 0, afterCron.body);

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
  const trigger = (cron: string, scheduledTime: number) =>
    fetch(base + "/", {
      method: "POST",
      headers: { "x-sb-trigger": "scheduled", "x-sb-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ cron, scheduledTime }),
    });
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

  // The daily reset is its own cron (0 4 * * *), told apart by event.cron: it empties the bucket,
  // goes back to the three seed guestbook rows and clears the chat history.
  step("cron: the daily reset");
  await jget("/notes/" + noteId + "/attach", { method: "POST", body: "to be reset" });
  const reset = await fetch(base + "/", {
    method: "POST",
    headers: { "x-sb-trigger": "scheduled", "x-sb-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ cron: "0 4 * * *", scheduledTime: Date.now() }),
  });
  check("cron: the daily reset runs (204)", reset.status === 204, reset.status);
  const afterReset = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
  const seeded = obj((await jget("/api/guestbook")).body);
  check(
    "cron: the daily reset empties R2, notes and sessions and goes back to the seed guestbook",
    Number(obj(afterReset.body).r2_objects) === 0 &&
      Number(obj(afterReset.body).d1_notes) === 0 &&
      Number(obj(afterReset.body).kv_sessions) === 0 &&
      Number(seeded.total) === 3,
    { stats: afterReset.body, total: seeded.total },
  );
}
