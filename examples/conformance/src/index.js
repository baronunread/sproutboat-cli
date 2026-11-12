// The conformance fixture's worker. It is not an example (examples/README.md, "Rules for examples"): every route
// and vector here exists so conformance.ts can hold both backends (the broker and the standalone binary) to one
// definition of what each binding does. kitchen-sink used to carry these routes; they live here now.
//
//   POST /login, GET /whoami          KV           session token with its own expiry
//   POST /notes, GET /notes[/:id]     D1 + queue + Durable Object (view counter, alarm roll-up)
//   POST /notes/:id/attach            R2           put, fetch back, list, and one-use transfer tickets
//   GET  /quote, /egress              outbound fetch and its refusal of private addresses
//   GET  /peer                        service binding
//   GET  /hash                        crypto.subtle digest and HMAC vectors, and crypto.scryptVerify
//   GET  /throttle                    rate-limiter binding
//   GET  /async                       a promise-returning handler, handed back untouched
//   GET  /admin/stats                 secret gate, and one number per binding
//   scheduled(), queue()              cron heartbeat, queue consumer
import { DurableObject } from "cloudflare:workers";

const json = (data, status = 200) => Response.json(data, { status });

export class ViewCounter extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/incr") {
      const n = ((await this.ctx.storage.get("n")) || 0) + 1;
      await this.ctx.storage.put("n", n);
      // Debounced roll-up: every view schedules the same alarm a second out, so a burst of views makes one alarm.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return new Response(String(n));
    }
    return new Response(String((await this.ctx.storage.get("n")) || 0));
  }

  // Runs after the views stop. Writes through to D1 so the effect is visible outside the object.
  async alarm() {
    const views = (await this.ctx.storage.get("n")) || 0;
    await this.env.DB.prepare("INSERT INTO view_rollup (views, at) VALUES (?, ?)")
      .bind(views, new Date().toISOString())
      .run();
  }
}

// #133: a SHA-256 digest and HMAC round trips against known vectors, so an incorrect or missing subset of
// crypto.subtle fails the suite on both backends; #153: scrypt verify against a small-parameter vector.
async function hashVectors() {
  const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const enc = (text) => new TextEncoder().encode(text);
  const digest = hex(await crypto.subtle.digest("SHA-256", enc("abc")));
  const key = await crypto.subtle.importKey("raw", enc("key"), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, enc("message"));
  const verifyOk = await crypto.subtle.verify("HMAC", key, signature, enc("message"));
  const verifyBad = await crypto.subtle.verify("HMAC", key, signature, enc("message!"));
  // h1-regression: the second round signs the raw digest bytes of the first, not their hex text.
  const roundKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 16 }, (_, at) => at + 1),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  let roundData = enc("h1-regression-password-0001");
  const rounds = [];
  for (let round = 0; round < 2; round++) {
    roundData = new Uint8Array(await crypto.subtle.sign("HMAC", roundKey, roundData));
    rounds.push(hex(roundData));
  }
  // node crypto.scryptSync("pw", "salt", 32, { N: 1024, r: 8, p: 1 })
  const expected = "9f1f8695838e682c1689750f45a69fb95645b4a27f0c9994c696b1c98c0a1671";
  const params = { N: 1024, r: 8, p: 1 };
  return {
    digest,
    hmac: hex(signature),
    verifyOk,
    verifyBad,
    rounds,
    scryptOk: crypto.scryptVerify("pw", "salt", expected, params),
    scryptBad: crypto.scryptVerify("nope", "salt", expected, params),
  };
}

let schema;
async function ensureSchema(env) {
  schema ??= env.DB.exec(
    "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, attachment TEXT, created TEXT);" +
      "CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER, sent_at TEXT);" +
      "CREATE TABLE IF NOT EXISTS heartbeat (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, cron TEXT);" +
      "CREATE TABLE IF NOT EXISTS view_rollup (id INTEGER PRIMARY KEY AUTOINCREMENT, views INTEGER, at TEXT)",
  );
  try {
    await schema;
  } catch (error) {
    schema = undefined;
    throw error;
  }
}

const count = (env, table) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // POST /login -> a session token in KV, whose value carries its own expiry
  if (path === "/login" && method === "POST") {
    const token = crypto.randomUUID();
    const expires = Date.now() + 60 * 60 * 1000;
    await env.SESSIONS.put(token, JSON.stringify({ user: "demo", expires }));
    return json({ token, expires });
  }

  // GET /whoami -> resolve a session token
  if (path === "/whoami") {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const raw = token ? await env.SESSIONS.get(token) : null;
    return raw ? json(JSON.parse(raw)) : json({ error: "no session" }, 401);
  }

  // POST /notes {title, body}: D1 insert, then a queue job
  if (path === "/notes" && method === "POST") {
    const { title, body } = await request.json();
    const { meta } = await env.DB.prepare("INSERT INTO notes (title, body, created) VALUES (?, ?, ?)")
      .bind(title || "untitled", body ?? "", new Date().toISOString())
      .run();
    await env.EMAILS.send({ noteId: meta.last_row_id });
    return json({ id: meta.last_row_id }, 201);
  }

  if (path === "/notes" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, title, created, attachment FROM notes ORDER BY id DESC LIMIT 50",
    ).all();
    return json(results);
  }

  // GET /notes/:id -> the note and a fresh view count from the Durable Object
  const noteMatch = /^\/notes\/(\d+)$/.exec(path);
  if (noteMatch && method === "GET") {
    const id = noteMatch[1];
    const note = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
    if (!note) return json({ error: "not found" }, 404);
    const views = await env.VIEWS.getByName("note:" + id).fetch("https://do/incr", { method: "POST" });
    return json({ note, views: Number(await views.text()) });
  }

  // POST /notes/:id/attach (the raw body is the file)
  const attachMatch = /^\/notes\/(\d+)\/attach$/.exec(path);
  if (attachMatch && method === "POST") {
    const id = attachMatch[1];
    const key = "note-" + id + "-" + Date.now() + ".txt";
    await env.UPLOADS.put(key, await request.text(), { customMetadata: { noteId: id } });
    await env.DB.prepare("UPDATE notes SET attachment = ? WHERE id = ?").bind(key, id).run();
    return json({ key });
  }

  const fileMatch = /^\/attach\/(.+)$/.exec(path);
  if (fileMatch && method === "GET") {
    const object = await env.UPLOADS.get(decodeURIComponent(fileMatch[1]));
    if (!object) return json({ error: "not found" }, 404);
    return new Response(await object.text(), {
      headers: { "content-type": "text/plain", etag: object.httpEtag, "x-content-type-options": "nosniff" },
    });
  }

  if (path === "/attachments" && method === "GET") {
    const { objects } = await env.UPLOADS.list({ limit: 100 });
    return json(objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, httpEtag: o.httpEtag })));
  }

  // POST /r2/direct-upload makes a one-use URL whose PUT body bypasses the handler's Request buffer: the suite
  // sends 2 MiB, more than the 1 MiB native limit, to check a standalone binary streams the ticket PUT.
  if (path === "/r2/direct-upload" && method === "POST") {
    const key = "direct-" + Date.now() + ".txt";
    const ticket = await env.UPLOADS.createUploadUrl(key, { maxBytes: 5 * 1024 * 1024 });
    return json({ key, ...ticket }, 201);
  }
  if (path === "/r2/direct-download" && method === "GET") {
    return json(await env.UPLOADS.createDownloadUrl(url.searchParams.get("key") || ""), 201);
  }

  if (path === "/hash") return json(await hashVectors());

  // GET /throttle -> the rate-limiter binding: 3 a minute per key, and resetAt (epoch ms) for a Retry-After
  if (path === "/throttle") {
    const { success, resetAt } = await env.THROTTLE.limit({ key: "demo:" + (url.searchParams.get("key") || "test") });
    if (!success) {
      const retry = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      return Response.json({ success, resetAt }, { status: 429, headers: { "retry-after": String(retry) } });
    }
    return json({ success, resetAt });
  }

  // GET /quote -> outbound fetch to env.QUOTE_URL
  if (path === "/quote") {
    const upstream = await fetch(env.QUOTE_URL);
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json" } });
  }

  // GET /egress?to=<url> -> what fetch() did with it. A private address is refused with a message naming it
  // (#174), and a redirect comes back unfollowed.
  if (path === "/egress") {
    try {
      const response = await fetch(url.searchParams.get("to") || "", { redirect: "manual" });
      return json({ status: response.status, location: response.headers.get("location") });
    } catch (error) {
      return json({ error: String(error && error.message) });
    }
  }

  // GET /admin/stats -> the secret gate, and one number per binding
  if (path === "/admin/stats") {
    if (request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) return json({ error: "forbidden" }, 403);
    const metrics = await env.METRICS.query({ limit: 8 });
    return json({
      site: env.SITE_NAME,
      d1_notes: await count(env, "notes"),
      r2_objects: (await env.UPLOADS.list()).objects.length,
      queue_emails_processed: await count(env, "email_log"),
      cron_heartbeats: await count(env, "heartbeat"),
      do_alarm_rollups: await count(env, "view_rollup"),
      analytics_points: metrics.count,
      analytics_recent: metrics.rows.map((r) => ({ at: r.timestamp, method: r.blobs[0], path: r.blobs[1] })),
    });
  }

  // GET /peer -> env.PEER.fetch(), a service binding calling another deployment through the edge (#48).
  // A standalone binary has no edge, so the binding is absent there and this route says so.
  if (path === "/peer") {
    if (!env.PEER) return json({ error: "no service binding in this build" }, 501);
    const response = await env.PEER.fetch(new Request("https://peer/random"));
    return json({ status: response.status, body: await response.text() });
  }

  // GET /async -> a promise-returning handler: the prelude has to hand the handler's own promise straight back.
  // Porffor's server resolves that promise and nothing derived from it, so without a route exercising it an
  // async-hostile prelude change hangs every async worker silently.
  if (path === "/async" && method === "GET") return (async () => json({ async: true, path }))();

  // Anything else GET is a static asset: `/` is the page, and an unknown path falls back to it.
  if (method === "GET") return env.ASSETS.fetch(request);
  return json({ error: "not found", path }, 404);
}

export default {
  async fetch(request, env) {
    await ensureSchema(env);
    // One analytics data point per request, which /admin/stats reads back.
    env.METRICS.writeDataPoint({
      blobs: [request.method, new URL(request.url).pathname],
      indexes: [new URL(request.url).pathname],
      doubles: [1],
    });
    return route(request, env);
  },

  // cron */1: a heartbeat row
  async scheduled(controller, env) {
    await ensureSchema(env);
    await env.DB.prepare("INSERT INTO heartbeat (at, cron) VALUES (?, ?)")
      .bind(new Date(controller.scheduledTime).toISOString(), controller.cron)
      .run();
  },

  // queue consumer for EMAILS: pretend to send, log to D1
  async queue(batch, env) {
    await ensureSchema(env);
    for (const message of batch.messages) {
      await env.DB.prepare("INSERT INTO email_log (note_id, sent_at) VALUES (?, ?)")
        .bind(Number(message.body.noteId) || 0, new Date().toISOString())
        .run();
      message.ack();
    }
  },
};
