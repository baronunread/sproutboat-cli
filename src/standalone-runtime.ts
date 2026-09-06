/**
 * #15 Phase 0 — what a standalone binary does when you run it.
 *
 * The binary embeds three things the build put there: the compiled sprout, the
 * static assets, and the binding declarations from `sproutboat.jsonc`. At
 * startup it materialises the sprout, resolves the data directory and the
 * secrets, stands up the same broker the supervisor would, and hands the port
 * to the sprout. From the handler's point of view nothing is different — the
 * broker is on loopback with a token, exactly as in production.
 *
 * This is deliberately the two-process shape: it reuses `createBroker`
 * unchanged, so the bindings are the *same code* that serves deployed traffic,
 * not a reimplementation. Phase 1 replaces the broker process with an embedded
 * dispatch and this launcher shrinks to almost nothing; the conformance suite
 * is what proves the swap changed no behaviour.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createBroker, listen, type Bindings } from "./broker";
import { missingSecretsMessage, resolveSecrets, resolveStorePaths, type JsonLike } from "./standalone";

/** Everything the build bakes in. Written as one JSON blob beside the binary's entry. */
export type StandaloneManifest = {
  name: string;
  bindings: Partial<Bindings>;
  /** Static assets, path -> base64, plus the assets.json the broker reads. */
  assets?: { manifest: JsonLike; files: Record<string, string> };
};

export type StandaloneArgs = { dataDir?: string; port?: number; help?: boolean };

/** Parse the small runtime surface. Everything else about the app is compiled in. */
export function parseStandaloneArgs(argv: readonly string[]): StandaloneArgs {
  const args: StandaloneArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--data") args.dataDir = argv[++i];
    else if (arg.startsWith("--data=")) args.dataDir = arg.slice("--data=".length);
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) args.port = Number(arg.slice("--port=".length));
  }
  return args;
}

export function usage(name: string): string {
  return [
    `${name} — a Sproutboat app, self-contained`,
    "",
    "  --port <n>     port to listen on (default $PORT, then 8080)",
    "  --data <dir>   where state lives (default $SPROUTBOAT_DATA, then ./<name>.data)",
    "  -h, --help     this",
    "",
    "Secrets come from the environment, or from <data>/secrets.json.",
  ].join("\n");
}

/** `<data>/secrets.json`, when present. Absent or malformed yields {} — the caller reports what is missing. */
const isJsonObject = (value: JsonLike): value is Record<string, JsonLike> =>
  value !== null && Object(value) === value && !Array.isArray(value);

export function readSecretsFile(dataDir: string): Record<string, JsonLike> {
  try {
    const parsed: JsonLike = JSON.parse(readFileSync(resolve(dataDir, "secrets.json"), "utf8"));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Write the embedded sprout and assets into `<data>/.runtime`.
 *
 * Under `.runtime` rather than beside the binary because the binary may sit on
 * a read-only path, and because everything here is derived: deleting it costs a
 * restart, never data.
 */
export type Materialised = { sproutPath: string; assetsDir: string | null };

export function materialise(dataDir: string, sprout: Uint8Array, assets: StandaloneManifest["assets"]): Materialised {
  const runtimeDir = resolve(dataDir, ".runtime");
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  const sproutPath = resolve(runtimeDir, "sprout");
  writeFileSync(sproutPath, sprout);
  chmodSync(sproutPath, 0o755);

  if (!assets) return { sproutPath, assetsDir: null };
  // The broker reads assets.json from *beside* the assets dir, the same layout
  // the artifact uses, so nothing about asset serving is standalone-specific.
  writeFileSync(resolve(runtimeDir, "assets.json"), JSON.stringify(assets.manifest));
  const assetsDir = resolve(runtimeDir, "assets");
  for (const [path, base64] of Object.entries(assets.files)) {
    const target = resolve(assetsDir, `.${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(base64, "base64"));
  }
  return { sproutPath, assetsDir };
}

export type RunResult = { code: number };

/**
 * Start the app: broker first, then the sprout pointed at it.
 *
 * Broker first is not stylistic — a native sprout is ready in about a
 * millisecond and would fire its first `env.KV` call into a socket that is not
 * listening yet. In production the supervisor gates on the broker's port for
 * the same reason; here the broker is in-process, so it is simply already up.
 */
export async function runStandalone(
  manifest: StandaloneManifest,
  sprout: Uint8Array,
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<RunResult> {
  const args = parseStandaloneArgs(argv);
  if (args.help) {
    console.log(usage(manifest.name));
    return { code: 0 };
  }

  const paths = resolveStorePaths(manifest.name, { flag: args.dataDir, env: env.SPROUTBOAT_DATA });
  mkdirSync(paths.d1Dir, { recursive: true });

  const secretNames = manifest.bindings.secrets ?? [];
  const secrets = resolveSecrets(secretNames, { env, file: readSecretsFile(paths.dataDir) });
  if (!secrets.ok) {
    console.error(missingSecretsMessage(secrets.missing, paths.dataDir));
    return { code: 78 }; // EX_CONFIG: a configuration problem, not a crash
  }

  const { sproutPath, assetsDir } = materialise(paths.dataDir, sprout, manifest.assets);
  const port = args.port || Number(env.PORT) || 8080;
  // Random per run, like the supervisor mints per deployment. Honouring an
  // inherited SB_BROKER_TOKEN is what lets a harness post the internal cron and
  // queue triggers the broker would otherwise be the only sender of.
  const token = env.SB_BROKER_TOKEN || crypto.randomUUID().replace(/-/g, "");

  const broker = createBroker({
    db: paths.storePath,
    dataDir: paths.d1Dir,
    token,
    bindings: manifest.bindings,
    secrets: secrets.values,
    assetsDir: assetsDir ?? undefined,
    // Cron and queue consumers deliver back into the sprout on this URL, the
    // same way the broker does for a deployed sprout.
    sproutUrl: `http://127.0.0.1:${port}/`,
  });
  const server = listen(broker, "127.0.0.1", 0);

  const child = Bun.spawn([sproutPath], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...env, PORT: String(port), SB_BROKER_PORT: String(server.port), SB_BROKER_TOKEN: token },
  });

  const stop = () => {
    child.kill(15);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`${manifest.name} listening on http://127.0.0.1:${port}  ·  data ${paths.dataDir}`);
  const code = await child.exited;
  server.stop();
  broker.close();
  return { code };
}
