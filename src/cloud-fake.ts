/** An in-process stand-in for the Sproutboat Cloud API, exactly the routes the CLI calls. Used by tests only. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { parseBody } from "./cloud";
import { isString, jsonObject, type JsonObject } from "./json";
import { splitSql } from "./sql-split";

export const FAKE_KEY = "sbk_fakekey0123456789";

export type FakeOptions = {
  /** Replies to POST /v1/device/token, in order; the last one repeats. */
  tokenReplies?: { status: number; body: JsonObject }[];
  role?: string;
  applyStates?: string[];
  existingAssetsRef?: string;
  appExists?: boolean;
  /** Fail every authenticated call with this status. */
  failWith?: { status: number; body: JsonObject };
  /** A team key: PUT /v1/modules/<sha> is refused (403 module-upload-disabled), as on the real Cloud. */
  teamKey?: boolean;
  /** The team's other Cloud apps, by project name, for GET /v1/apps and service binding callees. Ids are `<project>_<owner suffix>`. */
  otherApps?: string[];
  /** Permissions the key lacks: `secret:write`, `secret:list`, `data:read` and `data:write` answer 403. */
  denyPermissions?: string[];
  /** Secrets the app already holds (the app must exist). */
  existingSecrets?: Record<string, string>;
  /** D1 databases the app's host holds (binding names): POST /v1/apps/<p>/d1/<BINDING>/query runs on a real SQLite. */
  d1?: string[];
  /** Every data route (D1 query, R2 object) answers this instead of working: the status, the JSON body, extra headers. */
  dataFailure?: { status: number; body?: JsonObject; headers?: Record<string, string> };
  /** How POST /v1/apps/<project>/builds behaves. */
  build?: FakeBuildOptions;
};

export type FakeBuildOptions = {
  /**
   * ready: 202 queued, then built. cached: 200 ready at once. failed / memory-cap: built and failed. hang: queued and
   * never finishes (until cancelled). disabled / no-builder: 503. queue-full: 429.
   */
  mode?: "ready" | "cached" | "failed" | "memory-cap" | "hang" | "disabled" | "no-builder" | "queue-full";
  logs?: string[];
  position?: number | null;
  /** The queued state carries this `waiting` text (builder holding work back), then the build starts. */
  waiting?: string;
  wallMs?: number;
  peakMemoryBytes?: number | null;
  /** Drop the first events connection after this many log frames. */
  dropAfterLogs?: number;
  /** Refuse the events route altogether, so the client has to poll. */
  noEvents?: boolean;
  errorMessage?: string;
};

const MiB = 1048576;
export const FAKE_OWNER_SUFFIX = "0123456789ab";
export const fakeAppId = (project: string) => `${project}_${FAKE_OWNER_SUFFIX}`;

export function startFakeCloud(options: FakeOptions = {}) {
  const calls: { method: string; path: string; body: string; auth: string | null }[] = [];
  const modules = new Set<string>();
  const blobs = new Set<string>();
  const manifests = new Set<string>();
  const replies = [...(options.tokenReplies ?? [])];
  let tokenPolls = 0;
  let revoked = false;
  let appExists = options.appExists ?? false;
  let generation = 0;
  let lastProject = "hello";
  let applies = [...(options.applyStates ?? ["applied"])];
  let spec: JsonObject = {};
  const secretStore = new Map<string, string>(Object.entries(options.existingSecrets ?? {}));
  const written: JsonObject[] = [];
  const patches: JsonObject[] = [];
  const denied = new Set(options.denyPermissions ?? []);
  const dataFailureReply = (failure: NonNullable<FakeOptions["dataFailure"]>) =>
    Response.json(failure.body ?? {}, { status: failure.status, headers: failure.headers });
  const dataDenied = (need: string) =>
    Response.json({ error: "forbidden", reason: "forbidden", need }, { status: 403 });
  const permissionDenied = (need: string) => Response.json({ error: "forbidden", need }, { status: 403 });
  /** The Cloud's spec rules for service bindings and secrets, then the merge. Returns an error reply or null. */
  const checkAndStore = (sent: JsonObject, project: string): Response | null => {
    const patch = jsonObject(sent.secrets_patch ?? null);
    if (sent.secrets !== undefined && patch)
      return Response.json({ error: "secrets and secrets_patch are exclusive" }, { status: 400 });
    if ((patch || sent.secrets !== undefined) && denied.has("secret:write")) return permissionDenied("secret:write");
    const bindings = Array.isArray(sent.bindings) ? sent.bindings.map((b) => jsonObject(b)) : [];
    const services = jsonObject(sent.services ?? null) ?? {};
    for (const b of bindings)
      if (b?.kind === "service" && !(String(b.name) in services))
        return Response.json({ error: `service binding ${String(b.name)} has no services entry` }, { status: 400 });
    for (const [name, callee] of Object.entries(services)) {
      if (!bindings.some((b) => b?.name === name && b.kind === "service"))
        return Response.json({ error: `${name} is not a service binding` }, { status: 400 });
      if (!String(callee).endsWith(`_${FAKE_OWNER_SUFFIX}`))
        return Response.json({ error: "callee belongs to another owner" }, { status: 400 });
      if (callee === fakeAppId(project)) return Response.json({ error: "an app cannot bind itself" }, { status: 400 });
    }
    written.push({ ...sent });
    if (sent.secrets === null) secretStore.clear();
    else if (jsonObject(sent.secrets ?? null)) {
      secretStore.clear();
      for (const [k, v] of Object.entries(jsonObject(sent.secrets)!)) secretStore.set(k, String(v));
    }
    if (patch) {
      for (const [k, v] of Object.entries(jsonObject(patch.set ?? null) ?? {})) secretStore.set(k, String(v));
      for (const k of Array.isArray(patch.delete) ? patch.delete : []) secretStore.delete(String(k));
    }
    return null;
  };
  const stored = (sent: JsonObject): JsonObject => {
    const { secrets: _a, secrets_patch: _b, ...rest } = sent;
    return rest;
  };
  if (options.existingAssetsRef) spec.assets_manifest_ref = options.existingAssetsRef;

  const databases = new Map<string, Database>((options.d1 ?? []).map((name) => [name, new Database(":memory:")]));
  const d1Requests: JsonObject[] = [];
  const sources = new Map<string, Uint8Array>();
  const buildRequests: JsonObject[] = [];
  const eventRequests: string[] = [];
  const cancels: string[] = [];
  const builds = new Map<string, FakeBuild>();
  const buildOptions = options.build ?? {};
  let buildCount = 0;
  let dropped = false;
  const mode = buildOptions.mode ?? "ready";
  const logs = buildOptions.logs ?? [
    "porffor: compiled in 1.0 s\n",
    "built in 4.1 s, peak memory 742 MB (cap 1200 MB)\n",
  ];

  type FakeBuild = {
    id: string;
    body: JsonObject;
    state: string;
    cached: boolean;
    error: JsonObject | null;
    generation: number | null;
    polls: number;
  };
  const stats = (): JsonObject => ({
    driver: "fake",
    wall_ms: buildOptions.wallMs ?? 4100,
    cpu_ms: 3900,
    peak_memory_bytes:
      buildOptions.peakMemoryBytes === undefined
        ? (mode === "memory-cap" ? 1200 : 742) * MiB
        : buildOptions.peakMemoryBytes,
    memory_cap_bytes: 1200 * MiB,
    module_bytes: 1000,
  });
  const view = (b: FakeBuild): JsonObject => ({
    id: b.id,
    project: "hello",
    state: b.state,
    cached: b.cached,
    waiting: b.state === "queued" ? (buildOptions.waiting ?? null) : null,
    position: b.state === "queued" ? (buildOptions.position === undefined ? 1 : buildOptions.position) : null,
    error: b.error,
    module_sha256: b.state === "ready" ? "f".repeat(64) : null,
    record_generation: b.generation,
    hosts: jsonObject(b.body.spec ?? null)?.hosts ?? [],
    input_hash: "1".repeat(64),
    queued_at: `2026-11-11T10:00:0${b.id.slice(-1)}.000Z`,
    finished_at:
      b.state === "ready" || b.state === "failed" || b.state === "canceled"
        ? `2026-11-11T10:00:1${b.id.slice(-1)}.000Z`
        : null,
    stats: (b.state === "ready" && !b.cached) || b.state === "failed" ? stats() : null,
  });
  /** The Cloud writes the app when a build is ready: a new record generation. */
  const finish = (b: FakeBuild) => {
    if (b.state !== "queued" && b.state !== "building") return;
    if (mode === "failed" || mode === "memory-cap") {
      b.state = "failed";
      b.error = {
        code: mode === "memory-cap" ? "memory-cap" : "compile-failed",
        message:
          buildOptions.errorMessage ??
          (mode === "memory-cap"
            ? "porffor stopped: hit the 1200 MB memory cap"
            : "porffor: unsupported syntax at index.js:3"),
      };
      return;
    }
    b.state = "ready";
    const sent = jsonObject(b.body.spec ?? null) ?? {};
    const refused = checkAndStore(sent, String(jsonObject(b.body.build ?? null)?.name ?? ""));
    if (refused) {
      b.state = "failed";
      b.error = { code: "spec-refused", message: "the Cloud refused the app spec" };
      return;
    }
    spec = { ...stored(sent), module: { sha256: "f".repeat(64) } };
    appExists = true;
    generation++;
    b.generation = generation;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const raw = new Uint8Array(await request.arrayBuffer());
      const body = new TextDecoder().decode(raw);
      const path = url.pathname;
      calls.push({
        method: request.method,
        path,
        body:
          path.startsWith("/v1/modules/") ||
          path.startsWith("/v1/assets/blobs/") ||
          (path.startsWith("/v1/sources/") && request.method === "PUT")
            ? ""
            : body,
        auth: request.headers.get("authorization"),
      });
      if (path === "/v1/config") return Response.json({ ingress: "public", github: false, public_url: null });
      if (path === "/v1/device/code")
        return Response.json({
          device_code: "dc-secret",
          user_code: "ABCD-EFGH",
          verification_uri: `${url.origin}/device`,
          verification_uri_complete: `${url.origin}/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      if (path === "/v1/device/token") {
        tokenPolls++;
        const next = replies.length > 1 ? replies.shift()! : replies[0];
        if (next) return Response.json(next.body, { status: next.status });
        return Response.json({
          access_token: FAKE_KEY,
          token_type: "Bearer",
          key_id: "key_1",
          key_name: "CLI on testbox",
          organization: { id: "org_1", slug: "acme", name: "Acme Inc" },
          role: "developer",
        });
      }
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (bearer !== FAKE_KEY || revoked)
        return Response.json({ error: "invalid, expired or revoked API key" }, { status: 401 });
      if (options.failWith) return Response.json(options.failWith.body, { status: options.failWith.status });
      if (path === "/v1/whoami")
        return Response.json({
          kind: "apikey",
          organization: "org_1",
          organization_slug: "acme",
          organization_name: "Acme Inc",
          key: {
            id: "key_1",
            name: "CLI on testbox",
            permissions: { app: ["read", "write", "delete_own"], secret: ["list", "write"] },
          },
          created_by: { id: "u1", name: "Robin", email: "robin@example.test" },
        });
      if (path === "/v1/keys/self" && request.method === "DELETE") {
        revoked = true;
        return Response.json({ revoked: true });
      }
      if (path === "/v1/assets/missing") {
        const wanted: string[] = JSON.parse(body).sha256;
        return Response.json({ missing: wanted.filter((h) => !blobs.has(h)) });
      }
      let m = /^\/v1\/assets\/blobs\/([0-9a-f]{64})$/.exec(path);
      if (m && request.method === "PUT") {
        blobs.add(m[1]!);
        return Response.json({ stored: true });
      }
      m = /^\/v1\/assets\/manifests\/([0-9a-f]{64})$/.exec(path);
      if (m && request.method === "PUT") {
        if (createHash("sha256").update(body).digest("hex") !== m[1])
          return Response.json({ error: "digest mismatch" }, { status: 400 });
        manifests.add(m[1]!);
        return Response.json({ ref: `assets/${m[1]}` });
      }
      if (path === "/v1/sources/missing" && request.method === "POST") {
        const wanted: string[] = JSON.parse(body).sha256;
        return Response.json({ missing: wanted.filter((h) => !sources.has(h)) });
      }
      m = /^\/v1\/sources\/([^/]+)$/.exec(path);
      if (m && request.method === "PUT") {
        if (raw.byteLength > 8 * MiB) return Response.json({ error: "source exceeds 8 MiB" }, { status: 413 });
        if (createHash("sha256").update(raw).digest("hex") !== m[1])
          return Response.json({ error: "digest mismatch" }, { status: 400 });
        sources.set(m[1]!, raw);
        return Response.json({ sha256: m[1], size: raw.byteLength, stored: true });
      }
      m = /^\/v1\/apps\/([^/]+)\/builds$/.exec(path);
      if (m && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        return Response.json({ builds: [...builds.values()].reverse().slice(0, limit).map(view) });
      }
      if (m && request.method === "POST") {
        const sent = JSON.parse(body);
        if (mode === "disabled")
          return Response.json(
            { error: "builds are not enabled on this Cloud", reason: "builds-disabled" },
            { status: 503 },
          );
        if (mode === "no-builder")
          return Response.json({ error: "no builder is registered", reason: "no-builder" }, { status: 503 });
        if (mode === "queue-full")
          return Response.json(
            { error: "at most 2 builds at once per team; wait for one to finish", reason: "team-queue-full" },
            { status: 429 },
          );
        // The build spec is stored in plaintext, so the real Cloud refuses secrets in it.
        const buildSpec = jsonObject(sent.spec ?? null) ?? {};
        if ("secrets" in buildSpec || "secrets_patch" in buildSpec)
          return Response.json({ error: "secrets do not belong in a build spec" }, { status: 400 });
        if (!sources.has(sent.source_sha256))
          return Response.json({ error: "source not uploaded", reason: "source-missing" }, { status: 409 });
        buildRequests.push(sent);
        lastProject = m[1]!;
        const build: FakeBuild = {
          id: `bld_${++buildCount}`,
          body: sent,
          state: "queued",
          cached: mode === "cached",
          error: null,
          generation: null,
          polls: 0,
        };
        builds.set(build.id, build);
        if (mode === "cached") {
          finish(build);
          return Response.json(view(build), { status: 200 });
        }
        return Response.json(view(build), { status: 202 });
      }
      m = /^\/v1\/builds\/([^/]+)\/events$/.exec(path);
      if (m && request.method === "GET") {
        const build = builds.get(m[1]!);
        if (!build) return Response.json({ error: "no such build" }, { status: 404 });
        if (buildOptions.noEvents) return Response.json({ error: "events are down" }, { status: 502 });
        eventRequests.push(url.search);
        const after = Number(url.searchParams.get("after") ?? 0);
        const encoder = new TextEncoder();
        const drop = buildOptions.dropAfterLogs !== undefined && !dropped;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (text: string) => controller.enqueue(encoder.encode(text));
            const frame = (event: string, data: JsonObject, id?: number) =>
              `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            send(
              frame("state", {
                state: "queued",
                position: view(build).position,
                waiting: buildOptions.waiting ?? null,
              }),
            );
            send(": keepalive\n\n");
            send(frame("state", { state: "building", position: null, waiting: null }));
            let seq = 0;
            for (const text of logs) {
              seq++;
              if (seq <= after) continue;
              const text1 = frame("log", { text }, seq);
              // Split each frame across two chunks to exercise the client's buffering.
              const cut = Math.floor(text1.length / 2);
              send(text1.slice(0, cut));
              await Bun.sleep(2);
              send(text1.slice(cut));
              if (drop && seq >= buildOptions.dropAfterLogs!) {
                dropped = true;
                controller.close();
                return;
              }
            }
            if (mode === "hang") return;
            finish(build);
            send(frame("done", view(build)));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      m = /^\/v1\/builds\/([^/]+)$/.exec(path);
      if (m && request.method === "GET") {
        const build = builds.get(m[1]!);
        if (!build) return Response.json({ error: "no such build" }, { status: 404 });
        if (mode !== "hang" && ++build.polls > 1) finish(build);
        return Response.json(view(build));
      }
      if (m && request.method === "DELETE") {
        const build = builds.get(m[1]!);
        if (!build) return Response.json({ error: "no such build" }, { status: 404 });
        cancels.push(build.id);
        if (build.state === "queued" || build.state === "building") build.state = "canceled";
        return Response.json(view(build));
      }
      m = /^\/v1\/modules\/([0-9a-f]{64})$/.exec(path);
      if (m && request.method === "PUT") {
        if (options.teamKey)
          return Response.json(
            { error: "module-upload-disabled", message: "modules are built by the Cloud" },
            { status: 403 },
          );
        modules.add(m[1]!);
        return Response.json({ sha256: m[1] });
      }
      if (path === "/v1/apps" && request.method === "GET") {
        const apps = [...(options.otherApps ?? []), ...(appExists ? [lastProject] : [])];
        return Response.json({
          apps: [...new Set(apps)].map((project) => ({ project, app_id: fakeAppId(project), record_generation: 1 })),
        });
      }
      m = /^\/v1\/apps\/([^/]+)\/d1\/([^/]+)\/query$/.exec(path);
      if (m && request.method === "POST") {
        if (options.dataFailure) return dataFailureReply(options.dataFailure);
        if (!appExists) return Response.json({ error: "no such app" }, { status: 404 });
        const db = databases.get(m[2]!);
        if (!db) return Response.json({ error: "no such database", reason: "no-database" }, { status: 404 });
        const sent = parseBody(body) ?? {};
        d1Requests.push(sent);
        const statements = (Array.isArray(sent.statements) ? sent.statements : []).flatMap((item) => {
          const entry = jsonObject(item);
          // SAFETY: the CLI sends only JSON scalars as bound parameters, which bun:sqlite binds directly.
          const params = Array.isArray(entry?.params) ? (entry.params as (string | number | null)[]) : undefined;
          return entry && isString(entry.sql) ? [{ sql: entry.sql, params }] : [];
        });
        if (denied.has("data:read")) return dataDenied("data:read");
        if (
          denied.has("data:write") &&
          statements.some((entry) => splitSql(entry.sql).some((sql) => !/^\s*(select|pragma)\b/i.test(sql)))
        )
          return dataDenied("data:write");
        const results: JsonObject[] = [];
        let index = 0;
        try {
          db.run("BEGIN");
          for (const [at, entry] of statements.entries()) {
            index = at;
            for (const sql of entry.params ? [entry.sql] : splitSql(entry.sql)) {
              const q = db.query(sql);
              // SAFETY: bun:sqlite rows are plain objects of SQLite values.
              const rows = q.columnNames.length > 0 ? (q.all(...(entry.params ?? [])) as JsonObject[]) : [];
              const info =
                q.columnNames.length > 0 ? { changes: 0, lastInsertRowid: 0 } : q.run(...(entry.params ?? []));
              results.push({
                success: true,
                results: rows,
                meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0.1 },
              });
            }
          }
          db.run("COMMIT");
        } catch (error) {
          db.run("ROLLBACK");
          return Response.json(
            { error: error instanceof Error ? error.message : String(error), reason: "sql-error", statement: index },
            { status: 400 },
          );
        }
        return Response.json({ results });
      }
      m = /^\/v1\/apps\/([^/]+)\/secrets$/.exec(path);
      if (m && request.method === "PATCH") {
        if (denied.has("secret:write")) return permissionDenied("secret:write");
        if (!appExists) return Response.json({ error: "no such app" }, { status: 404 });
        const patch = JSON.parse(body);
        for (const [k, v] of Object.entries(jsonObject(patch.set ?? null) ?? {})) secretStore.set(k, String(v));
        for (const k of Array.isArray(patch.delete) ? patch.delete : []) secretStore.delete(String(k));
        generation++;
        patches.push(patch);
        return Response.json({
          app_id: fakeAppId(m[1]!),
          record_generation: generation,
          names: [...secretStore.keys()].sort(),
        });
      }
      m = /^\/v1\/apps\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(path);
      if (m) {
        const need = request.method === "GET" ? "secret:list" : "secret:write";
        if (denied.has(need)) return permissionDenied(need);
        if (!appExists) return Response.json({ error: "no such app" }, { status: 404 });
        if (request.method === "GET" && !m[2]) return Response.json({ secrets: [...secretStore.keys()].sort() });
        if (request.method === "PUT" && m[2]) {
          secretStore.set(m[2], String(JSON.parse(body).value));
          generation++;
          return Response.json({ app_id: fakeAppId(m[1]!), record_generation: generation, name: m[2] });
        }
        if (request.method === "DELETE" && m[2]) {
          if (!secretStore.delete(m[2])) return Response.json({ error: "no such secret" }, { status: 404 });
          generation++;
          return Response.json({ app_id: fakeAppId(m[1]!), record_generation: generation, name: m[2] });
        }
      }
      m = /^\/v1\/apps\/([^/]+)$/.exec(path);
      if (m && request.method === "GET") {
        if (!appExists) return Response.json({ error: "no such app" }, { status: 404 });
        const state = applies.length > 1 ? applies.shift()! : applies[0]!;
        return Response.json({
          app_id: m[1],
          record_generation: generation,
          spec,
          apply: {
            state,
            applied_generation: state === "applied" ? generation : null,
            error: state === "failed" ? "module failed to load" : null,
          },
        });
      }
      if (m && request.method === "PUT") {
        const sent = JSON.parse(body);
        if (!modules.has(sent.module.sha256)) return Response.json({ error: "module not uploaded" }, { status: 400 });
        const refused = checkAndStore(sent, m[1]!);
        if (refused) return refused;
        spec = stored(sent);
        lastProject = m[1]!;
        appExists = true;
        generation++;
        return Response.json({ app_id: m[1], record_generation: generation, host_id: "h1", placement_generation: 1 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    modules,
    blobs,
    manifests,
    sources,
    buildRequests,
    /** Bodies of POST /v1/apps/<app>/d1/<BINDING>/query. */
    d1Requests,
    /** The fake host's databases, to look at what a command left behind. */
    databases,
    eventRequests,
    cancels,
    get tokenPolls() {
      return tokenPolls;
    },
    get revoked() {
      return revoked;
    },
    /** Every spec the Cloud accepted, secrets_patch and all (values are the test's own). */
    written,
    /** Bodies of PATCH /v1/apps/<app>/secrets. */
    patches,
    get secrets() {
      return Object.fromEntries([...secretStore.entries()].sort());
    },
    get spec() {
      return spec;
    },
    stop: () => server.stop(true),
  };
}
