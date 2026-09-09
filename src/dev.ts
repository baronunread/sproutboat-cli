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
import { mkdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { buildArtifact } from "./build";
import { createBroker, listen, type Bindings, type Broker } from "./broker";
import { jsonObject, parseJsonValue } from "./json";
import { amber, dim, leaf, ok } from "./style";
import type { SproutboatConfig } from "./config";

const RESTART_DEBOUNCE_MS = 120;

export type DevInput = {
  projectDir: string;
  config: SproutboatConfig;
  sourcePath: string;
  /** The bundled module (#89) — already validated by the caller. */
  source: string;
  port: number;
  watch: boolean;
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
 * Secrets for local dev, `KEY=value` per line, from `.dev.vars` beside the
 * config — the same file Wrangler uses. Deployed secrets live in the control
 * plane and are never on a developer's disk, so this is the only way a bound
 * secret can resolve here.
 */
async function readDevVars(projectDir: string): Promise<Record<string, string>> {
  const path = resolve(projectDir, ".dev.vars");
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  return Object.fromEntries(
    text.split("\n").flatMap((line): Array<[string, string]> => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return [];
      const eq = trimmed.indexOf("=");
      if (eq <= 0) return [];
      const value = trimmed.slice(eq + 1).trim();
      // Accept quoted values, since a secret can legitimately contain spaces.
      const unquoted =
        (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
          ? value.slice(1, -1)
          : value;
      return [[trimmed.slice(0, eq).trim(), unquoted]];
    }),
  );
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
  enableDispatch: () => void;
  disableDispatch: () => void;
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
      secrets: await readDevVars(input.projectDir),
      sproutUrl: `http://127.0.0.1:${port}/`,
      assetsDir: existsSync(assetsDir) ? assetsDir : undefined,
      dispatchEnabled: () => dispatchEnabled,
    });
    let server: ReturnType<typeof listen>;
    try {
      server = listen(broker, "127.0.0.1", 0);
    } catch (error) {
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
          SB_BROKER_PORT: String(server.port),
          SB_BROKER_TOKEN: "sproutboat-dev",
        },
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      server.stop();
      broker.close();
      throw error;
    }
    return {
      sprout,
      sproutPath,
      artifactDir,
      broker,
      stopBroker: () => {
        server.stop();
        broker.close();
      },
      expected: false,
      port,
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
  // Keep the public port stable while candidates boot on private ports. This is
  // what lets a failed startup leave the last known-good process reachable.
  let proxy: ReturnType<typeof Bun.serve>;
  try {
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: input.port,
      fetch(request) {
        const target = new URL(request.url);
        target.host = `127.0.0.1:${activePort}`;
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
    proxy.stop();
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
