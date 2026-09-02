/**
 * The CLI's public surface, as data. `main.ts` builds its help + usage strings
 * from this, and `surface.test.ts` renders it to `SURFACE.md` and checks that
 * the command switch, the referenced env vars, and the doc can't drift apart.
 */
import { bold, dim, leaf } from "./style";

export const CLI_NAME = "sproutboat";
export const TAGLINE = "Deploy JavaScript handlers as tiny native binaries on your own VPS.";
export const REPO_URL = "https://github.com/baronunread/sproutboat";

export type Group = "Develop" | "Ship" | "Configure" | "Account";

export type Command = {
  name: string;
  /** Full argument grammar — used by SURFACE.md and the one-line usage string. */
  args: string;
  /** Short argument hint shown in the grouped help list (falls back to `args`). */
  brief?: string;
  group: Group;
  emoji: string;
  summary: string;
};

export const COMMANDS: readonly Command[] = [
  { name: "init", group: "Develop", emoji: "🌱", args: "[name]",
    summary: "Scaffold sproutboat.jsonc + src/index.js in ./<name>." },
  { name: "check", group: "Develop", emoji: "🔍", args: "[project-dir]",
    summary: "Validate the config and entry point without building." },
  { name: "build", group: "Develop", emoji: "🔨", args: "[project-dir]",
    summary: "Cross-compile the native-fetch sprout (Porffor + Zig)." },

  { name: "deploy", group: "Ship", emoji: "🚀",
    args: "[project-dir] [--dry-run] [--artifact <dir>] [--no-wait]", brief: "[project-dir] [--dry-run]",
    summary: "Build (unless --artifact), print the report, upload, wait until the URL serves. --dry-run stops before upload; --no-wait skips the health check." },
  { name: "versions", group: "Ship", emoji: "📜", args: "list [project-dir]",
    summary: "List the project's deployed versions." },
  { name: "rollback", group: "Ship", emoji: "⏮", args: "<version-id> [project-dir]", brief: "<version-id>",
    summary: "Re-activate a previous version." },
  { name: "tail", group: "Ship", emoji: "📡", args: "[project-dir] [--sprout]",
    summary: "Print recent request logs; --sprout prints the running sprout + broker stdout/stderr instead." },

  { name: "domains", group: "Configure", emoji: "🌐",
    args: "[list | add <host> | verify <host> | rm <host>] [project-dir]", brief: "[list | add | verify | rm]",
    summary: "Attach a custom domain to the project (TXT-verified). No sub-command lists." },
  { name: "secrets", group: "Configure", emoji: "🔑",
    args: "[list | set <NAME> [value] | rm <NAME>] [project-dir]", brief: "[list | set | rm]",
    summary: "Manage encrypted project secrets (read as env.NAME). `set` takes the value from the arg or stdin; applies on next deploy." },
  { name: "delete", group: "Configure", emoji: "🗑",
    args: "[project-dir] [--name <project>] --yes", brief: "[project-dir] --yes",
    summary: "Delete the project, every version, and its route." },

  { name: "login", group: "Account", emoji: "🔓", args: "[--api-url <url>] [--token <token>]", brief: "[--token <token>]",
    summary: "Device-code browser flow, or store <token> for <url> directly." },
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

const GROUP_ORDER: readonly Group[] = ["Develop", "Ship", "Configure", "Account"];

/** One-line usage string, e.g. for `usage()` and SURFACE.md. */
export function usageLine(): string {
  const parts = COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name));
  return `usage: ${CLI_NAME} <${parts.join(" | ")}>`;
}

/** First sentence of a summary — enough for the at-a-glance command list. */
function firstSentence(text: string): string {
  const end = text.indexOf(". ");
  return end === -1 ? text.replace(/\.$/, "") : text.slice(0, end);
}

/** Wrangler-style grouped help: `sproutboat` with no command, or `--help`. */
export function helpText(): string {
  const invocations = COMMANDS.map((c) => `${c.name} ${c.brief ?? c.args}`.trim());
  const width = Math.max(...invocations.map((s) => s.length));
  const lines: string[] = [`${bold(CLI_NAME)} — ${TAGLINE}`, "", leaf("USAGE"), `  ${CLI_NAME} <command> [options]`];

  for (const group of GROUP_ORDER) {
    lines.push("", leaf(group.toUpperCase()));
    for (const command of COMMANDS.filter((c) => c.group === group)) {
      const invocation = `${command.name} ${command.brief ?? command.args}`.trim();
      lines.push(`  ${invocation.padEnd(width)}  ${command.emoji}  ${firstSentence(command.summary)}`);
    }
  }

  lines.push(
    "",
    dim(`Run \`${CLI_NAME} <command>\` with no/invalid args to see that command's full usage.`),
    dim(`Docs: ${REPO_URL}  ·  runs on Bun — use \`bunx\`, not \`npx\`.`),
  );
  return lines.join("\n");
}
