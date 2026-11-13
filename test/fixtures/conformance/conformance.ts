/**
 * The binding conformance checks: every binding, driven over HTTP against a running conformance fixture.
 *
 * The broker-backed harness runs these against a host sprout plus an in-process broker; the standalone harness
 * runs the same list against a single binary with its bindings compiled in. Two implementations of the binding
 * ops is the failure mode that argues against having a second backend at all, and this file is what makes
 * `env.KV.get` mean one thing in both. It used to be part of kitchen-sink's suite; the routes it drives (and
 * the crypto vectors) live in this fixture's src/index.js now, so the kitchen-sink demo carries none of them.
 *
 * Deliberately free of any knowledge of how the app is running: it gets a base URL and a trigger token.
 */
import { request as httpRequest } from "node:http";
import { egressRefusal } from "@sproutboat/runtime";
import {
  isSafeInteger,
  isString,
  jsonObject,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../../src/json";
import type { RunContext } from "../lib/backends";

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

export type ConformanceOptions = {
  /**
   * Skip the checks that post an internal `x-sb-trigger` request. An embedded standalone binary runs its own cron
   * and queue timers in-process, so there is no broker to impersonate: the behaviour is covered, just not
   * reachable this way.
   */
  skipTriggers?: boolean;
  /** Skip the service-binding check: a standalone binary has no edge to route a worker-to-worker call through. */
  skipServices?: boolean;
  /** Broker-mode ticket URLs are handled by its separate transfer listener. */
  skipDirectTransfer?: boolean;
};

const ADMIN = { "x-admin-token": "s3cr3t-admin" };

export async function runConformance(context: RunContext, options: ConformanceOptions = {}): Promise<void> {
  const { base, token: TOKEN, check, harness, upstream } = context;
  const step = (name: string) => harness.step(name);
  const fetch = (url: string, init?: RequestInit): Promise<Response> => harness.fetch(url, init);
  const rawGet = (url: string, headers: Record<string, string>) =>
    harness.bounded("request-timeout", `GET ${new URL(url).pathname}`, harness.requestTimeoutMs, (signal) =>
      rawGetFrom(url, headers, signal),
    );
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

  step("static assets");
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
  // #176: a reserved x-sb-raw-body response header tells the C write path to pass an asset's bytes through
  // untouched instead of re-encoding them as if they were a JS string a handler built.
  const binaryAsset = new Uint8Array(await (await fetch(base + "/binary-fixture.bin")).arrayBuffer());
  check(
    "assets: binary bytes are unchanged",
    binaryAsset.length === 256 && binaryAsset.every((byte, index) => byte === index),
  );

  step("KV: login and whoami");
  const login = await jget("/login", { method: "POST" });
  const token = String(obj(login.body).token);
  check("KV: login issues a token", token.length > 10, login.body);
  const who = await jget("/whoami", { headers: { authorization: "Bearer " + token } });
  check("KV: whoami resolves the session", who.status === 200 && obj(who.body).user === "demo", who.body);

  step("D1: create, list, unicode");
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
  const v1 = await jget(`/notes/${noteId}`);
  const v2 = await jget(`/notes/${noteId}`);
  check("DO: view count increments across requests", Number(obj(v2.body).views) === Number(obj(v1.body).views) + 1, {
    v1: obj(v1.body).views,
    v2: obj(v2.body).views,
  });

  step("R2: attach, fetch back, list");
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
    // This exceeds the normal 1 MiB native-fetch Request limit. A standalone binary must stream the ticket PUT
    // through the native bridge instead.
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
  // The prelude must return the handler's own promise untouched.
  const asyncRes = await jget("/async");
  check(
    "async: a promise-returning route resolves",
    asyncRes.status === 200 && obj(asyncRes.body).async === true,
    asyncRes.body,
  );

  step("outbound fetch");
  const quote = await jget("/quote");
  check(
    "fetch: /quote proxies the upstream",
    quote.status === 200 && isString(obj(quote.body).content) && String(obj(quote.body).author).length > 0,
    quote.body,
  );

  step("egress refusals");
  // #174: fetch() never reaches a private address, and both backends refuse with the same words. The harness
  // allows 127.0.0.1 only, for its stub.
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
  const hop = await jget(`/egress?to=${encodeURIComponent(`${upstream}/redirect`)}`);
  check(
    "egress: a redirect to a private address comes back unfollowed",
    obj(hop.body).status === 302 && obj(hop.body).location === "http://127.0.0.2/",
    hop.body,
  );

  step("secret gate");
  const denied = await jget("/admin/stats", { headers: { "x-admin-token": "wrong" } });
  check("secret: /admin/stats rejects a bad ADMIN_TOKEN", denied.status === 403);
  const allowed = await jget("/admin/stats", { headers: ADMIN });
  check(
    "secret: /admin/stats accepts the real ADMIN_TOKEN",
    allowed.status === 200 && obj(allowed.body).site === "Sproutboat Notes",
    allowed.body,
  );

  step("analytics engine");
  // env.METRICS.query() feeds /admin/stats
  check(
    "analytics: METRICS.query reports data points",
    Number(obj(allowed.body).analytics_points) > 0 && Array.isArray(obj(allowed.body).analytics_recent),
    allowed.body,
  );

  // service binding (#48): env.PEER.fetch() reaches a second deployment through the edge, so a 200 here means the
  // shim -> broker -> Host path works.
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
  // #69: a unique key gets `limit` successes then a failure, and every reply carries resetAt (epoch ms) so a 429
  // can send Retry-After.
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

  step("Durable Object alarm roll-up");
  // DO alarms (#125): viewing a note debounces an alarm a second out, whose handler rolls the count up into D1.
  // Poll, because the whole point is that it happens after the request that scheduled it has gone.
  let rollups = 0;
  for (let i = 0; i < 20; i++) {
    const stats = await jget("/admin/stats", { headers: ADMIN });
    rollups = Number(obj(stats.body).do_alarm_rollups || 0);
    if (rollups > 0) break;
    await Bun.sleep(300);
  }
  check("DO alarm: the debounced roll-up ran and wrote to D1", rollups > 0, { rollups });

  step("queue consumer");
  // POST /notes enqueued an EMAILS job; the consumer delivers it
  let emailLogged = 0;
  for (let i = 0; i < 20; i++) {
    const stats = await jget("/admin/stats", { headers: ADMIN });
    emailLogged = Number(obj(stats.body).queue_emails_processed || 0);
    if (emailLogged > 0) break;
    await Bun.sleep(300);
  }
  check("queue: EMAILS job consumed -> email_log row", emailLogged > 0, { emailLogged });

  // cron: fire the scheduled trigger the way the broker would. An embedded binary has no broker and no token, so it
  // refuses external triggers by design (#15) and drives its own on a timer instead.
  if (options.skipTriggers) return;
  step("cron: scheduled trigger");
  const sched = await fetch(base + "/", {
    method: "POST",
    headers: { "x-sb-trigger": "scheduled", "x-sb-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ cron: "*/1 * * * *", scheduledTime: Date.now() }),
  });
  check("cron: scheduled() runs (204)", sched.status === 204, sched.status);
  const afterCron = await jget("/admin/stats", { headers: ADMIN });
  check("cron: heartbeat row written by scheduled()", Number(obj(afterCron.body).cron_heartbeats) > 0, afterCron.body);
}
