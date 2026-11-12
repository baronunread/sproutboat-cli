#!/usr/bin/env bun
/**
 * The page and the sleeping app on this machine, reachable from other machines on the network.
 *
 *   bun serve.ts            http://<lan address>:8790
 *
 * `sproutboat dev` binds to loopback only, so this runs two of them (the page and showcase-sleeper) on private
 * ports and puts one proxy on 0.0.0.0 in front: /sleeper/* goes to the sleeping app, the rest to the page. The page
 * is told to wake the sleeper at /sleeper through a throwaway config (sproutboat.local.jsonc). Locally nothing
 * sleeps, so "cold" means "the first request this process served".
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { freePort } from "./run-server";

const HERE = import.meta.dir;
const CLI = join(HERE, "../../src/main.ts");
const port = Number(process.env.PORT) || 8790;
const lan = new TextDecoder().decode(Bun.spawnSync(["ipconfig", "getifaddr", "en0"]).stdout).trim() || "127.0.0.1";

await buildWebUi();
const local = join(HERE, "sproutboat.local.jsonc");
writeFileSync(
  local,
  readFileSync(join(HERE, "sproutboat.jsonc"), "utf8").replace(
    '"SLEEPER_URL": ""',
    `"SLEEPER_URL": "http://${lan}:${port}/sleeper"`,
  ),
);

const [appPort, sleeperPort] = [freePort(), freePort()];
const children = [
  Bun.spawn(["bun", CLI, "dev", HERE, "-c", local, "--port", String(appPort), "--no-watch"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", CLI, "dev", join(HERE, "../showcase-sleeper"), "--port", String(sleeperPort), "--no-watch"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
];

// Rebuild site/ when a file it is made from changes. A poll, not fs.watch: reading public/ while building made the
// watcher fire again, forever.
const sources = ["public", "src", "data", "sproutboat.jsonc", "wrangler.jsonc"];
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
const poll = setInterval(() => {
  const now = signature();
  if (now === seen) return;
  seen = now;
  void buildWebUi().catch((error) => console.error(String(error)));
}, 700);

const proxy = Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    // Like the Cloud edge, serve the page's files without waking the app. Read from disk on every request, so a
    // rebuilt site/ shows at once.
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/sleeper/") && url.pathname !== "/healthz") {
      const file = Bun.file(join(HERE, "site", url.pathname === "/" ? "index.html" : url.pathname));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    const toSleeper = url.pathname.startsWith("/sleeper/");
    const target = `http://127.0.0.1:${toSleeper ? sleeperPort : appPort}${toSleeper ? url.pathname.slice("/sleeper".length) : url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-for", server.requestIP(request)?.address ?? "");
    try {
      const upstream = await fetch(target, { method: request.method, headers, body: request.body, redirect: "manual" });
      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch {
      return new Response("the app is still starting: reload in a few seconds", { status: 503 });
    }
  },
});

const stop = () => {
  clearInterval(poll);
  proxy.stop(true);
  for (const child of children) child.kill("SIGINT");
  rmSync(local, { force: true });
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(
  `\n  showcase  http://${lan}:${port}\n  (the first start compiles both apps: about 40 seconds; the page is rebuilt on save, the API needs a restart)\n  Ctrl-C to stop.\n`,
);
await Promise.race(children.map((child) => child.exited));
stop();
