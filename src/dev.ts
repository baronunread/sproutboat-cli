/**
 * #62 — `sproutboat dev`: the project running on this machine, rebuilt on save.
 *
 * The platform's own local stack (control + edge + supervisor) exists to serve
 * *deployed* artifacts, which are linux-x86_64 and cannot execute on a laptop.
 * This is the other half: build for the host (#62), stand up the same broker
 * the supervisor would, and run the sprout against it — so `env.KV`, secrets,
 * cron and the rest behave the way they will in production without a deploy.
 *
 * Deliberately not the platform: no control plane, no TLS, no routing. One
 * project, one port.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { buildArtifact } from "./build";
import { createBroker, listen, listenTransfers, type Bindings, type Broker } from "./broker";
import { jsonObject, parseJsonValue } from "./json";
import { resolveDevVars } from "./env-file";
import { amber, dim, leaf, ok } from "./style";
import type { SproutboatConfig } from "./config";

const RESTART_DEBOUNCE_MS = 120;
const DEV_COMPILE_SESSION = randomUUID();

export type DevInput = {
  projectDir: string;
  config: SproutboatConfig;
  sourcePath: string;
  /** The bundled module (#89) — already validated by the caller. */
  source: string;
  port: number;
  watch: boolean;
  /** #275: `--env-file` paths (absolute), in order. Default: `.dev.vars`, else the `.env` files. */
  envFiles?: string[];
  /** #275: `--env <name>`, which selects `.dev.vars.<name>` and the `.env.<name>` files. */
  envName?: string;
  /** Re-read the complete project after a change; throws with a readable message. */
  rebuild: () => Promise<Pick<DevInput, "config" | "sourcePath" | "source">>;
  /** Set internally for an asset-only refresh, where recompiling is unnecessary. */
  reuseSproutPath?: string;
  /** Test seam: production always uses the native artifact starter below. */
  candidateFactory?: (input: DevInput, port: number) => Promise<Running>;
  /** Test seam: avoid terminating Bun's test process on a simulated signal. */
  exitOnShutdown?: boolean;
  /** Clock seam for reload observability tests. */
  now?: () => number;
  /** Called once a replacement is ready and the stable route has switched. */
  onReload?: (timing: { editToReadyMs: number; downtimeMs: number }) => void;
};

export function isAssetOnlyRefresh(
  current: Pick<DevInput, "config" | "source">,
  next: Pick<DevInput, "config" | "source">,
): boolean {
  return next.source === current.source && JSON.stringify(next.config) === JSON.stringify(current.config);
}

/**
 * Secrets for local dev (#275), by Wrangler's rules (env-file.ts): `.dev.vars`
 * or the `.env` files, never both; the process environment only with
 * CLOUDFLARE_INCLUDE_PROCESS_ENV=true. A declared secret with no value, or a
 * skipped line, is a warning and `dev` still starts. Read on every (re)start, so
 * an edited file is picked up.
 */
export async function devSecrets(
  input: Pick<DevInput, "projectDir" | "envFiles" | "envName" | "config">,
  inherited: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const resolved = await resolveDevVars({
    projectDir: input.projectDir,
    envName: input.envName,
    envFiles: input.envFiles,
    declared: input.config.secrets ?? [],
    inherited,
  });
  for (const warning of resolved.warnings) console.warn(amber(`! ${warning}`));
  return resolved.values;
}

/** `bindings.json` is written by the build whenever the project declares any. */
async function readBindings(artifactDir: string): Promise<Partial<Bindings> | undefined> {
  const path = resolve(artifactDir, "bindings.json");
  if (!existsSync(path)) return undefined;
  const record = jsonObject(parseJsonValue(await readFile(path, "utf8")));
  // SAFETY: written by `buildArtifact` in this process moments ago, from the
  // Bindings shape; the broker re-validates every field it reads anyway.
  return record as Partial<Bindings> | undefined;
}

export type Running = {
  sprout: Bun.Subprocess;
  sproutPath: string;
  artifactDir: string;
  broker: Broker;
  stopBroker: () => void;
  /** Set before a kill we initiated, so its exit code is not reported as a crash. */
  expected: boolean;
  port: number;
  /** Private direct-transfer listener, absent in test candidates. */
  transferPort?: number;
  enableDispatch: () => void;
  disableDispatch: () => void;
};

/** One browser WebSocket and the connection to the sprout that answers it. */
type SocketRelay = {
  url: string;
  protocols: string[];
  /** Frames that arrived before the sprout side finished opening. */
  queued: Array<string | Uint8Array<ArrayBuffer>>;
  upstream?: WebSocket;
};

const socketRelay: Bun.WebSocketHandler<SocketRelay> = {
  open(client) {
    const relay = client.data;
    const upstream = new WebSocket(relay.url, relay.protocols);
    upstream.binaryType = "arraybuffer";
    relay.upstream = upstream;
    upstream.addEventListener("open", () => {
      for (const frame of relay.queued.splice(0)) upstream.send(frame);
    });
    upstream.addEventListener("message", (event) => {
      if (client.readyState !== 1) return;
      // SAFETY: binaryType is "arraybuffer", so a frame is a string or an ArrayBuffer.
      client.send(event.data as string | ArrayBuffer);
    });
    upstream.addEventListener("close", (event) => {
      // 1005 and 1006 are reserved for the receiver to report; they cannot be sent.
      const code =
        event.code >= 1000 && event.code < 5000 && event.code !== 1005 && event.code !== 1006 ? event.code : 1000;
      client.close(code, event.reason);
    });
    upstream.addEventListener("error", () => client.close(1011, "sprout unavailable"));
  },
  message(client, message) {
    const upstream = client.data.upstream;
    const frame = message instanceof Uint8Array ? new Uint8Array(message) : message;
    if (upstream && upstream.readyState === 1) upstream.send(frame);
    else client.data.queued.push(frame);
  },
  close(client, code, reason) {
    const upstream = client.data.upstream;
    if (!upstream || upstream.readyState > 1) return;
    try {
      upstream.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
  },
};

async function start(input: DevInput, port: number): Promise<Running> {
  const candidateDir = resolve(
    input.projectDir,
    ".sproutboat/dev-build",
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let artifact;
  try {
    artifact = await buildArtifact({
      projectDir: input.projectDir,
      config: input.config,
      sourcePath: input.sourcePath,
      source: input.source,
      target: "host",
      // Never deployable, rebuilt on every edit: buy the iteration loop.
      optimize: "dev",
      reuseSproutPath: input.reuseSproutPath,
      outputDirectory: candidateDir,
      // Alpha 9 keys its C-unit cache by the entry's absolute path. Keep that
      // path fixed across saves while each candidate keeps its own binary.
      generatedPath: resolve(
        input.projectDir,
        ".sproutboat/dev-compile",
        `${process.pid}-${DEV_COMPILE_SESSION}`,
        "sprout.generated.js",
      ),
    });
  } catch (error) {
    await rm(candidateDir, { recursive: true, force: true });
    throw error;
  }
  const artifactDir = artifact.artifactDir;
  const sproutPath = resolve(artifactDir, "sprout");
  let dispatchEnabled = false;
  try {
    const stateDir = resolve(input.projectDir, ".sproutboat/dev");
    await mkdir(stateDir, { recursive: true });
    const assetsDir = resolve(artifactDir, "assets");
    const broker = createBroker({
      db: resolve(stateDir, "state.sqlite"),
      dataDir: resolve(stateDir, "d1"),
      resourceDir: resolve(stateDir, "resources"),
      token: "sproutboat-dev",
      bindings: await readBindings(artifactDir),
      secrets: await devSecrets(input),
      sproutUrl: `http://127.0.0.1:${port}/`,
      assetsDir: existsSync(assetsDir) ? assetsDir : undefined,
      dispatchEnabled: () => dispatchEnabled,
    });
    let server: ReturnType<typeof listen> | undefined;
    let transferServer: ReturnType<typeof listenTransfers> | undefined;
    try {
      server = listen(broker, "127.0.0.1", 0);
      transferServer = listenTransfers(broker, "127.0.0.1", 0);
    } catch (error) {
      server?.stop();
      broker.close();
      throw error;
    }
    let sprout: Bun.Subprocess;
    try {
      sprout = Bun.spawn([sproutPath], {
        cwd: dirname(sproutPath),
        env: {
          ...process.env,
          PORT: String(port),
          SB_BROKER_PORT: String(server!.port),
          SB_BROKER_TOKEN: "sproutboat-dev",
        },
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      server?.stop();
      transferServer?.stop();
      broker.close();
      throw error;
    }
    return {
      sprout,
      sproutPath,
      artifactDir,
      broker,
      stopBroker: () => {
        server?.stop();
        transferServer?.stop();
        broker.close();
      },
      expected: false,
      port,
      transferPort: transferServer?.port,
      enableDispatch: () => {
        dispatchEnabled = true;
      },
      disableDispatch: () => {
        dispatchEnabled = false;
      },
    };
  } catch (error) {
    await rm(candidateDir, { recursive: true, force: true });
    throw error;
  }
}

function stop(running: Running): void {
  if (running.expected) return;
  running.expected = true;
  running.disableDispatch();
  running.sprout.kill(9);
  running.stopBroker();
  // Every candidate owns an isolated snapshot. Once it is no longer serving,
  // remove it so repeated edits do not grow .sproutboat/dev-build forever.
  void rm(running.artifactDir, { recursive: true, force: true });
}

/** Report a sprout that died on its own; a kill we asked for is not news. */
function watchExit(running: Running): void {
  void running.sprout.exited.then((code) => {
    if (running.expected || code === 0) return;
    console.error(amber(`sprout exited with status ${code} — fix it and save to rebuild`));
  });
}

/** Pick an unused loopback port without keeping it reserved. The candidate is
 * started immediately afterwards; the tiny race is preferable to interrupting
 * the current server just to discover a bad replacement. */
function candidatePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop();
  if (port === undefined) throw new Error("could not allocate a candidate port");
  return port;
}

async function waitUntilReady(running: Running): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (running.expected) throw new Error("candidate stopped before becoming ready");
    const exited = await Promise.race([running.sprout.exited.then(() => true), Bun.sleep(30).then(() => false)]);
    if (exited) throw new Error("candidate sprout exited before becoming ready");
    if (await tcpReady(running.port, Math.min(250, deadline - Date.now()))) return;
  }
  throw new Error("candidate sprout did not become ready within 3s");
}

/** Readiness is a bounded TCP connect, never an application request: booting a
 * candidate must not execute user code or wait forever on a handler. */
export function tcpReady(port: number, timeout: number): Promise<boolean> {
  return new Promise((resolveReady) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ready: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveReady(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

/** Build, run, and (optionally) rebuild on change. Resolves only on shutdown. */
export async function runDev(input: DevInput): Promise<void> {
  let current = input;
  const now = input.now ?? Date.now;
  const startCandidate = input.candidateFactory ?? start;
  let running = await startCandidate(current, candidatePort());
  try {
    await waitUntilReady(running);
  } catch (error) {
    stop(running);
    throw error;
  }
  running.enableDispatch();
  let activePort = running.port;
  let activeTransferPort = running.transferPort;
  // Keep the public port stable while candidates boot on private ports. This is
  // what lets a failed startup leave the last known-good process reachable.
  let proxy: ReturnType<typeof Bun.serve>;
  try {
    proxy = Bun.serve<SocketRelay>({
      hostname: "127.0.0.1",
      port: input.port,
      maxRequestBodySize: 5 * 1024 * 1024 * 1024,
      websocket: socketRelay,
      fetch(request, server) {
        const target = new URL(request.url);
        // A WebSocket upgrade cannot go through fetch(): relay it, frame by frame, to the sprout.
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          target.protocol = "ws:";
          target.host = `127.0.0.1:${activePort}`;
          const protocols = request.headers.get("sec-websocket-protocol");
          const data: SocketRelay = {
            url: target.toString(),
            protocols: protocols ? protocols.split(",").map((entry) => entry.trim()) : [],
            queued: [],
          };
          if (server.upgrade(request, { data })) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        const directTransfer = /^\/__sb\/r2\/transfer\/[A-Z][A-Z0-9_]*\/[0-9a-f]{24}$/.test(target.pathname);
        if (directTransfer) server.timeout(request, 255);
        if (directTransfer && !activeTransferPort) return new Response("direct transfers unavailable", { status: 503 });
        target.host = `127.0.0.1:${directTransfer ? activeTransferPort : activePort}`;
        return fetch(target, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
        }).catch(() => new Response("sprout unavailable", { status: 502 }));
      },
    });
  } catch (error) {
    stop(running);
    throw error;
  }
  watchExit(running);
  console.log(ok(`${input.config.name} running on ${leaf(`http://127.0.0.1:${input.port}`)}`));
  if (input.watch) console.log(dim("  watching for changes — ctrl-c to stop"));

  let watchers: FSWatcher[] = [];
  let shuttingDown = false;
  let resolveShutdown: (() => void) | null = null;
  let pendingCandidate: Running | null = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const watcher of watchers) watcher.close();
    // Close open sockets too: a graceful stop waits for a WebSocket the browser keeps open.
    proxy.stop(true);
    if (pendingCandidate) stop(pendingCandidate);
    stop(running);
    resolveShutdown?.();
    if (input.exitOnShutdown !== false) process.exit(0);
  };
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) process.on(signal, shutdown);
  let rebuildTask: Promise<void> | null = null;

  if (input.watch) {
    let pending: ReturnType<typeof setTimeout> | null = null;
    let rebuilding = false;
    let dirty = false;
    const resetWatchers = () => {
      for (const watcher of watchers) watcher.close();
      const next: FSWatcher[] = [
        watch(dirname(current.sourcePath), { recursive: true }, onChange),
        // Watch the containing directory as well: atomic-save editors replace
        // the config inode, which otherwise silently detaches a file watcher.
        watch(current.projectDir, { recursive: false }, onChange),
      ];
      if (current.config.assets) {
        const assets = resolve(current.projectDir, current.config.assets.directory);
        // The parent sees a generated directory being atomically replaced;
        // the directory watcher sees updates inside an existing snapshot.
        next.push(watch(dirname(assets), { recursive: false }, onChange));
        if (existsSync(assets)) next.push(watch(assets, { recursive: true }, onChange));
      }
      watchers = next;
    };
    const onChange = () => {
      dirty = true;
      if (pending !== null) clearTimeout(pending);
      // Editors write a file in several syscalls; one save should be one build.
      pending = setTimeout(() => {
        rebuildTask = (async () => {
          if (rebuilding || shuttingDown) return;
          rebuilding = true;
          try {
            dirty = false;
            const editStartedAt = now();
            const next = await current.rebuild();
            console.log(dim("  change detected, rebuilding…"));
            const assetOnly = isAssetOnlyRefresh(current, next);
            const candidate = await startCandidate(
              { ...current, ...next, reuseSproutPath: assetOnly ? running.sproutPath : undefined },
              candidatePort(),
            );
            pendingCandidate = candidate;
            if (shuttingDown) {
              stop(candidate);
              pendingCandidate = null;
              return;
            }
            try {
              await waitUntilReady(candidate);
            } catch (error) {
              stop(candidate);
              pendingCandidate = null;
              throw error;
            }
            if (shuttingDown) {
              stop(candidate);
              pendingCandidate = null;
              return;
            }
            // Only now is the public route switched. The old process stays up
            // through compilation and candidate startup.
            const previous = running;
            previous.disableDispatch();
            candidate.enableDispatch();
            running = candidate;
            pendingCandidate = null;
            current = { ...current, ...next };
            const switchedAt = now();
            activePort = candidate.port;
            activeTransferPort = candidate.transferPort;
            resetWatchers();
            stop(previous);
            watchExit(running);
            input.onReload?.({ editToReadyMs: switchedAt - editStartedAt, downtimeMs: now() - switchedAt });
            console.log(ok(`  reloaded on http://127.0.0.1:${input.port}`));
          } catch (cause) {
            // Keep the last good build serving; a typo should not take the
            // server down mid-edit.
            console.error(
              amber(
                `  rebuild failed, still serving the previous build:\n  ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            );
          } finally {
            rebuilding = false;
            if (dirty && !shuttingDown) onChange();
          }
        })();
        void rebuildTask;
      }, RESTART_DEBOUNCE_MS);
    };
    resetWatchers();
  }

  // Watching, we stay up until a signal: a crashed sprout is something to fix
  // and save, not a reason to tear the whole session down. Without a watcher
  // there is nothing to wait for but this one process.
  if (input.watch) {
    await new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    // A signal can arrive while a candidate factory is building. Let that task
    // return its newly-created resources to the coordinator, which observes
    // `shuttingDown` and stops them, before declaring shutdown complete.
    await rebuildTask;
  } else {
    await running.sprout.exited;
    stop(running);
  }
  for (const signal of signals) process.off(signal, shutdown);
}
