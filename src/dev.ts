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
import { mkdir, readFile } from "node:fs/promises";
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
  /** Re-bundle and re-validate after a file changes; throws with a readable message. */
  rebuild: () => Promise<string>;
};

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
  return Object.fromEntries(text.split("\n").flatMap((line): Array<[string, string]> => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return [];
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return [];
    const value = trimmed.slice(eq + 1).trim();
    // Accept quoted values, since a secret can legitimately contain spaces.
    const unquoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
    return [[trimmed.slice(0, eq).trim(), unquoted]];
  }));
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

type Running = {
  sprout: Bun.Subprocess;
  broker: Broker;
  stopBroker: () => void;
  /** Set before a kill we initiated, so its exit code is not reported as a crash. */
  expected: boolean;
};

async function start(input: DevInput, source: string): Promise<Running> {
  const artifact = await buildArtifact({
    projectDir: input.projectDir,
    config: input.config,
    sourcePath: input.sourcePath,
    source,
    target: "host",
  });
  const artifactDir = artifact.artifactDir;
  const sproutPath = resolve(artifactDir, "sprout");

  // `new Database(path, { create: true })` creates the file, never the
  // directory above it, so a first run would fail with SQLITE_CANTOPEN.
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
    sproutUrl: `http://127.0.0.1:${input.port}/`,
    assetsDir: existsSync(assetsDir) ? assetsDir : undefined,
  });
  const server = listen(broker, "127.0.0.1", 0);

  const sprout = Bun.spawn([sproutPath], {
    cwd: dirname(sproutPath),
    env: {
      ...process.env,
      PORT: String(input.port),
      SB_BROKER_PORT: String(server.port),
      SB_BROKER_TOKEN: "sproutboat-dev",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  return { sprout, broker, stopBroker: () => { server.stop(); broker.close(); }, expected: false };
}

function stop(running: Running): void {
  running.expected = true;
  running.sprout.kill(9);
  running.stopBroker();
}

/** Report a sprout that died on its own; a kill we asked for is not news. */
function watchExit(running: Running): void {
  void running.sprout.exited.then((code) => {
    if (running.expected || code === 0) return;
    console.error(amber(`sprout exited with status ${code} — fix it and save to rebuild`));
  });
}

/** Build, run, and (optionally) rebuild on change. Resolves only on shutdown. */
export async function runDev(input: DevInput): Promise<void> {
  let running = await start(input, input.source);
  watchExit(running);
  console.log(ok(`${input.config.name} running on ${leaf(`http://127.0.0.1:${input.port}`)}`));
  if (input.watch) console.log(dim("  watching for changes — ctrl-c to stop"));

  const watchers: FSWatcher[] = [];
  let shuttingDown = false;
  let resolveShutdown: (() => void) | null = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const watcher of watchers) watcher.close();
    stop(running);
    resolveShutdown?.();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);

  if (input.watch) {
    let pending: ReturnType<typeof setTimeout> | null = null;
    let rebuilding = false;
    const onChange = () => {
      if (pending !== null) clearTimeout(pending);
      // Editors write a file in several syscalls; one save should be one build.
      pending = setTimeout(() => {
        void (async () => {
          if (rebuilding || shuttingDown) return;
          rebuilding = true;
          try {
            const source = await input.rebuild();
            console.log(dim("  change detected, rebuilding…"));
            stop(running);
            running = await start(input, source);
            watchExit(running);
            console.log(ok(`  reloaded on http://127.0.0.1:${input.port}`));
          } catch (cause) {
            // Keep the last good build serving; a typo should not take the
            // server down mid-edit.
            console.error(amber(`  rebuild failed, still serving the previous build:\n  ${cause instanceof Error ? cause.message : String(cause)}`));
          } finally {
            rebuilding = false;
          }
        })();
      }, RESTART_DEBOUNCE_MS);
    };
    // The entry's directory covers the usual `src/` layout; the config itself
    // changes bindings, so it needs a rebuild too.
    watchers.push(watch(dirname(input.sourcePath), { recursive: true }, onChange));
    watchers.push(watch(resolve(input.projectDir, "sproutboat.jsonc"), onChange));
  }

  // Watching, we stay up until a signal: a crashed sprout is something to fix
  // and save, not a reason to tear the whole session down. Without a watcher
  // there is nothing to wait for but this one process.
  if (input.watch) {
    await new Promise<void>((resolve) => { resolveShutdown = resolve; });
  } else {
    await running.sprout.exited;
    stop(running);
  }
}
