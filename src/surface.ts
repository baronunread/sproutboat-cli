/**
 * The CLI's public surface, as data. `main.ts` builds its help + usage strings
 * from this, and `surface.test.ts` renders it to `SURFACE.md` and checks that
 * the command switch, the referenced env vars, and the doc can't drift apart.
 */
import { bold, dim, leaf } from "./style";

export const CLI_NAME = "sproutboat";
export const TAGLINE = "Build and deploy JavaScript handlers as tiny native binaries.";
export const DOCS_URL = "https://sproutboat.com/docs";

export type Group = "Develop" | "Ship" | "Storage" | "Configure" | "Account";

export type Command = {
  name: string;
  /** Other names that run the same command (`secret` for `secrets`, as in Wrangler). */
  aliases?: readonly string[];
  /** Full argument grammar — used by SURFACE.md and the one-line usage string. */
  args: string;
  /** Short argument hint shown in the grouped help list (falls back to `args`). */
  brief?: string;
  group: Group;
  emoji: string;
  /** One short line (about 60 characters) for the grouped help list. Detail lives in `summary`, shown by `<command> --help`. */
  short: string;
  summary: string;
};

/**
 * The storage products. Each is its own command with the same five verbs over
 * its own `/api/<segment>` collection.
 *
 * Wrangler nests two of its four (`kv namespace create`, `r2 bucket create`)
 * and leaves `d1 create` and `queues create` flat. That nesting separates a
 * container from its contents, which the verb already does — so ours are
 * uniform, and contents take their own noun when they exist (`kv key get`).
 */
export type StorageProduct = {
  /** Command name, URL segment, and the dashboard's product page. */
  name: "kv" | "d1" | "r2" | "queues";
  /** One of them, for buttons and messages: "namespace", "bucket". */
  noun: string;
  /** Many of them, for list output and empty states. */
  plural: string;
  emoji: string;
};

export const STORAGE_PRODUCTS: readonly StorageProduct[] = [
  { name: "kv", noun: "namespace", plural: "KV namespaces", emoji: "🗄\uFE0F" },
  { name: "d1", noun: "database", plural: "D1 databases", emoji: "🛢\uFE0F" },
  { name: "r2", noun: "bucket", plural: "R2 buckets", emoji: "🪣" },
  { name: "queues", noun: "queue", plural: "queues", emoji: "📨" },
];

/** Every storage product answers to exactly these, in this order. */
export const STORAGE_VERBS = ["list", "create", "info", "rename", "delete"] as const;

const STORAGE_ARGS = "<list | create <name> | info <name> | rename <name> <new> | delete <name>>";

/** What each storage command offers, in the words the grouped help uses. */
const STORAGE_SHORT = {
  kv: "Manage KV namespaces, keys, bulk data and exports",
  d1: "Manage D1 databases, run SQL, apply migrations",
  r2: "Manage R2 buckets",
  queues: "Manage queues",
} satisfies Record<StorageProduct["name"], string>;

const storageCommands: readonly Command[] = STORAGE_PRODUCTS.map((product) => ({
  name: product.name,
  group: "Storage" as const,
  emoji: product.emoji,
  short: STORAGE_SHORT[product.name],
  args:
    product.name === "kv"
      ? `${STORAGE_ARGS} | <key | bulk | export> ...`
      : product.name === "d1"
        ? `${STORAGE_ARGS} | execute <database> (--command <sql> | --file <path>) [--json] [--local | --remote] | migrations <create | list | apply> <database> ...`
        : STORAGE_ARGS,
  brief: "<command>",
  summary: `${product.plural[0].toUpperCase()}${product.plural.slice(1)}. \`create\` prints the id to bind from sproutboat.jsonc${product.name === "kv" ? "; key and bulk operations manage contents, and export writes a restorable JSON dump" : ""}${product.name === "d1" ? `; \`execute\` runs SQL against the local dev database (.sproutboat/dev/d1/<BINDING>.sqlite) unless --remote, as in Wrangler, and prints JSON when stdout is not a terminal; \`migrations create <database> <name>\` writes migrations/NNNN_<name>.sql (migrations_dir in sproutboat.jsonc changes the folder), \`migrations list\` shows the ones not applied, and \`migrations apply\` applies them in order, each with its row in the d1_migrations table in one transaction, after a confirmation in a terminal. <database> is the binding name from d1_databases. --remote needs a Sproutboat Cloud endpoint (the key needs data:read for SELECT, data:write to change data; the error says which it lacks); self-hosted Community has no remote D1 route yet and says so` : ""}${product.name === "queues" ? "; consumers deliver in batches with retries, and stop after 5 attempts" : ""}.`,
}));

/** The command a typed name runs: an alias maps to its command, anything else is returned as typed. */
export const resolveCommand = (name: string): string =>
  COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))?.name ?? name;

export const COMMANDS: readonly Command[] = [
  {
    name: "init",
    group: "Develop",
    emoji: "🌱",
    short: "Scaffold a new project",
    args: "[name]",
    brief: "[name]",
    summary:
      "Scaffold sproutboat.jsonc, src/index.js and package.json (sproutboat devDependency, dev, deploy and check scripts) in ./<name>.",
  },
  {
    name: "check",
    group: "Develop",
    emoji: "🔍",
    short: "Validate the config and entry point",
    args: "[project-dir]",
    brief: "[project-dir]",
    summary: "Validate the config and entry point without building.",
  },
  {
    name: "types",
    group: "Develop",
    emoji: "🧾",
    short: "Write sproutboat-env.d.ts for your editor",
    args: "[project-dir]",
    brief: "[project-dir]",
    summary:
      "Write sproutboat-env.d.ts from the config, so an editor knows what `env` holds. `dev` and `deploy` refresh it when the config is newer.",
  },
  {
    name: "dev",
    group: "Develop",
    emoji: "⚡",
    short: "Run the app locally, rebuilding on save",
    args: "[project-dir] [--port <n>] [--no-watch] [-e, --env <name>] [--env-file <file>]...",
    brief: "[project-dir]",
    summary:
      "Run the project on this machine with local storage, rebuilding on save. Secrets come from .dev.vars or the .env files (never both), as in Wrangler; a declared secret with no value is a warning.",
  },
  {
    name: "run",
    group: "Develop",
    emoji: "🏃",
    short: "Launch a built standalone binary",
    args: "[project-dir] [--binary <file>] [--env-file <file>]... [--port <n>] [--data-dir <dir>] [--require <NAME,...>] [--check]",
    brief: "[project-dir]",
    summary:
      "Launch a standalone binary with its port, data directory and declared secrets supplied at launch, never baked in. Precedence: --port/--data-dir, then the --env-file files (later overrides earlier), then the environment. A missing declared secret fails the launch, like wrangler deploy; --check validates without starting.",
  },
  {
    name: "build",
    group: "Develop",
    emoji: "🔨",
    short: "Compile the app to a native binary",
    args: "[project-dir] [--target host|linux-x64|linux-arm64] [--standalone] [--release] [--deploy-files] [--with-restore] [--emit-only]",
    brief: "[project-dir]",
    summary:
      "Compile the app to a native binary (Porffor + Zig), cross-compiled for Linux x64 by default. `--target host` builds for this machine instead, to run locally, not deployable. `--standalone` emits one executable carrying its own bindings, with SQLite compiled in (~2 MB) and no separate storage process; add `--target linux-arm64` for an aarch64 box (the default is `linux-x64`) and `--deploy-files` to write a Dockerfile, a systemd socket and service, a fly.toml and a push script beside it. `--release` makes a standalone build the full `-flto -O3` one to publish; without it the link skips LTO (1.5 to 2x faster cold, ~90 MB link memory instead of 1.1 to 1.6 GB, fewer requests per second); `SPROUTBOAT_RELEASE=1` does the same, and a non-standalone build is always the release build. `--with-restore` adds an offline `APP ltx-restore --generation DIR --output NEW_DB [--txid N]` startup command to a standalone executable; it runs before app initialization. `--emit-only` stops after writing `.sproutboat/porffor-units/<shape>/sprout.generated.js`, the module Porffor would compile, and prints its path: every check still runs, nothing is compiled.",
  },
  {
    name: "toolchain",
    group: "Develop",
    emoji: "🩺",
    short: "Check the compiler toolchain",
    args: "doctor [--json]",
    brief: "doctor",
    summary:
      "Report the selected compiler inputs, cache locations, overrides, and host prerequisites without downloading or compiling anything.",
  },

  {
    name: "deploy",
    group: "Ship",
    emoji: "🚀",
    short: "Build the app and publish it",
    args: "[project-dir] [--dry-run] [--artifact <dir>] [--no-wait] [--no-provision] [--api-url <url>] [--account <team>] [--module <file.so>] [--sproutd <dir> --generation <dir>] [--secrets-file <file>]",
    brief: "[project-dir]",
    summary:
      "Build (unless --artifact), create the storage bindings that have no id yet and write their ids into sproutboat.jsonc, print the report, upload, wait until the URL serves. The control plane skips an upload that matches the live artifact byte-for-byte. --dry-run stops before upload; --no-wait skips the health check; --no-provision leaves those bindings as temporary stores that last only for the deploy. On a Sproutboat Cloud endpoint (the default, https://dash.sproutboat.com) it bundles the project, uploads the source by sha256 (skipped when unchanged) and the assets by hash, has the Cloud build it while streaming the build log (Ctrl-C cancels the build), waits for a host to apply the generation the build wrote and prints https://<app>.<team>.sproutboat.app; --no-wait returns once the build is accepted and prints /v1/builds/<id>, and --dry-run says it would build in the Cloud. --module and --sproutd with --generation are the operator paths (an uploaded or locally compiled module, refused for team keys); regular deploys do not need them. On the Cloud, `services` in sproutboat.jsonc become service bindings to the team's Cloud apps of those names (each must be deployed first; compatibility_date 2026-11-18 or later; an app cannot bind itself), resolved before anything is uploaded; --secrets-file <file> (.dev.vars or .env format) sets those secrets once the build is ready (and cannot be combined with --no-wait), and a deploy never removes secrets it does not name (manage them with `secrets`); logged out in a terminal it starts the login, with no terminal it needs SPROUTBOAT_API_TOKEN.",
  },
  {
    name: "versions",
    group: "Ship",
    emoji: "📜",
    short: "List or view deployed versions",
    args: "<list | view <version-id>> [project-dir] [--api-url <url>]",
    brief: "<list | view>",
    summary: "List the project's deployed versions, or show one version's artifact and bindings.",
  },
  {
    name: "rollback",
    group: "Ship",
    emoji: "⏪",
    short: "Re-activate a previous version",
    args: "<version-id> [project-dir] [--api-url <url>]",
    brief: "<version-id>",
    summary: "Re-activate a previous version.",
  },
  {
    name: "tail",
    group: "Ship",
    emoji: "📡",
    short: "Stream live requests, logs and exceptions",
    args: "[project-dir] [--format pretty|json] [--status ok|error|<code>|5xx] [--method GET,POST] [--sampling-rate <0..1>] [--search <text>] [--outcome <name>] [--recent] [--sprout] [--file <log|-> [--lines <n>] [--no-follow]] [--api-url <url>]",
    brief: "[project-dir]",
    summary:
      "Stream live request events, console output and exceptions (like wrangler tail); --recent prints the last 100 request records, --sprout the running app's own stdout and stderr logs. --file follows the JSON records a standalone binary writes with SB_LOG=json (no login needed).",
  },

  {
    name: "delete",
    group: "Ship",
    emoji: "🗑️",
    short: "Delete the app and all its versions",
    args: "[project-dir] [--name <project>] --yes [--api-url <url>]",
    brief: "[project-dir]",
    summary: "Delete the project, every version, and its route.",
  },

  ...storageCommands,

  {
    name: "domains",
    group: "Configure",
    emoji: "🌐",
    short: "Attach custom domains",
    args: "<list | add <host> | verify <host> | delete <host>> [project-dir] [--api-url <url>]",
    brief: "<list | add | verify | delete>",
    summary: "Attach a custom domain to the project (TXT-verified). No sub-command lists.",
  },
  {
    name: "secrets",
    aliases: ["secret"],
    group: "Configure",
    emoji: "🔑",
    short: "Manage encrypted secrets",
    args: "<list | put <NAME> [--value <value>] | delete <NAME> | bulk [file.json | file.env]> [project-dir] [--no-deploy] [--api-url <url>] [--account <team>]",
    brief: "<list | put | delete | bulk>",
    summary:
      'Manage encrypted project secrets (read as env.NAME); `secret` is the same command, as in Wrangler. `put` reads the value from stdin unless --value is given, so it stays out of shell history. `bulk` takes the file of `wrangler secret bulk`: JSON {"NAME": "value", "OLD": null} (null deletes) or a .env file, from the file or stdin, at most 100 entries. On a Cloud endpoint secrets are per app and independent of deploys: put, delete and bulk act on the deployed app, and by default wait for a host to apply them as a new version of the running module (like wrangler secret, which deploys at once); --no-deploy returns as soon as the change is stored. Permissions secret:write and secret:list; an app that is not deployed yet says to deploy first or pass --secrets-file on the first deploy. Self-hosted Community applies secrets on the next deploy or sprout restart and has no redeploy route yet, so --no-deploy changes nothing there.',
  },
  {
    name: "login",
    group: "Account",
    emoji: "🔓",
    short: "Sign in",
    args: "[--api-url <url>] [--token <token>] [--account <team>]",
    brief: "",
    summary:
      "Sign in, as the profile named by --profile (the first login makes `default`). On the Cloud: the device-code flow (RFC 8628), which prints a code and a link, opens the browser when it can, and stores an account API key named `CLI on <hostname>` for the team you approve (--account preselects it). Elsewhere the browser flow, or store <token> for <url> directly.",
  },
  {
    name: "logout",
    group: "Account",
    emoji: "🔒",
    short: "Forget the stored credential",
    args: "[--api-url <url>] [--account <team>]",
    brief: "",
    summary:
      "Forget the stored credential of the profile in use, or for <url>. On the Cloud it also revokes the key on the server (the default team, or --account).",
  },
  {
    name: "whoami",
    group: "Account",
    emoji: "👤",
    short: "Show the profile and account you use",
    args: "[--api-url <url>] [--account <team>]",
    brief: "",
    summary:
      "Show the profile and endpoint in use, and the account or team the credential belongs to (exits 1 when not logged in or the key is rejected).",
  },
  {
    name: "profile",
    group: "Account",
    emoji: "🪪",
    short: "List login profiles or pick the default",
    args: "<list | use <name>>",
    brief: "<list | use>",
    summary:
      "A profile is an endpoint, its stored credential and a default team. `list` shows them and marks the default, which a command uses when nothing else names one; `use <name>` makes another profile the default. `login --profile <name>` creates one, and `--profile <name>` or SPROUTBOAT_PROFILE picks one for a single command.",
  },
  {
    name: "complete",
    group: "Account",
    emoji: "⌨️",
    short: "Print a shell completion script",
    args: "[bash | zsh | fish]",
    brief: "[shell]",
    summary: "Print a shell completion script for the top-level commands (defaults to $SHELL).",
  },
];

export type EnvVar = { name: string; purpose: string };

export const ENV_VARS: readonly EnvVar[] = [
  {
    name: "SPROUTBOAT_API_URL",
    purpose:
      "Control-plane URL, the same as --api-url (which wins). Overrides the active profile's endpoint; it must match SPROUTBOAT_PROFILE when both are set.",
  },
  {
    name: "SPROUTBOAT_PROFILE",
    purpose:
      "Stored login profile to use, like --profile (which wins). Its endpoint and credential apply unless --api-url or SPROUTBOAT_API_TOKEN overrides them.",
  },
  {
    name: "SPROUTBOAT_API_TOKEN",
    purpose:
      "API token (an account API key on the Cloud), like CLOUDFLARE_API_TOKEN. Always wins over the stored login; use it in CI.",
  },
  {
    name: "SPROUTBOAT_TOKEN",
    purpose: "Older name for SPROUTBOAT_API_TOKEN; SPROUTBOAT_API_TOKEN wins when both are set.",
  },
  {
    name: "SPROUTBOAT_ACCOUNT",
    purpose:
      "Cloud team (its URL name) a deploy targets, like account_id. Overridden by --account and the account field of sproutboat.jsonc.",
  },
  {
    name: "SPROUTBOAT_SPROUTD",
    purpose:
      "Operators only: sproutd checkout whose compile-app turns the app into a Cloud module (same as --sproutd). Regular deploys are built by the Cloud and do not need it.",
  },
  { name: "SPROUTBOAT_GENERATION", purpose: "Built sproutd generation to compile against (same as --generation)." },
  { name: "SPROUTBOAT_ZIG", purpose: "Path to a Zig binary to use instead of downloading the pinned one." },
  {
    name: "SPROUTBOAT_ZIG_URL",
    purpose:
      "URL to download the pinned Zig tarball from, instead of a Zig community mirror. The sha256 is still enforced.",
  },
  {
    name: "SPROUTBOAT_UWS_TARBALL",
    purpose:
      "Path to a uWebSockets source tarball to seed the Porffor cache with, instead of the one vendored in the package. Both targets are seeded from it.",
  },
  {
    name: "CC",
    purpose:
      "C compiler for a host build (default `cc` if present, else the vendored Zig cross-compiler targeting this host).",
  },
  {
    name: "CXX",
    purpose:
      "C++ compiler for a host build's native-fetch link step (default `c++` if present, else the vendored Zig cross-compiler targeting this host).",
  },
  {
    name: "AR",
    purpose: "Archiver used to assemble uSockets.a for a host build (default `ar` if present, else Zig's).",
  },
  { name: "SPROUTBOAT_COMPILE_TIMEOUT_MS", purpose: "Porffor compile timeout in ms (default 600000)." },
  {
    name: "SPROUTBOAT_PORFFOR_CHANNEL",
    purpose:
      "Porffor channel for standalone builds: `alpha-22` (default) or `alpha-19` (the previous compiler, kept as a fallback for one release).",
  },
  {
    name: "SPROUTBOAT_RELEASE",
    purpose: "Same as `build --standalone --release`: link with LTO. Any value but empty, `0` or `false` turns it on.",
  },
  {
    name: "SPROUTBOAT_FLTO",
    purpose: "Overrides link-time optimization on alpha 22 builds: `1` turns it on, `0` turns it off.",
  },
  {
    name: "SPROUTBOAT_TOOLCHAIN_CACHE",
    purpose: "Managed Porffor and compiler cache root (default ~/.cache/sproutboat).",
  },
  {
    name: "SPROUTBOAT_PORFFOR_DIR",
    purpose: "Contributor override for an existing Porffor source checkout. Required files are validated before use.",
  },
  {
    name: "SPROUTBOAT_BUILD_UWS_FROM_SOURCE",
    purpose: "Set to 1 to explicitly allow the contributor-only Git and Make uWebSockets fallback.",
  },
  {
    name: "SPROUTBOAT_CLI_VERSION",
    purpose: "CLI version embedded by the release executable build. Not normally set by users.",
  },
  {
    name: "SPROUTBOAT_VARS_JSON",
    purpose:
      "JSON object of baked `vars` (UPPER_SNAKE -> string), read by the wrapper when generating the sprout module.",
  },
  {
    name: "SPROUTBOAT_BINDINGS_JSON",
    purpose: "The artifact's bindings.json, read by the wrapper to emit the `__sbInstallBindings` line.",
  },
  {
    name: "SPROUTBOAT_CONFIG_DIR",
    purpose:
      "Directory for credentials.json (default ~/Library/Preferences/sproutboat on macOS, ~/.config/sproutboat elsewhere; the old macOS place is still read).",
  },
  {
    name: "NO_COLOR",
    purpose:
      "When set, disables coloured terminal output (https://no-color.org). Output is also plain whenever stdout is not a TTY.",
  },
  {
    name: "SPROUTBOAT_NO_UPDATE_CHECK",
    purpose: "When set, skips the once-a-day npm check for a newer `sproutboat` release (also skipped when CI is set).",
  },
  { name: "XDG_CONFIG_HOME", purpose: "Base for the default credentials dir when SPROUTBOAT_CONFIG_DIR is unset." },
  { name: "SHELL", purpose: "Picks the default shell for `complete` with no argument (bash/zsh/fish)." },
  { name: "PORFFOR_VERSION", purpose: "Override the Porffor identity string recorded in the manifest." },
  {
    name: "SB_BROKER_PORT",
    purpose:
      "Loopback port of the binding broker, read by the compiled sprout at runtime (set by the control plane, or by `src/broker.ts` for local runs).",
  },
  {
    name: "SB_BROKER_TOKEN",
    purpose:
      "Per-deployment auth token the sprout sends on every broker frame, and the broker sends back on scheduled/queue triggers (paired with SB_BROKER_PORT).",
  },
  {
    name: "SB_SPROUT_URL",
    purpose:
      "http://127.0.0.1:<PORT> of the sprout; when set, `src/broker.ts` runs the cron scheduler and queue consumer and delivers triggers to it.",
  },
  {
    name: "SB_DATA_DIR",
    purpose:
      "Where a standalone binary keeps store.sqlite and d1/ (#15). Read by the sprout itself in an embedded build; defaults to ./<name>.data.",
  },
  {
    name: "SPROUTBOAT_DATA",
    purpose:
      "Data directory for a standalone binary, after --data and SB_DATA_DIR, before the ./<name>.data default (#15).",
  },
  {
    name: "SB_CA_BUNDLE",
    purpose:
      "PEM bundle of extra certificate authorities a standalone binary should trust, on top of the compiled-in Mozilla root set (#15). Adds trust; nothing disables verification.",
  },
  {
    name: "SB_FETCH_MAX_BYTES",
    purpose:
      "Largest outbound `fetch()` response body a sprout will read, in bytes (default 33554432). The size is the remote host's choice and the body is held whole, so this is the ceiling that stops one upstream exhausting memory.",
  },
  {
    name: "SB_REQUEST_BODY_MAX",
    purpose:
      "Largest inbound request body the runtime accepts, in bytes. From compatibility date 2026-10-27 bodies stream and the default is 104857600 (100 MiB); before it the body is held whole and the default is 1048576. A larger Content-Length is refused with 413 before the handler runs; a chunked body that grows past it closes the connection.",
  },
  {
    name: "SB_EXTRA_CFLAGS",
    purpose:
      "Flags added to Porffor's native-fetch compile step, set by the build so inline C can include BearSSL's header (#15).",
  },
  {
    name: "SB_EXTRA_LINK",
    purpose:
      "Objects to add to Porffor's native-fetch link line, set by the build so a standalone binary links SQLite and BearSSL (#15).",
  },
];

const GROUP_ORDER: readonly Group[] = ["Develop", "Ship", "Storage", "Configure", "Account"];

/** One-line usage string, e.g. for `usage()` and SURFACE.md. */
export function usageLine(): string {
  const parts = COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name));
  return `usage: ${CLI_NAME} <${parts.join(" | ")}>`;
}

export type GlobalFlag = { flags: string; purpose: string; type: string };

/** Flags every command accepts, listed by `sproutboat --help`. */
export const GLOBAL_FLAGS: readonly GlobalFlag[] = [
  { flags: "-c, --config", purpose: "Path to the project's config file", type: "string" },
  { flags: "    --cwd", purpose: "Run as if sproutboat was started in this directory", type: "string" },
  {
    flags: "-e, --env",
    purpose: "Environment for `dev`: selects the .dev.vars.<name> and .env.<name> files",
    type: "string",
  },
  {
    flags: "    --env-file",
    purpose: "Path to an .env file to load; repeat it, and later files override earlier ones",
    type: "array",
  },
  { flags: "-h, --help", purpose: "Show help", type: "boolean" },
  {
    flags: "    --profile",
    purpose: "Use a stored login profile (default: SPROUTBOAT_PROFILE, else the active profile)",
    type: "string",
  },
  { flags: "-v, --version", purpose: "Show version number", type: "boolean" },
];

/** Wrangler-style grouped help: `sproutboat` with no command, or `--help`. */
export function helpText(): string {
  const invocations = COMMANDS.map((c) => `${c.name} ${c.brief ?? c.args}`.trim());
  const width = Math.max(...invocations.map((s) => s.length));
  const lines: string[] = [`${bold(CLI_NAME)} — ${TAGLINE}`, "", leaf("USAGE"), `  ${CLI_NAME} <command> [options]`];

  for (const group of GROUP_ORDER) {
    lines.push("", leaf(group.toUpperCase()));
    for (const command of COMMANDS.filter((c) => c.group === group)) {
      const invocation = `${command.name} ${command.brief ?? command.args}`.trim();
      lines.push(`  ${invocation.padEnd(width)}  ${command.emoji}  ${command.short}`);
    }
  }

  const flagWidth = Math.max(...GLOBAL_FLAGS.map((flag) => flag.flags.length));
  lines.push("", leaf("GLOBAL FLAGS"));
  for (const flag of GLOBAL_FLAGS) lines.push(`  ${flag.flags.padEnd(flagWidth)}  ${flag.purpose}  [${flag.type}]`);

  lines.push("", dim(`Run \`${CLI_NAME} <command> --help\` for a command's options.`), dim(`Docs: ${DOCS_URL}`));
  return lines.join("\n");
}
