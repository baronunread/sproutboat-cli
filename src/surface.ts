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
  { name: "build", args: "[project-dir]", summary: "Cross-compile the native-fetch sprout (Porffor + Zig)." },
  { name: "deploy", args: "[project-dir] [--dry-run] [--artifact <dir>] [--no-wait]", summary: "Build (unless --artifact), print the report, upload, wait until the URL serves. --dry-run stops before upload; --no-wait skips the health check." },
  { name: "login", args: "[--api-url <url>] [--token <token>]", summary: "Device-code browser flow, or store <token> for <url> directly." },
  { name: "tail", args: "[project-dir] [--sprout]", summary: "Print recent request logs; --sprout prints the running sprout + broker stdout/stderr instead." },
  { name: "versions", args: "list [project-dir]", summary: "List the project's deployed versions." },
  { name: "rollback", args: "<version-id> [project-dir]", summary: "Re-activate a previous version." },
  { name: "domains", args: "[list | add <host> | verify <host> | rm <host>] [project-dir]", summary: "Attach a custom domain to the project (TXT-verified). No sub-command lists." },
  { name: "secrets", args: "[list | set <NAME> [value] | rm <NAME>] [project-dir]", summary: "Manage encrypted project secrets (read as env.NAME). `set` takes the value from the arg or stdin; applies on next deploy." },
  { name: "delete", args: "[project-dir] [--name <project>] --yes", summary: "Delete the project, every version, and its route." },
];

export type EnvVar = { name: string; purpose: string };

export const ENV_VARS: readonly EnvVar[] = [
  { name: "SPROUTBOAT_API_URL", purpose: "Control-plane URL. Overrides the saved active endpoint." },
  { name: "SPROUTBOAT_TOKEN", purpose: "API token. Overrides the saved credential for the endpoint." },
  { name: "SPROUTBOAT_ZIG", purpose: "Path to a Zig binary to use instead of downloading the pinned one." },
  { name: "SPROUTBOAT_UWS_TARBALL", purpose: "Path to a prebuilt uWebSockets (x86_64-linux-musl) tarball to seed the Porffor cache with, instead of downloading it (removes the first-build git + make need)." },
  { name: "SPROUTBOAT_COMPILE_TIMEOUT_MS", purpose: "Porffor compile timeout in ms (default 600000)." },
  { name: "SPROUTBOAT_VARS_JSON", purpose: "JSON object of baked `vars` (UPPER_SNAKE -> string), read by the wrapper when generating the sprout module." },
  { name: "SPROUTBOAT_BINDINGS_JSON", purpose: "The artifact's bindings.json, read by the wrapper to emit the `__sbInstallBindings` line." },
  { name: "SPROUTBOAT_CONFIG_DIR", purpose: "Directory for credentials.json (default ~/.config/sproutboat)." },
  { name: "NO_COLOR", purpose: "When set, disables coloured terminal output (https://no-color.org). Output is also plain whenever stdout is not a TTY." },
  { name: "XDG_CONFIG_HOME", purpose: "Base for the default credentials dir when SPROUTBOAT_CONFIG_DIR is unset." },
  { name: "PORFFOR_VERSION", purpose: "Override the Porffor identity string recorded in the manifest." },
  { name: "SB_BROKER_PORT", purpose: "Loopback port of the binding broker, read by the compiled sprout at runtime (set by the control plane, or by `src/broker.ts` for local runs)." },
  { name: "SB_BROKER_TOKEN", purpose: "Per-deployment auth token the sprout sends on every broker frame, and the broker sends back on scheduled/queue triggers (paired with SB_BROKER_PORT)." },
  { name: "SB_SPROUT_URL", purpose: "http://127.0.0.1:<PORT> of the sprout; when set, `src/broker.ts` runs the cron scheduler and queue consumer and delivers triggers to it." },
];

/** One-line usage string, e.g. for `usage()` and `--help`. */
export function usageLine(): string {
  const parts = COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name));
  return `usage: ${CLI_NAME} <${parts.join(" | ")}>`;
}
