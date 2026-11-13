#!/usr/bin/env bun
/**
 * The page on this machine, reachable from other machines on the network.
 *
 *   bun serve.ts            http://<lan address>:8795
 *
 * Three things behind one listener on 0.0.0.0:
 *   /            site/, read from disk on every request (the Cloud edge serves these without starting the app)
 *   /api/*       the showcase Worker under `sproutboat dev`, which binds to loopback only
 *   /fleet/*     the local fleet (fleet-local.ts): real processes started on a request and stopped when idle
 *
 * The Worker is told where the fleet is through a throwaway config (sproutboat.local.jsonc), the same two vars a
 * Cloud deploy sets.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { createLocalFleet, ensureFleetBinary } from "./fleet-local";
import { freePort } from "./run-server";

const HERE = import.meta.dir;
const CLI = join(HERE, "../../src/main.ts");
const port = Number(process.env.PORT) || 8795;
const lan = new TextDecoder().decode(Bun.spawnSync(["ipconfig", "getifaddr", "en0"]).stdout).trim() || "127.0.0.1";

await ensureFleetBinary();
await buildWebUi();

const local = join(HERE, "sproutboat.local.jsonc");
writeFileSync(
  local,
  readFileSync(join(HERE, "sproutboat.jsonc"), "utf8")
    .replace('"FLEET_STATE_URL": ""', '"FLEET_STATE_URL": "/fleet/state"')
    .replace('"FLEET_APP_URL": ""', '"FLEET_APP_URL": "/fleet/app/{i}"'),
);

const data = mkdtempSync(join(tmpdir(), "showcase-fleet-"));
const fleet = createLocalFleet(Number(process.env.FLEET_BASE_PORT) || 43100, data);
const appPort = freePort();
const app = Bun.spawn(["bun", CLI, "dev", HERE, "-c", local, "--port", String(appPort), "--no-watch"], {
  stdout: "inherit",
  stderr: "inherit",
});

// `sproutboat dev` rewrites worker-configuration.d.ts from the config it was given, which here is the throwaway
// one. Write it back from sproutboat.jsonc once dev has started, and again on the way out.
const restoreTypes = () => Bun.spawnSync(["bun", CLI, "types"], { cwd: HERE, stdout: "ignore", stderr: "ignore" });
void (async () => {
  for (let i = 0; i < 300 && app.exitCode === null; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${appPort}/healthz`)).ok) break;
    } catch {}
    await Bun.sleep(1000);
  }
  restoreTypes();
})();

// Rebuild site/ when a file it is made from changes. A poll, not fs.watch: reading web/ while building made the
// watcher fire again, forever.
const sources = ["web", "src", "data", "fleet-app/src", "fleet-local.ts"];
const signature = (): string => {
  const parts: string[] = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
  };
  for (const source of sources) visit(join(HERE, source));
  return parts.join("\n");
};
let seen = signature();
let building = false;
const poll = setInterval(() => {
  const now = signature();
  if (now === seen || building) return;
  seen = now;
  building = true;
  void buildWebUi()
    .catch((error) => console.error(String(error)))
    .finally(() => (building = false));
}, 700);

const TYPES = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json"],
  ["svg", "image/svg+xml"],
  ["woff2", "font/woff2"],
]);

const proxy = Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    const address = server.requestIP(request)?.address ?? "unknown";
    if (url.pathname === "/fleet/state") return fleet.state();
    const slot = /^\/fleet\/app\/(\d+)$/.exec(url.pathname);
    if (slot) return fleet.request(Number(slot[1]), address);
    if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-for", address);
      try {
        const upstream = await fetch(`http://127.0.0.1:${appPort}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        });
        const out = new Headers(upstream.headers);
        out.delete("content-encoding");
        out.delete("content-length");
        return new Response(upstream.body, { status: upstream.status, headers: out });
      } catch {
        return Response.json({ error: "the app is still starting", code: "starting" }, { status: 503 });
      }
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (path.includes("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(join(HERE, "site", path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": TYPES.get(path.split(".").pop() ?? "") ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  },
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(poll);
  void proxy.stop(true);
  fleet.stop();
  app.kill("SIGINT");
  rmSync(local, { force: true });
  restoreTypes();
  rmSync(data, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(
  `\n  showcase  http://${lan}:${port}   (pid ${process.pid})\n  The page is rebuilt on save. The Worker (/api) compiles on first start and needs a restart to change.\n  Ctrl-C to stop.\n`,
);
await app.exited;
stop();
