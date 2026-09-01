/**
 * The CLI's public surface, as data. `main.ts` builds its usage string from
 * this, and `surface.test.ts` renders it to `SURFACE.md` and checks that the
 * command switch, the referenced env vars, and the doc can't drift apart.
 */
export const CLI_NAME = "sproutboat";

export type Command = { name: string; args: string; summary: string };

export const COMMANDS: readonly Command[] = [
  { name: "init", args: "[name]", summary: "Scaffold sproutboat.jsonc + src/index.js in ./<name>." },
  { name: "check", args: "[project-dir]", summary: "Validate the config and entry point without building." },
  { name: "build", args: "[project-dir]", summary: "Cross-compile the native-fetch worker (Porffor + Zig)." },
  { name: "deploy", args: "[project-dir] [--dry-run] [--artifact <dir>]", summary: "Build (unless --artifact), print the report, upload. --dry-run stops before upload." },
  { name: "login", args: "[--api-url <url>] [--token <token>]", summary: "Device-code browser flow, or store <token> for <url> directly." },
  { name: "tail", args: "[project-dir]", summary: "Print the project's recent request logs." },
  { name: "versions", args: "list [project-dir]", summary: "List the project's deployed versions." },
  { name: "rollback", args: "<version-id> [project-dir]", summary: "Re-activate a previous version." },
  { name: "domains", args: "[list | add <host> | verify <host> | rm <host>] [project-dir]", summary: "Attach a custom domain to the project (TXT-verified). No sub-command lists." },
  { name: "delete", args: "--yes [project-dir]", summary: "Delete the project and every version." },
];

export type EnvVar = { name: string; purpose: string };

export const ENV_VARS: readonly EnvVar[] = [
  { name: "SPROUTBOAT_API_URL", purpose: "Control-plane URL. Overrides the saved active endpoint." },
  { name: "SPROUTBOAT_TOKEN", purpose: "API token. Overrides the saved credential for the endpoint." },
  { name: "SPROUTBOAT_ZIG", purpose: "Path to a Zig binary to use instead of downloading the pinned one." },
  { name: "SPROUTBOAT_UWS_TARBALL", purpose: "Path to a prebuilt uWebSockets (x86_64-linux-musl) tarball to seed the Porffor cache with, instead of downloading it (removes the first-build git + make need)." },
  { name: "SPROUTBOAT_COMPILE_TIMEOUT_MS", purpose: "Porffor compile timeout in ms (default 600000)." },
  { name: "SPROUTBOAT_VARS_JSON", purpose: "JSON object of baked `vars` (UPPER_SNAKE -> string), read by the wrapper when generating the worker module." },
  { name: "SPROUTBOAT_BINDINGS_JSON", purpose: "The artifact's bindings.json, read by the wrapper to emit the `__sbInstallBindings` line." },
  { name: "SPROUTBOAT_CONFIG_DIR", purpose: "Directory for credentials.json (default ~/.config/sproutboat)." },
  { name: "XDG_CONFIG_HOME", purpose: "Base for the default credentials dir when SPROUTBOAT_CONFIG_DIR is unset." },
  { name: "PORFFOR_VERSION", purpose: "Override the Porffor identity string recorded in the manifest." },
  { name: "SB_BROKER_PORT", purpose: "Loopback port of the binding broker, read by the compiled worker at runtime (set by the control plane, or by `src/broker.ts` for local runs)." },
  { name: "SB_BROKER_TOKEN", purpose: "Per-deployment auth token the worker sends on every broker frame, and the broker sends back on scheduled/queue triggers (paired with SB_BROKER_PORT)." },
  { name: "SB_WORKER_URL", purpose: "http://127.0.0.1:<PORT> of the worker; when set, `src/broker.ts` runs the cron scheduler and queue consumer and delivers triggers to it." },
];

/** One-line usage string, e.g. for `usage()` and `--help`. */
export function usageLine(): string {
  const parts = COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name));
  return `usage: ${CLI_NAME} <${parts.join(" | ")}>`;
}
