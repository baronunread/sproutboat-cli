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

const obj = (value: JsonValue | undefined): JsonObject => jsonObject(value ?? null) ?? {};
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

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
};

export async function runConformance(
  base: string,
  TOKEN: string,
  check: CheckFn,
  options: ConformanceOptions = {},
): Promise<void> {
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

  // vars
  check("vars: GET / uses env.SITE_NAME", String((await jget("/")).body).includes("Sproutboat Notes"));

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
  const binaryAsset = new Uint8Array(await (await fetch(base + "/binary-fixture.bin")).arrayBuffer());
  check(
    "assets: binary bytes are unchanged",
    binaryAsset.length === 256 && binaryAsset.every((byte, index) => byte === index),
  );

  // KV (login -> whoami)
  const login = await jget("/login", { method: "POST" });
  const token = String(obj(login.body).token);
  check("KV: login issues a token", token.length > 10, login.body);
  const who = await jget("/whoami", { headers: { authorization: "Bearer " + token } });
  check("KV: whoami resolves the session", who.status === 200 && obj(who.body).user === "demo", who.body);

  // D1 (create + list + get)
  const created = await jget("/notes", { method: "POST", body: JSON.stringify({ title: "hello", body: "world" }) });
  check("D1: POST /notes inserts", created.status === 201 && isSafeInteger(obj(created.body).id), created.body);
  const noteId = Number(obj(created.body).id);
  const list = await jget("/notes");
  check("D1: GET /notes lists it", arr(list.body).length >= 1, list.body);

  // Durable Object (view counter increments atomically)
  const v1 = await jget(`/notes/${noteId}`);
  const v2 = await jget(`/notes/${noteId}`);
  check("DO: view count increments across requests", Number(obj(v2.body).views) === Number(obj(v1.body).views) + 1, {
    v1: obj(v1.body).views,
    v2: obj(v2.body).views,
  });

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

  // async handler: the prelude must return the handler's own promise untouched
  const asyncRes = await jget("/async");
  check(
    "async: a promise-returning route resolves",
    asyncRes.status === 200 && obj(asyncRes.body).async === true,
    asyncRes.body,
  );

  // outbound fetch (allowlisted)
  const quote = await jget("/quote");
  check(
    "fetch: /quote proxies the allowlisted upstream",
    quote.status === 200 && isString(obj(quote.body).content) && String(obj(quote.body).author).length > 0,
    quote.body,
  );

  // secret gate
  const denied = await jget("/admin/stats", { headers: { "x-admin-token": "wrong" } });
  check("secret: /admin/stats rejects a bad ADMIN_TOKEN", denied.status === 403);
  const allowed = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
  check(
    "secret: /admin/stats accepts the real ADMIN_TOKEN",
    allowed.status === 200 && obj(allowed.body).site === "Sproutboat Notes",
    allowed.body,
  );

  // analytics engine — env.METRICS.query() feeds the dashboard
  check(
    "analytics: METRICS.query reports data points",
    Number(obj(allowed.body).analytics_points) > 0 && Array.isArray(obj(allowed.body).analytics_recent),
    allowed.body,
  );

  // service binding (#48): env.PEER.fetch() reaches a second deployment through
  // the edge, so a 200 here means the shim -> broker -> Host path works.
  if (!options.skipServices) {
    const peer = await jget("/peer");
    check(
      "service binding: env.PEER.fetch reaches another deployment",
      peer.status === 200 && Number(obj(peer.body).status) === 200 && String(obj(peer.body).body).includes("author"),
      peer.body,
    );
  }

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
  check(
    "crypto.scryptVerify: a matching hash verifies, a wrong password does not (#153)",
    h.scryptOk === true && h.scryptBad === false,
    h,
  );

  // rate limiter (#69): a unique key gets `limit` successes then a failure.
  const rlKey = "conf-" + Date.now();
  const rl = [];
  for (let i = 0; i < 4; i++) rl.push(obj((await jget("/throttle?key=" + rlKey)).body).success);
  check("ratelimit: THROTTLE allows 3 then blocks the 4th", JSON.stringify(rl) === "[true,true,true,false]", rl);

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
  const sched = await fetch(base + "/", {
    method: "POST",
    headers: { "x-sb-trigger": "scheduled", "x-sb-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ cron: "*/1 * * * *", scheduledTime: Date.now() }),
  });
  check("cron: scheduled() runs (204)", sched.status === 204, sched.status);
  const afterCron = await jget("/admin/stats", { headers: { "x-admin-token": "s3cr3t-admin" } });
  check("cron: heartbeat row written by scheduled()", Number(obj(afterCron.body).cron_heartbeats) > 0, afterCron.body);
}
