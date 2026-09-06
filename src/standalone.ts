/**
 * #15 — where a standalone binary keeps its data.
 *
 * A deployed sprout is stateless: every store lives on the node, addressed by
 * account-level resource ids the control plane provisions. A standalone binary
 * has no control plane and exactly one app, so it owns its data directly — and
 * the layout is the one decision that is painful to change later, because it is
 * the thing users copy, back up, and mount.
 *
 * Layout (deliberately identical to what `sproutboat dev` already writes, so the
 * embedded backend and the broker backend read the same files and the
 * conformance suite means something):
 *
 *     <name>.data/
 *       store.sqlite          kv · r2 · mq · do_storage · do_alarm · ae
 *       d1/<binding>.sqlite   one file per D1 database
 *
 * D1 is separate on purpose and must stay that way: it hands the handler
 * arbitrary SQL, so a `CREATE TABLE kv (...)` in user code would otherwise
 * collide with the platform's own tables in the same file.
 *
 * `resources/` from the server layout has no standalone equivalent — account
 * level resource ids are a control-plane concept, and with one app per binary
 * every binding takes the bare-name path.
 */
import { isAbsolute, resolve } from "node:path";

export type StorePaths = {
  /** The directory itself. Created on first run; safe to copy, delete or mount. */
  dataDir: string;
  /** Everything the platform owns, in one file. WAL adds -wal/-shm beside it. */
  storePath: string;
  /** Parent of the per-database D1 files. */
  d1Dir: string;
};

/**
 * Resolve where this app's data lives, most explicit wins:
 *
 *   1. `--data <dir>` on the command line
 *   2. `SPROUTBOAT_DATA` in the environment
 *   3. `./<name>.data` relative to the **working directory**
 *
 * Working directory rather than "beside the executable": the two are the same
 * for the common `./app` case, but cwd still behaves when the binary sits on
 * `$PATH` or on a read-only mount, it is what systemd's `WorkingDirectory`
 * controls, and it costs no `/proc/self/exe` lookup that would not port to
 * macOS anyway.
 */
export function resolveStorePaths(
  appName: string,
  options: { flag?: string | null; env?: string | null; cwd?: string } = {},
): StorePaths {
  const cwd = options.cwd ?? process.cwd();
  const chosen = options.flag || options.env || `${appName}.data`;
  const dataDir = isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
  return { dataDir, storePath: resolve(dataDir, "store.sqlite"), d1Dir: resolve(dataDir, "d1") };
}

/** What a parsed secrets.json can hold before it is checked. */
export type JsonLike = null | boolean | number | string | JsonLike[] | { readonly [key: string]: JsonLike };

/** A usable secret: a string with something in it. An unset shell variable
 *  arrives as "", and an empty API key is a failure worth reporting. */
const isPresent = (value: JsonLike | undefined): value is string =>
  Object(value) !== value && value === String(value) && value !== "";

export type SecretResolution =
  | { ok: true; values: Record<string, string>; sources: Record<string, "env" | "file"> }
  | { ok: false; missing: string[] };

/**
 * Resolve the secrets a standalone binary needs, most explicit wins:
 *
 *   1. the process environment  (systemd EnvironmentFile, docker --env-file,
 *      direnv, sops — whatever the operator already uses)
 *   2. `<data-dir>/secrets.json`, a flat name -> value map, mode 0600
 *
 * A secret is never baked into the binary. That is the same rule the deployed
 * path follows — control decrypts to a file *outside* the content-addressed
 * artifact — and it is why a sprout stays safe to copy: the binary is the same
 * bytes for everyone, the secret is not.
 *
 * Missing values are a startup failure, not a runtime one. The binary knows
 * every name it needs (the config lists them), so it can say "missing secrets:
 * STRIPE_KEY" while someone is still watching, rather than throwing on the
 * first request that touches it — on a device they now have to SSH into.
 *
 * An empty string counts as absent: an unset variable referenced in a shell
 * script arrives as "", and starting with a silently empty API key is worse
 * than refusing to start.
 */
export function resolveSecrets(
  names: readonly string[],
  sources: { env?: Record<string, string | undefined>; file?: Record<string, JsonLike> } = {},
): SecretResolution {
  const env = sources.env ?? process.env;
  const file = sources.file ?? {};
  const values: Record<string, string> = {};
  const from: Record<string, "env" | "file"> = {};
  const missing: string[] = [];
  for (const name of names) {
    const fromEnv = env[name];
    const fromFile = file[name];
    if (isPresent(fromEnv)) {
      values[name] = fromEnv;
      from[name] = "env";
    } else if (isPresent(fromFile)) {
      values[name] = fromFile;
      from[name] = "file";
    } else {
      missing.push(name);
    }
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, values, sources: from };
}

/** What to print when secrets are missing: one line, every name, and the two ways to supply them. */
export function missingSecretsMessage(missing: readonly string[], dataDir: string): string {
  return (
    `missing secrets: ${missing.join(", ")}\n` +
    `set them in the environment, or add them to ${dataDir}/secrets.json (mode 0600)`
  );
}
