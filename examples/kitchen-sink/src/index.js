// Kitchen-sink Sproutboat app: a dashboard where every tile calls a real binding.
//
//   vars      SITE_NAME
//   secret    ADMIN_TOKEN          (the Secrets tile reads whether it is set)
//   KV        SESSIONS             the counter tile
//   D1        DB                   guestbook, events, quotas
//   R2        UPLOADS              files, stored as 1 MiB chunks
//   queue     EMAILS               jobs -> queue() handler -> events in D1
//   DO        ROOM (ChatRoom)      WebSocket chat on the hibernation API
//   analytics METRICS              one data point per request
//   ratelimit THROTTLE, WRITES, BULK, READS   per client address
//   service   PEER -> quote-service  the quote tile
//   cron      */1, */15, 0 4 * * *  -> scheduled()
//   assets    ASSETS (site/)       the page, served by env.ASSETS.fetch(request)
//
// The routes under /api/ feed the dashboard in public/. Each tile's handler sits between `#region` markers:
// build-web.ts copies those excerpts into the page's Code panels, so the code on screen is the code that runs.
// Routes and vectors that exist only to test the bindings live in examples/conformance, not here.
import { DurableObject } from "cloudflare:workers";

// #region chat
// One room, one object. The sockets use the hibernation API: the object does not
// hold the connections itself, it accepts them with ctx.acceptWebSocket and gets
// webSocketMessage / webSocketClose calls, so an idle room can be unloaded.
// The room is public, so it defends itself: a frame size cap, a message rate per
// connection, a connection cap per address and for the room, and every field a
// client sends is checked before it is stored or echoed.
// text counts characters (code points, so one emoji is one); frame counts UTF-8 bytes. A frame of 4096
// bytes holds 1,000 four-byte characters (4,000 bytes) and the JSON around them. The history is 30
// messages (HISTORY), so the stored room is at most 30 x 4 KB = 120 KB: well inside a Durable Object's
// memory and under the 128 KiB a single storage value may hold.
const CHAT = {
  frame: 4096,
  text: 1000,
  name: 20,
  perSecond: 3,
  perTenSeconds: 12,
  perAddress: 5,
  room: 60,
  strikes: 8,
};
const HISTORY = 30;
const HISTORY_BYTES = 96 * 1024; // the stored history value stays under this (the platform limit is 128 KiB)

/** @extends {DurableObject<Env>} */
export class ChatRoom extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    // The daily reset (scheduled()) calls this; /api/chat can never reach it,
    // because the worker only forwards that one path.
    if (url.pathname === "/reset" && request.method === "POST") {
      await this.ctx.storage.delete("history");
      this.broadcast({ type: "history", messages: [] });
      return new Response("cleared");
    }
    // The limits are checked before the upgrade, so a page whose socket failed to open (a browser says
    // nothing about why) can ask with a plain GET: 503 means the room is full and will not take it, 429
    // means too many connections from its address, 426 means there is no limit in the way.
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= CHAT.room) return refusal(503, "the room is full: " + CHAT.room + " connections");
    const who = clientIp(request);
    if (who.known) {
      let mine = 0;
      for (const ws of sockets) {
        const at = ws.deserializeAttachment();
        if (at && at.ip === who.ip) mine++;
      }
      if (mine >= CHAT.perAddress) {
        return refusal(429, "too many open connections from your address: " + CHAT.perAddress + " at most");
      }
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ name: "", ip: who.known ? who.ip : "", t1: 0, n1: 0, t10: 0, n10: 0, strikes: 0 });
    const history = (await this.ctx.storage.get("history")) || [];
    pair[1].send(JSON.stringify({ type: "history", messages: history }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  presence() {
    const names = [];
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const who = ws.deserializeAttachment();
      if (who && who.name && names.length < 20) names.push(who.name);
    }
    return { type: "presence", n: sockets.length, names };
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // A socket that is closing may still be listed (as it is on Workers); it needs nothing sent.
      }
    }
  }

  // Count one frame against the connection's two windows (per second, per ten
  // seconds). Returns 0 when it may pass, else the seconds to wait.
  throttle(ws, who, now) {
    if (now - who.t1 >= 1000) {
      who.t1 = now;
      who.n1 = 0;
    }
    if (now - who.t10 >= 10000) {
      who.t10 = now;
      who.n10 = 0;
    }
    who.n1++;
    who.n10++;
    let wait = 0;
    if (who.n1 > CHAT.perSecond) wait = 1;
    if (who.n10 > CHAT.perTenSeconds) wait = Math.max(wait, Math.ceil((who.t10 + 10000 - now) / 1000));
    if (wait) who.strikes++;
    ws.serializeAttachment(who);
    return wait;
  }

  async webSocketMessage(ws, message) {
    const started = clock();
    const who = ws.deserializeAttachment() || { name: "", ip: "", t1: 0, n1: 0, t10: 0, n10: 0, strikes: 0 };
    const wait = this.throttle(ws, who, started);
    if (wait) {
      if (who.strikes >= CHAT.strikes) {
        ws.close(4008, "slow down");
        return;
      }
      ws.send(
        JSON.stringify({
          type: "error",
          code: "rate_limited",
          error: "slow down: " + CHAT.perSecond + " messages a second, " + CHAT.perTenSeconds + " every 10 s",
          retry_after: wait,
        }),
      );
      return;
    }
    const raw = String(message);
    // A string is never longer in UTF-16 units than in UTF-8 bytes, so the cheap test goes first and the
    // exact count only runs on a frame that already fits in units.
    if (raw.length > CHAT.frame || utf8Bytes(raw) > CHAT.frame) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "too_large",
          error: "that frame is too large: " + CHAT.frame + " bytes at most",
        }),
      );
      return;
    }
    let frame = null;
    try {
      frame = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "bad_frame", error: "frames are JSON objects" }));
      return;
    }
    if (!isObject(frame)) {
      ws.send(JSON.stringify({ type: "error", code: "bad_frame", error: "frames are JSON objects" }));
      return;
    }
    if (frame.type === "hello") {
      const name = tidy(isText(frame.name) ? frame.name : "");
      who.name = name.length > 0 && name.length <= CHAT.name ? name : "guest";
      ws.serializeAttachment(who);
      this.broadcast(this.presence());
      return;
    }
    if (frame.type !== "msg") return;
    if (!isText(frame.text)) {
      ws.send(JSON.stringify({ type: "error", code: "bad_frame", error: "text must be a string" }));
      return;
    }
    const text = tidy(frame.text, true);
    if (!text) return;
    if (points(text) > CHAT.text) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "too_long",
          error: "that message is too long: " + CHAT.text + " characters at most",
        }),
      );
      return;
    }
    const entry = { name: who.name || "guest", text, at: Date.now() };
    const history = (await this.ctx.storage.get("history")) || [];
    history.push(entry);
    while (history.length > HISTORY) history.shift();
    // One stored value holds the whole history; keep it well under the 128 KiB value limit
    // (30 messages of 1,000 four-byte characters would come close), dropping the oldest first.
    while (history.length > 1 && new TextEncoder().encode(JSON.stringify(history)).length > HISTORY_BYTES) {
      history.shift();
    }
    await this.ctx.storage.put("history", history);
    // `sent` is the client's own clock value, echoed so it can time the round trip.
    // Only a plain number goes out: the field reaches every client in the room.
    const sent = isNumber(frame.sent) ? frame.sent : 0;
    this.broadcast({
      type: "msg",
      name: entry.name,
      text,
      at: entry.at,
      sent,
      ms: clock() - started,
    });
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {}
    this.broadcast(this.presence());
  }
}
// #endregion

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "content-type": "application/json" } });
}

// What a parsed JSON value is, tested without typeof: a string is its own String(), a
// number its own Number() and finite, and an object is a non-array that is its own Object().
function isText(v) {
  return String(v) === v;
}
function isNumber(v) {
  return Number(v) === v && isFinite(v);
}
function isObject(v) {
  return v !== null && Object(v) === v && !Array.isArray(v);
}

// A whole number from a query string, or null.
function whole(text) {
  const n = Number(text);
  return text !== null && text !== "" && n >= 0 && n === Math.floor(n) && n <= 9007199254740991 ? n : null;
}

function isHex(text, length) {
  if (text.length !== length) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

// A refusal with a JSON body: the one error shape every route uses.
function refusal(status, message, extra) {
  const body = { error: message };
  if (extra) for (const k of Object.keys(extra)) body[k] = extra[k];
  return json(body, status);
}

// ---------------------------------------------------------------------------
// The app is public, so strangers use it. Everything below keeps that boring:
// limits on every input, a per-address rate limit on every route that writes, and
// a reset of the demo data once a day.
// ---------------------------------------------------------------------------

const DAILY_RESET = "0 4 * * *";
// Every 15 minutes: delete the files whose hour is up, and the chunks of uploads nobody finished.
const FILE_SWEEP = "*/15 * * * *";
// The daily reset runs at 04:00 UTC, and a day of upload allowance is the same 24 hours, so the
// reset (which empties the quota table) never hands anyone a second allowance inside one day.
const DAY_STARTS = 4 * 3600000;
const MAX_FILE_NAME = 64;
const MAX_FILES = 50;
const MAX_JSON_BODY = 4096;
// A file is stored as R2 objects of CHUNK bytes. Each upload request carries one chunk and each
// download pull reads one, so neither a request nor the worker ever holds a whole file: the
// worker stays flat at a few MB whatever the file size. (Sproutd gives an app 32 MiB, and its
// R2 get() reads a whole object into memory.) A request body over 1 MiB is also refused
// outright before compatibility date 2026-10-27, so a chunk is exactly 1 MiB.
const CHUNK = 1048576;
const HOUR = 3600000;
const DAY = 86400000;

// Text a person typed, made safe to store and show: control characters become
// spaces, bidirectional overrides (which can make a name read as something else)
// and unpaired surrogates (which are not text) are dropped, runs of spaces
// collapse, and the ends are trimmed. With `lines` a line break is kept (a run of them becomes at
// most one blank line); without it a break is a space, as in a name.
function joint(gap, breaks) {
  return breaks > 1 ? "\n\n" : breaks === 1 ? "\n" : gap ? " " : "";
}
function tidy(input, lines) {
  let out = "";
  let gap = false;
  let breaks = 0;
  const text = String(input);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        if (out) out += joint(gap, breaks);
        gap = false;
        breaks = 0;
        out += text[i] + text[i + 1];
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) continue;
    if (lines && (c === 10 || c === 0x2028 || c === 0x2029)) {
      breaks++;
      continue;
    }
    if (c <= 32 || (c >= 127 && c <= 160) || c === 0x2028 || c === 0x2029) {
      gap = true;
      continue;
    }
    if (out) out += joint(gap, breaks);
    gap = false;
    breaks = 0;
    out += text[i];
  }
  return out;
}

// Characters in tidy text, a surrogate pair counting once (tidy leaves only whole pairs).
function points(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++;
  }
  return n;
}

// Bytes the text takes in UTF-8, as a WebSocket frame carries it (a lone surrogate counts as the three
// bytes of U+FFFD).
function utf8Bytes(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// One field of a JSON body: text, within a limit. Returns { value } or { error }.
function textField(input, key, label, max, required) {
  const raw = input[key];
  if (raw === undefined || raw === null || raw === "") {
    return required ? { error: label + " is required" } : { value: "" };
  }
  if (!isText(raw)) return { error: label + " must be text" };
  const value = tidy(raw);
  if (!value) return required ? { error: label + " is required" } : { value: "" };
  if (value.length > max) {
    return { error: label + " is too long: at most " + max + " characters, this has " + value.length };
  }
  return { value: value };
}

// The request body as a small JSON object: { value } or { error, status }.
async function readJson(request, max) {
  let text = "";
  try {
    text = request.body ? await request.text() : "";
  } catch {
    return { error: "the body could not be read", status: 400 };
  }
  if (text.length > max) return { error: "the body is too large: " + max + " characters at most", status: 413 };
  if (!text) return { value: {} };
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "the body is not valid JSON", status: 400 };
  }
  if (!isObject(value)) {
    return { error: "the body must be a JSON object", status: 400 };
  }
  return { value: value };
}

// ---- who is calling --------------------------------------------------------
// On Sproutboat Cloud the app sits behind Caddy, which sets X-Forwarded-For
// (Caddy replaces what a client sent, so the last entry is the address it saw).
// request.cf.clientIp is the TCP peer, so behind that proxy it is the proxy's own
// loopback or private address, and is no use as a key. Rule: a public peer is the
// client; a private peer is a proxy, so take the last X-Forwarded-For entry; with
// neither, every caller shares one key and the limits act as a global cap.
function privateAddress(ip) {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  if (lower.indexOf(":") >= 0) {
    if (lower.indexOf("::ffff:") === 0) return privateAddress(lower.slice(7));
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.indexOf("fc") === 0 ||
      lower.indexOf("fd") === 0 ||
      lower.indexOf("fe80") === 0
    );
  }
  const p = lower.split(".");
  const a = Number(p[0]);
  const b = Number(p[1]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// An IPv6 client owns a whole /64, so the key is its first four groups.
function addressKey(ip) {
  if (ip.indexOf(":") < 0) return ip;
  const halves = ip.toLowerCase().split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = head;
  if (halves.length > 1) {
    for (let i = head.length + tail.length; i < 8; i++) groups.push("0");
    for (const g of tail) groups.push(g);
  }
  return groups.slice(0, 4).join(":") + "::/64";
}

function validAddress(text) {
  if (!text || text.length > 45) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ok = (c >= 48 && c <= 58) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70) || c === 46;
    if (!ok) return false;
  }
  return true;
}

// { ip, known, via }: known is false when no usable address arrived.
function clientIp(request) {
  const peer = (request.cf && request.cf.clientIp) || "";
  if (peer && !privateAddress(peer)) return { ip: addressKey(peer), known: true, via: "peer" };
  const fwd = request.headers.get("x-forwarded-for") || "";
  if (fwd) {
    const parts = fwd.split(",");
    const last = parts[parts.length - 1].trim();
    if (validAddress(last)) return { ip: addressKey(last), known: true, via: "x-forwarded-for" };
  }
  return { ip: "shared", known: false, via: peer ? "peer-private" : "none" };
}

// ---- rate limits -----------------------------------------------------------
// WRITES (30 a minute) covers every route that changes something or calls out;
// BULK (6 a minute) adds to the ones that store files; READS (240 a minute) covers
// the dashboard's GET routes; THROTTLE (3 a minute) guards the secret check and
// failed admin tokens. Each is a budget per client address. Pages and assets are
// not limited.
function limited(retry, t0) {
  const body = {
    error: "slow down: too many requests from your address. Try again in " + retry + " s.",
    code: "rate_limited",
    retry_after: retry,
  };
  const headers = { "content-type": "application/json", "retry-after": String(retry), "cache-control": "no-store" };
  if (t0 !== undefined) {
    body.ms = Date.now() - t0;
    headers["server-timing"] = "app;dur=" + body.ms;
  }
  return new Response(JSON.stringify(body), { status: 429, headers: headers });
}

// null when the call may go ahead, else the 429 to send back.
async function gate(limiter, prefix, request, t0) {
  if (!limiter) return null;
  const r = await limiter.limit({ key: prefix + clientIp(request).ip });
  if (r.success) return null;
  let retry = Math.ceil((Number(r.resetAt) - Date.now()) / 1000);
  if (!(retry >= 1)) retry = 1;
  if (retry > 60) retry = 60;
  return limited(retry, t0);
}

// ---- bucket capacity ---------------------------------------------------------
// The demo bucket is small on purpose: MAX_FILES files and MAX_TOTAL_BYTES in all.
function totalCap(env) {
  return Number(env.MAX_TOTAL_BYTES) || 209715200;
}

function uploadCap(env) {
  return Number(env.MAX_UPLOAD_BYTES) || 26214400;
}

// The most bytes one response sends. Every chunk a response reads costs about seven times its size in
// worker memory, and none of it is collected until the response ends (measured: a 10 MB download
// peaks at 85 MB, a 1 MiB range at 14 MB), so a response is a bounded window of the file and a bigger
// file is read with Range requests: browsers do that for video, audio and PDF, and the page does it
// for a download. Sproutd gives an app 32 MiB, which is about 2 MiB of response. Raise
// MAX_RESPONSE_BYTES only where memory is not capped (a standalone binary, an app given more).
function responseCap(env) {
  return Number(env.MAX_RESPONSE_BYTES) || 2097152;
}

// Bytes one address may move in an hour: up (what it uploads) and down (what it downloads).
function hourlyCap(env, kind) {
  return kind === "up" ? Number(env.MAX_UPLOAD_PER_HOUR) || 104857600 : Number(env.MAX_DOWNLOAD_PER_HOUR) || 262144000;
}

// Bytes one address may upload in a day (04:00 UTC to 04:00 UTC).
function dailyCap(env) {
  return Number(env.MAX_UPLOAD_PER_DAY) || 104857600;
}

// How long an uploaded file lives, in milliseconds.
function fileTtl(env) {
  const seconds = Number(env.FILE_TTL_SECONDS);
  return (seconds > 0 ? seconds : 3600) * 1000;
}

// Which allowance day a moment falls in, and when that day ends.
function allowanceDay(now) {
  return Math.floor((now - DAY_STARTS) / DAY);
}

// How a refusal says when the allowance comes back.
function waitText(seconds) {
  return seconds >= 5400 ? Math.ceil(seconds / 3600) + " h" : Math.ceil(seconds / 60) + " min";
}

// Spend bytes from the address's allowance (rows in D1, bumped in one statement). An upload is
// charged to the hour and to the day; a download to the hour. null when there is room in every
// window, else the 429 to send: which window, how much, and when it turns over.
async function spendBytes(env, request, kind, bytes, t0) {
  const now = Date.now();
  const who = clientIp(request).ip;
  const hour = Math.floor(now / HOUR);
  const windows = [
    {
      name: "hour",
      key: kind + ":" + who + ":" + hour,
      limit: hourlyCap(env, kind),
      ends: (hour + 1) * HOUR,
      keep: (hour + 2) * HOUR,
    },
  ];
  if (kind === "up") {
    const day = allowanceDay(now);
    windows.push({
      name: "day",
      key: "upday:" + who + ":" + day,
      limit: dailyCap(env),
      ends: (day + 1) * DAY + DAY_STARTS,
      keep: (day + 2) * DAY + DAY_STARTS,
    });
  }
  const used = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const row = await env.DB.prepare("SELECT bytes FROM quota WHERE key = ?").bind(w.key).first();
    used.push(row ? Number(row.bytes) : 0);
    if (used[i] + bytes > w.limit) {
      let retry = Math.ceil((w.ends - now) / 1000);
      if (!(retry >= 1)) retry = 1;
      const body = {
        error:
          "slow down: " +
          (kind === "up" ? "uploads" : "downloads") +
          " are limited to " +
          fmtKb(w.limit) +
          (w.name === "day" ? " a day" : " an hour") +
          " from your address. Try again in " +
          waitText(retry) +
          ".",
        code: "quota",
        window: w.name,
        retry_after: retry,
        limit: w.limit,
        used: used[i],
      };
      if (t0 !== undefined) body.ms = Date.now() - t0;
      return new Response(JSON.stringify(body), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(retry), "cache-control": "no-store" },
      });
    }
  }
  for (let i = 0; i < windows.length; i++) {
    await env.DB.prepare(
      "INSERT INTO quota (key, bytes, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET bytes = bytes + excluded.bytes",
    )
      .bind(windows[i].key, bytes, windows[i].keep)
      .run();
  }
  return null;
}

// What the bucket holds now, the whole bucket: the dashboard's files, note
// attachments and direct uploads count alike.
async function bucketUsage(env, replacing) {
  const listed = await env.UPLOADS.list({ limit: 1000 });
  let bytes = 0;
  let files = 0;
  let replaced = 0;
  let exists = false;
  for (const o of listed.objects) {
    bytes += o.size;
    if (o.key.indexOf("files/") === 0) files++;
    if (replacing && o.key === replacing) {
      replaced = o.size;
      exists = true;
    }
  }
  return { bytes: bytes, files: files, replaced: replaced, exists: exists, truncated: listed.truncated };
}

function fmtKb(n) {
  return n < 1048576 ? Math.round(n / 1024) + " KB" : Math.round((n / 1048576) * 10) / 10 + " MB";
}

// The tables are created once per process, by the first request or trigger that needs them, not on every request.
let schema;
async function ensureSchema(env) {
  schema ??= env.DB.exec(
    "CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, msg TEXT, at TEXT);" +
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, label TEXT, ms REAL, at TEXT);" +
      "CREATE TABLE IF NOT EXISTS quota (key TEXT PRIMARY KEY, bytes INTEGER, expires INTEGER)",
  );
  try {
    await schema;
  } catch (error) {
    schema = undefined; // a failed attempt is not cached
    throw error;
  }
}

// The names of the keys in the namespace: list() answers { keys: [{ name }], list_complete, cursor }.
async function kvKeys(env) {
  const { keys } = await env.SESSIONS.list();
  return keys.map((key) => key.name);
}

// ---------------------------------------------------------------------------
// Dashboard API (/api/*). Every reply carries how long the handler ran, measured
// here with clock(), in the body (`ms`) and in a Server-Timing header.
// ---------------------------------------------------------------------------

// #region timing
// Millisecond clock: Date.now(), so timings are whole milliseconds. Do not reach for
// performance.now() here: a free reference to `performance` (like process, Buffer,
// setImmediate or MessageChannel) makes the compiler add an import of node:perf_hooks
// to the program's shared part, and a Cloud build against the shared generation is
// then refused with abi_rejected.
function clock() {
  return Date.now();
}

const ms2 = (t0) => Math.round((clock() - t0) * 100) / 100;
// #endregion

function timed(data, status, t0) {
  const ms = ms2(t0);
  data.ms = ms;
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "server-timing": "app;dur=" + ms, "cache-control": "no-store" },
  });
}

// KV values are strings. A counter written like this is not atomic: two requests
// can read the same number. Use a Durable Object when the count has to be exact.
// #region kv
async function kvIncrement(env) {
  const ops = [];
  let t = clock();
  const before = Number((await env.SESSIONS.get("counter:home")) || 0);
  ops.push({ op: "GET", value: before, ms: ms2(t) });
  t = clock();
  await env.SESSIONS.put("counter:home", String(before + 1));
  ops.push({ op: "PUT", value: before + 1, ms: ms2(t) });
  return { n: before + 1, ops };
}
// #endregion

// #region d1
async function guestbookSign(env, name, msg) {
  const statements = [];
  const at = new Date().toISOString();
  const insert = "INSERT INTO guestbook (name, msg, at) VALUES (?, ?, ?)";
  let t = clock();
  await env.DB.prepare(insert).bind(name, msg, at).run();
  statements.push({ sql: insert, binds: [name, msg, at], ms: ms2(t) });
  // The demo keeps the newest 200 rows.
  const trim = "DELETE FROM guestbook WHERE id <= (SELECT max(id) FROM guestbook) - 200";
  t = clock();
  await env.DB.prepare(trim).run();
  statements.push({ sql: trim, binds: [], ms: ms2(t) });
  return statements;
}

async function guestbookList(env) {
  const sql = "SELECT id, name, msg, at FROM guestbook ORDER BY id DESC LIMIT 5";
  const t = clock();
  const res = await env.DB.prepare(sql).all();
  return { rows: res.results, statement: { sql, binds: [], ms: ms2(t), rows_read: res.meta.rows_read } };
}
// #endregion

// #region r2
// A file is a manifest object, files/<name>, with no body: its size, type, chunk count and upload id are
// custom metadata. Its bytes are CHUNK-sized objects, chunks/<id>/000000, 000001 and so on. An
// upload sends one chunk per request, and the last one writes the manifest; a download streams
// the chunks one pull at a time. Any file goes in, as bytes, with the content type the browser
// gave it, and comes back with that type. Only pictures, audio and video are shown in the browser;
// every other type, PDF, text, SVG and HTML included, is an attachment, so an upload cannot run script
// on this origin and the page is no host for documents. A file lives FILE_TTL_SECONDS (an hour) after
// its upload: then it is not served and is deleted, so the demo is no free file hosting.
const SHOWN_INLINE = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
];

// type/subtype in lower case, no parameters, or application/octet-stream when it is not one.
function cleanType(raw) {
  const head = String(raw || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const parts = head.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || head.length > 100) return "application/octet-stream";
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || "!#$&^_.+-/".indexOf(head[i]) >= 0;
    if (!ok) return "application/octet-stream";
  }
  return head;
}

function chunkKey(id, n) {
  return "chunks/" + id + "/" + String(1000000 + n).slice(1);
}

// What a manifest says about its file; a plain object stored under files/ is a one-chunk-less file (id "").
// `expires` is when the upload finished plus the file's hour, in epoch milliseconds, written into the manifest;
// a manifest without one (not made by this upload route) has none and counts as expired.
function describe(key, o) {
  const m = o.customMetadata || {};
  return {
    name: key.slice(6),
    size: m.size === undefined ? o.size : Number(m.size),
    type: cleanType(m.type || (o.httpMetadata && o.httpMetadata.contentType)),
    id: m.id || "",
    count: Number(m.count) || 0,
    etag: m.id || o.httpEtag,
    expires: Number(m.expires) || 0,
  };
}

// The files whose hour is up, deleted: manifest and chunks. Called by the */15 cron, by every listing
// of the files and before an upload starts, so an expired file is gone soon after its hour whoever
// looks. `now` is passed in so a cron run can say what time it is.
async function purgeExpired(env, now) {
  const listed = await env.UPLOADS.list({ prefix: "files/", limit: 1000, include: ["httpMetadata", "customMetadata"] });
  let purged = 0;
  for (const o of listed.objects) {
    const d = describe(o.key, o);
    if (d.expires > now) continue;
    await removeFile(env, d);
    purged++;
  }
  return purged;
}

async function filesList(env) {
  const now = Date.now();
  const listed = await env.UPLOADS.list({ prefix: "files/", limit: 100, include: ["httpMetadata", "customMetadata"] });
  let bytes = 0;
  const objects = [];
  for (const o of listed.objects) {
    const d = describe(o.key, o);
    if (d.expires <= now) {
      await removeFile(env, d);
      continue;
    }
    bytes += d.size;
    objects.push({ name: d.name, size: d.size, type: d.type, uploaded: o.uploaded, etag: d.etag, expires: d.expires });
  }
  return { objects, bytes, truncated: listed.truncated, now: now };
}

// null for a file that is not there or whose hour is up (and an expired one is deleted on the spot).
async function fileInfo(env, name) {
  const head = await env.UPLOADS.head("files/" + name);
  if (!head) return null;
  const d = describe("files/" + name, head);
  if (d.expires <= Date.now()) {
    await removeFile(env, d);
    return null;
  }
  return d;
}

async function removeFile(env, info) {
  const keys = ["files/" + info.name];
  for (let n = 0; n < info.count; n++) keys.push(chunkKey(info.id, n));
  await env.UPLOADS.delete(keys);
}

// Store one chunk of an upload, or say why not. Chunk 0 checks that the file fits (its size,
// the 50-file and total caps, the hour's upload allowance) before any more bytes are sent; the
// last chunk checks all the chunks are there and writes the manifest.
async function chunkPut(env, request, up, bytes, t0) {
  const key = chunkKey(up.id, up.n);
  if (up.n === 0) {
    // Files whose hour is up make room first, so they do not count against the caps.
    await purgeExpired(env, Date.now());
    // Replacing a file frees the old one's bytes, so they do not count against the new one.
    const old = await fileInfo(env, up.name);
    const used = await bucketUsage(env, "");
    if (!old && used.files >= MAX_FILES) {
      return { status: 409, error: "the demo bucket holds " + MAX_FILES + " files; delete one first" };
    }
    if (used.truncated || used.bytes - (old ? old.size : 0) + up.total > totalCap(env)) {
      return {
        status: 409,
        error:
          "the demo bucket is full: " +
          fmtKb(used.bytes) +
          " of " +
          fmtKb(totalCap(env)) +
          " stored; delete a file first",
      };
    }
    const spent = await spendBytes(env, request, "up", up.total, t0);
    if (spent) return { response: spent };
  } else {
    const first = await env.UPLOADS.head(chunkKey(up.id, 0));
    const m = first && first.customMetadata ? first.customMetadata : {};
    if (!first || m.total !== String(up.total) || m.name !== up.name) {
      return { status: 409, error: "start the upload with chunk 0" };
    }
  }
  await env.UPLOADS.put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { total: String(up.total), name: up.name, t: String(Date.now()) },
  });
  if (up.n < up.count - 1) return null;
  // The last chunk: all of them must be there, and add up.
  const listed = await env.UPLOADS.list({ prefix: "chunks/" + up.id + "/", limit: 1000 });
  let sum = 0;
  for (const o of listed.objects) sum += o.size;
  if (listed.objects.length !== up.count || sum !== up.total) {
    return { status: 409, error: "the upload is missing chunks; start it again" };
  }
  const old = await fileInfo(env, up.name);
  await env.UPLOADS.put("files/" + up.name, "", {
    httpMetadata: { contentType: up.type },
    customMetadata: {
      id: up.id,
      size: String(up.total),
      count: String(up.count),
      type: up.type,
      expires: String(Date.now() + fileTtl(env)),
    },
  });
  if (old && old.id && old.id !== up.id) await env.UPLOADS.delete(chunkKeys(old.id, old.count));
  return null;
}

function chunkKeys(id, count) {
  const keys = [];
  for (let n = 0; n < count; n++) keys.push(chunkKey(id, n));
  return keys;
}

// Uploads that were started and never finished leave chunks with no manifest. Called from the
// */15 cron: chunks over an hour old whose upload has no manifest are deleted.
async function sweepChunks(env) {
  const listed = await env.UPLOADS.list({ prefix: "chunks/", limit: 1000, include: ["customMetadata"] });
  if (!listed.objects.length) return;
  const manifests = await env.UPLOADS.list({ prefix: "files/", limit: 1000, include: ["customMetadata"] });
  const live = {};
  for (const o of manifests.objects) if (o.customMetadata && o.customMetadata.id) live[o.customMetadata.id] = true;
  const stale = [];
  for (const o of listed.objects) {
    const id = o.key.split("/")[1];
    const t = Number(o.customMetadata && o.customMetadata.t) || 0;
    if (!live[id] && Date.now() - t > HOUR) stale.push(o.key);
  }
  if (stale.length) await env.UPLOADS.delete(stale);
}

// "bytes=a-b", "bytes=a-" and "bytes=-n" for a file of size bytes. null when there is no usable
// single range (the whole file is sent), { bad: true } when it is outside the file (416).
function parseRange(header, size) {
  const h = String(header || "").trim();
  if (h.indexOf("bytes=") !== 0 || h.indexOf(",") >= 0) return null;
  const parts = h.slice(6).split("-");
  if (parts.length !== 2) return null;
  const left = parts[0].trim();
  const right = parts[1].trim();
  if (!left && !right) return null;
  let start = 0;
  let end = size - 1;
  if (!left) {
    const n = Number(right);
    if (!(n > 0)) return { bad: true };
    start = Math.max(0, size - n);
  } else {
    start = Number(left);
    if (!(start >= 0) || start !== Math.floor(start)) return null;
    if (right) {
      end = Number(right);
      if (!(end >= 0) || end !== Math.floor(end) || end < start) return null;
      end = Math.min(end, size - 1);
    }
    if (start >= size) return { bad: true };
  }
  return { start: start, end: end };
}

// The bytes start..end of a file, one chunk per pull: a slow reader holds back the next read, and
// nothing but the chunk in hand is in memory.
function chunkStream(env, info, start, end) {
  let at = start;
  return new ReadableStream({
    async pull(controller) {
      if (at > end) {
        controller.close();
        return;
      }
      const n = Math.floor(at / CHUNK);
      const obj = await env.UPLOADS.get(chunkKey(info.id, n));
      if (!obj) {
        controller.error(new Error("a chunk of the file is missing"));
        return;
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const from = at - n * CHUNK;
      const to = Math.min(bytes.length, end - n * CHUNK + 1);
      controller.enqueue(from === 0 && to === bytes.length ? bytes : bytes.subarray(from, to));
      at = n * CHUNK + to;
    },
  });
}

// A stored file as a response: its own type, never sniffed, shown only if it is safe to show,
// with Range support so a video seeks and a large image loads. The hour's download allowance is
// charged by what is sent.
async function fileResponse(env, request, info, download, t0) {
  const inline = !download && SHOWN_INLINE.indexOf(info.type) >= 0;
  // Everything but a picture, audio or video is an attachment, whatever the URL asks for.
  const headers = {
    "content-type": info.type === "text/plain" ? "text/plain; charset=utf-8" : info.type,
    "content-disposition": (inline ? "inline" : "attachment") + '; filename="' + info.name + '"',
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    etag: '"' + info.etag + '"',
    // A file may be cached for what is left of its hour, never longer.
    "cache-control": "private, max-age=" + Math.max(0, Math.min(3600, Math.floor((info.expires - Date.now()) / 1000))),
    "server-timing": "app;dur=" + ms2(t0),
  };
  // Nothing in a stored file may run or load anything here. (The PDF viewer needs to run, so a PDF is the exception.)
  // Opened directly, a video or audio file plays in a document the browser makes around it, under this
  // policy. `sandbox` gives that document an opaque origin, and then the player cannot load the file at
  // all (no duration, nothing plays), so media gets `media-src 'self'` without `sandbox`. A video/audio
  // type with nosniff never runs as a page, so nothing is lost.
  const media = info.type.startsWith("video/") || info.type.startsWith("audio/");
  if (media) headers["content-security-policy"] = "default-src 'none'; media-src 'self'";
  else if (info.type !== "application/pdf") headers["content-security-policy"] = "default-src 'none'; sandbox";
  // A Range is honoured unless If-Range names another version of the file.
  const ifRange = request.headers.get("if-range");
  const range = ifRange && ifRange !== headers.etag ? null : parseRange(request.headers.get("range"), info.size);
  if (range && range.bad) {
    headers["content-range"] = "bytes */" + info.size;
    return new Response(null, { status: 416, headers: headers });
  }
  const most = responseCap(env);
  if (!range && info.size > most && request.method !== "HEAD") {
    // A plain GET of a file bigger than one response: say how to read it rather than run out of memory.
    return new Response(
      JSON.stringify({
        error:
          "this file is " +
          fmtKb(info.size) +
          ", more than one response sends (" +
          fmtKb(most) +
          "): read it with Range requests, as a browser does for video, or download it from the dashboard",
        code: "range_required",
        size: info.size,
        window: most,
      }),
      {
        status: 413,
        headers: { "content-type": "application/json", "accept-ranges": "bytes", "cache-control": "no-store" },
      },
    );
  }
  const start = range ? range.start : 0;
  // A range longer than a response is cut short; the Content-Range says how much came.
  const end = range ? Math.min(range.end, start + most - 1) : info.size - 1;
  const length = info.size === 0 ? 0 : end - start + 1;
  headers["content-length"] = String(length);
  if (range) headers["content-range"] = "bytes " + start + "-" + end + "/" + info.size;
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status: status, headers: headers });
  const stop = await spendBytes(env, request, "down", length, t0);
  if (stop) return stop;
  if (!info.id) {
    // A plain object under files/, not made by the chunked upload.
    const obj = await env.UPLOADS.get("files/" + info.name);
    return new Response(obj ? await obj.arrayBuffer() : null, { status: status, headers: headers });
  }
  if (length === 0) return new Response(null, { status: status, headers: headers });
  return new Response(chunkStream(env, info, start, end), { status: status, headers: headers });
}
// #endregion

// #region queue
// The producer side. The consumer is the queue() handler at the bottom of this file.
async function jobEnqueue(env, label) {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('queued', ?, 0, ?)").bind(label, at).run();
  await env.EMAILS.send({ kind: "job", label, sent: Date.now() });
}

async function feed(env) {
  const counts = await env.DB.prepare(
    "SELECT sum(kind = 'queued') AS queued, sum(kind = 'processed') AS processed, sum(kind = 'cron') AS crons FROM events",
  ).first();
  const recent = await env.DB.prepare(
    "SELECT kind, label, ms, at FROM events WHERE kind IN ('processed', 'cron') ORDER BY id DESC LIMIT 5",
  ).all();
  return { counts, recent: recent.results };
}
// #endregion

// #region service
async function quote(env) {
  const res = await env.PEER.fetch(new Request("https://peer/random"));
  if (res.status !== 200) throw new Error("quote-service answered " + res.status);
  return JSON.parse(await res.text());
}
// #endregion

// #region secrets
// Report whether each declared secret has a value. Reading a missing secret can
// throw, so that counts as unset. The value itself never leaves this function.
function secretStatus(env, names) {
  const out = [];
  for (const name of names) {
    let set = false;
    try {
      const value = env[name];
      set = !!value && String(value).length > 0;
    } catch {}
    out.push({ name, set });
  }
  return out;
}
// #endregion

const DECLARED_SECRETS = ["ADMIN_TOKEN"];

// The name a file is stored under: letters, digits, dot, dash and underscore stay, anything else becomes an underscore.
function cleanFileName(raw) {
  let out = "";
  const text = String(raw || "").trim();
  for (let i = 0; i < text.length && out.length < MAX_FILE_NAME; i++) {
    const code = text.charCodeAt(i);
    const ok =
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      code === 46 ||
      code === 45 ||
      code === 95;
    out += ok ? text[i] : "_";
  }
  return out;
}

async function trimEvents(env) {
  await env.DB.prepare("DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - 200").run();
}

// The guestbook the daily reset goes back to.
const SEED = [
  ["sproutboat", "Demo data resets daily at 04:00 UTC."],
  ["Ada", "Hello from the guestbook."],
  ["Grace", "Signed from D1."],
];

// The daily reset, run by scheduled() for the "0 4 * * *" cron. Everything a visitor
// can add goes: every R2 object, every KV key (the counter), the
// guestbook (back to SEED), the events feed, the allowances, and the chat history.
async function dailyReset(env, event) {
  const started = clock();
  // Each part runs on its own: one that fails is logged and does not keep the others from running.
  const parts = [
    async () => {
      for (let page = 0; page < 20; page++) {
        const listed = await env.UPLOADS.list({ limit: 100 });
        if (!listed.objects.length) break;
        for (const o of listed.objects) await env.UPLOADS.delete(o.key);
      }
    },
    async () => {
      const keys = await kvKeys(env);
      for (let i = 0; i < keys.length; i++) await env.SESSIONS.delete(keys[i]);
    },
    async () => {
      for (const table of ["guestbook", "events", "quota"]) {
        await env.DB.prepare("DELETE FROM " + table).run();
      }
      const at = new Date().toISOString();
      for (let i = 0; i < SEED.length; i++) {
        await env.DB.prepare("INSERT INTO guestbook (name, msg, at) VALUES (?, ?, ?)")
          .bind(SEED[i][0], SEED[i][1], at)
          .run();
      }
    },
    async () => {
      await env.ROOM.get(env.ROOM.idFromName("main")).fetch("https://room/reset", { method: "POST" });
    },
  ];
  let failed = 0;
  for (let i = 0; i < parts.length; i++) {
    try {
      await parts[i]();
    } catch (e) {
      failed++;
      console.log("daily reset, part " + i + " failed: " + String((e && e.message) || e));
    }
  }
  await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('cron', ?, ?, ?)")
    .bind(event.cron, ms2(started), new Date().toISOString())
    .run();
  return failed;
}

async function api(request, env, url, path, t0) {
  const method = request.method;
  const mutating = method !== "GET" && method !== "HEAD";

  // Rate limits come first, before any work and before a body is read. Writes and
  // the quote call (an outbound request) share one budget per address; reads have a
  // looser one; the secret check has its own, below.
  let slow = null;
  if (path === "/api/chat") slow = await gate(env.WRITES, "ws:", request, t0);
  else if (path === "/api/secrets/check") slow = null;
  else if (path === "/api/r2/chunk") slow = null; // BULK and the hour's byte allowance, below
  else if (mutating || path === "/api/quote") slow = await gate(env.WRITES, "w:", request, t0);
  else slow = await gate(env.READS, "r:", request, t0);
  if (slow) return slow;

  if (path === "/api/info" && method === "GET") {
    let requests = null;
    try {
      requests = (await env.METRICS.query({ limit: 1 })).count;
    } catch {}
    return timed(
      {
        site: env.SITE_NAME,
        requests,
        // What this build has. A standalone binary has no edge, so no service binding.
        bindings: {
          kv: !!env.SESSIONS,
          d1: !!env.DB,
          r2: !!env.UPLOADS,
          queue: !!env.EMAILS,
          durable_object: !!env.ROOM,
          service: !!env.PEER,
        },
        max_upload_bytes: uploadCap(env),
        max_total_bytes: totalCap(env),
        chunk_bytes: CHUNK,
        max_response_bytes: responseCap(env),
        max_upload_per_hour: hourlyCap(env, "up"),
        max_upload_per_day: dailyCap(env),
        file_ttl_seconds: fileTtl(env) / 1000,
        max_download_per_hour: hourlyCap(env, "down"),
        max_files: MAX_FILES,
        // How the rate limits tell visitors apart: "peer", "x-forwarded-for", or
        // "none" / "peer-private" when no address arrived and all visitors share a key.
        client_key: clientIp(request).via,
      },
      200,
      t0,
    );
  }

  if (path === "/api/kv") {
    const n = Number((await env.SESSIONS.get("counter:home")) || 0);
    return timed({ n, keys: (await kvKeys(env)).length }, 200, t0);
  }
  if (path === "/api/kv/incr" && method === "POST") {
    const res = await kvIncrement(env);
    res.keys = (await kvKeys(env)).length;
    return timed(res, 200, t0);
  }

  if (path === "/api/guestbook" && method === "GET") {
    const list = await guestbookList(env);
    const total = await env.DB.prepare("SELECT count(*) AS n FROM guestbook").first("n");
    return timed({ rows: list.rows, total, sql: [list.statement] }, 200, t0);
  }
  if (path === "/api/guestbook" && method === "POST") {
    const body = await readJson(request, MAX_JSON_BODY);
    if (body.error) return timed({ error: body.error }, body.status, t0);
    const name = textField(body.value, "name", "name", 20, true);
    if (name.error) return timed({ error: name.error }, 400, t0);
    const msg = textField(body.value, "msg", "message", 60, true);
    if (msg.error) return timed({ error: msg.error }, 400, t0);
    const sql = await guestbookSign(env, name.value, msg.value);
    const list = await guestbookList(env);
    const total = await env.DB.prepare("SELECT count(*) AS n FROM guestbook").first("n");
    sql.push(list.statement);
    return timed({ rows: list.rows, total, sql }, 201, t0);
  }

  if (path === "/api/r2" && method === "GET") {
    return timed(await filesList(env), 200, t0);
  }
  // One chunk of an upload: PUT /api/r2/chunk?name=&id=&n=&count=&total=&type=, the body is the chunk.
  if (path === "/api/r2/chunk" && method === "PUT") {
    const heavy = await gate(env.BULK, "b:", request, t0);
    if (heavy) return heavy;
    const q = url.searchParams;
    const raw = String(q.get("name") || "").trim();
    if (!raw) return timed({ error: "a file name is required" }, 400, t0);
    if (raw.length > MAX_FILE_NAME) {
      return timed(
        { error: "the file name is too long: at most " + MAX_FILE_NAME + " characters, this has " + raw.length },
        400,
        t0,
      );
    }
    const name = cleanFileName(raw);
    if (name === "." || name === "..") return timed({ error: "that file name is not allowed" }, 400, t0);
    const id = String(q.get("id") || "");
    if (!isHex(id, 16)) return timed({ error: "id must be 16 hexadecimal characters" }, 400, t0);
    const total = whole(q.get("total"));
    const n = whole(q.get("n"));
    const count = whole(q.get("count"));
    if (total === null || n === null || count === null) {
      return timed({ error: "total, n and count are whole numbers" }, 400, t0);
    }
    if (total > uploadCap(env)) {
      return timed(
        { error: "too large: this build accepts " + fmtKb(uploadCap(env)) + " per file, this is " + fmtKb(total) },
        413,
        t0,
      );
    }
    if (count !== Math.max(1, Math.ceil(total / CHUNK)) || n >= count) {
      return timed({ error: "count and n do not fit total: chunks are " + CHUNK + " bytes" }, 400, t0);
    }
    const expected = n < count - 1 ? CHUNK : total - (count - 1) * CHUNK;
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > CHUNK) return timed({ error: "a chunk is at most " + CHUNK + " bytes" }, 413, t0);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== expected) {
      return timed({ error: "chunk " + n + " is " + expected + " bytes, this has " + bytes.byteLength }, 400, t0);
    }
    const up = { name: name, id: id, n: n, count: count, total: total, type: cleanType(q.get("type")) };
    const refused = await chunkPut(env, request, up, bytes, t0);
    if (refused && refused.response) return refused.response;
    if (refused) return timed({ error: refused.error }, refused.status, t0);
    const out = n === count - 1 ? await filesList(env) : { stored: n };
    out.name = name;
    return timed(out, n === count - 1 ? 201 : 200, t0);
  }
  if (path === "/api/r2" && method === "DELETE") {
    const name = cleanFileName(url.searchParams.get("name"));
    const info = name ? await fileInfo(env, name) : null;
    if (info) await removeFile(env, info);
    return timed(await filesList(env), 200, t0);
  }
  if (path === "/api/r2/file" && (method === "GET" || method === "HEAD")) {
    const name = cleanFileName(url.searchParams.get("name"));
    const info = name ? await fileInfo(env, name) : null;
    if (!info) return timed({ error: "not found" }, 404, t0);
    return fileResponse(env, request, info, url.searchParams.get("download") === "1", t0);
  }

  if (path === "/api/queue" && method === "GET") {
    const out = await feed(env);
    out.now = Date.now();
    return timed(out, 200, t0);
  }
  if (path === "/api/queue/enqueue" && method === "POST") {
    const body = await readJson(request, MAX_JSON_BODY);
    if (body.error) return timed({ error: body.error }, body.status, t0);
    const field = textField(body.value, "label", "label", 40, false);
    if (field.error) return timed({ error: field.error }, 400, t0);
    await jobEnqueue(env, field.value || "hello");
    const out = await feed(env);
    out.now = Date.now();
    return timed(out, 202, t0);
  }

  if (path === "/api/quote" && method === "GET") {
    if (!env.PEER) {
      return timed({ ok: false, reason: "no-binding", error: "this build has no service binding" }, 200, t0);
    }
    try {
      return timed({ ok: true, quote: await quote(env) }, 200, t0);
    } catch (e) {
      return timed({ ok: false, reason: "unreachable", error: String((e && e.message) || e) }, 200, t0);
    }
  }

  if (path === "/api/secrets" && method === "GET") {
    return timed({ secrets: secretStatus(env, DECLARED_SECRETS) }, 200, t0);
  }
  // Compare a typed value with env.ADMIN_TOKEN inside the worker. The answer is
  // yes or no; the secret is never sent back. env.THROTTLE (3 a minute per
  // address) slows guessing.
  if (path === "/api/secrets/check" && method === "POST") {
    const stop = await gate(env.THROTTLE, "secret-check:", request, t0);
    if (stop) return stop;
    const body = await readJson(request, 1024);
    if (body.error) return timed({ ok: false, error: body.error }, body.status, t0);
    const token = body.value.token;
    if (!isText(token) || !token) return timed({ ok: false, error: "token is required" }, 400, t0);
    if (token.length > 256) {
      return timed(
        { ok: false, error: "token is too long: at most 256 characters, this has " + token.length },
        400,
        t0,
      );
    }
    let ok = false;
    try {
      ok = !!env.ADMIN_TOKEN && token === String(env.ADMIN_TOKEN);
    } catch {}
    return timed({ ok }, 200, t0);
  }

  // The chat socket: hand the upgrade to the one room object.
  if (path === "/api/chat") {
    // ?probe is the one plain GET the room answers: 503 (full), 429 (this address holds its five) or 426,
    // so a page whose socket did not open can tell a refusal that will pass from one that will not.
    if (request.headers.get("Upgrade") !== "websocket" && url.searchParams.get("probe") === null)
      return timed({ error: "expected a WebSocket upgrade" }, 426, t0);
    return env.ROOM.get(env.ROOM.idFromName("main")).fetch(request);
  }

  return timed({ error: "not found", path }, 404, t0);
}

// The routes the conformance suite and curl use, outside /api. Same rules as above.
// GET /healthz -> { ok: true } and nothing else: cheap enough to poll every minute. It answers from the
// worker alone, so a 200 says the app is up and serving; it does not read D1, KV or R2.
function healthz(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "use GET" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ ok: true, at: Date.now() }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    const t0 = clock();
    const url = new URL(request.url);
    const path = url.pathname;
    // An uptime monitor polls this: no bindings, no rate limit, no analytics point.
    if (path === "/healthz") return healthz(request);
    try {
      await ensureSchema(env);

      // analytics: one point per request
      env.METRICS.writeDataPoint({ blobs: [request.method, path], indexes: [path], doubles: [1] });

      // The dashboard's JSON API, handled in api() above.
      if (path.indexOf("/api/") === 0) return await api(request, env, url, path, t0);
      // Anything else GET is the page or one of its files (env.ASSETS); `run_sprout_first: true` sends every path here first.
      if (request.method === "GET") return await env.ASSETS.fetch(request);
      return json({ error: "not found", path }, 404);
    } catch (e) {
      // Whatever went wrong stays in the log; a visitor gets no internals.
      console.log("500 " + request.method + " " + path + ": " + String((e && e.message) || e));
      if (path.indexOf("/api/") === 0) return timed({ error: "internal error" }, 500, t0);
      return json({ error: "internal error" }, 500);
    }
  },

  // cron */1: record how long the run took. cron */15: delete expired files. cron 0 4 * * *: the daily reset.
  /**
   * @param {ScheduledController} controller
   * @param {Env} env
   */
  async scheduled(controller, env) {
    const started = clock();
    await ensureSchema(env);
    if (controller.cron === DAILY_RESET) {
      await dailyReset(env, controller);
      return;
    }
    if (controller.cron === FILE_SWEEP) {
      // Expired files and abandoned chunks, nothing else: the scheduledTime is the clock.
      await purgeExpired(env, Number(controller.scheduledTime) || Date.now());
      await sweepChunks(env);
      return;
    }
    // Spent allowances of hours and days gone by.
    await env.DB.prepare("DELETE FROM quota WHERE expires < ?").bind(Date.now()).run();
    // The dashboard's feed reads this row: how long the run took.
    await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('cron', ?, ?, ?)")
      .bind(controller.cron, ms2(started), new Date().toISOString())
      .run();
    await trimEvents(env);
  },

  // queue consumer for EMAILS: a job from the dashboard records how long it waited in the queue (ms between send
  // and delivery) next to the work itself, as an event the feed reads back.
  /**
   * @param {MessageBatch} batch
   * @param {Env} env
   */
  async queue(batch, env) {
    await ensureSchema(env);
    for (const message of batch.messages) {
      const started = clock();
      const job = message.body;
      if (job && job.kind === "job") {
        const waited = Math.max(0, Date.now() - Number(job.sent || 0));
        await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('processed', ?, ?, ?)")
          .bind(String(job.label || "job"), waited + ms2(started), new Date().toISOString())
          .run();
        await trimEvents(env);
      }
      message.ack();
    }
  },
};
