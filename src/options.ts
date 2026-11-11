/**
 * What each command accepts after the global flags are out (global-flags.ts), checked once, before the command runs.
 * A flag a command does not know is an error, never a quiet no-op: a typo or a flag from another tool must not turn
 * into a different action (`deploy --api-url=<url>` used to be ignored and deployed to the saved endpoint).
 *
 * `--flag=value` is rewritten to `--flag value`, so every command parses one form. A positional that looks like a
 * URL is refused for the commands that take a project directory or a name, so `deploy https://dash.example.com` is
 * never read as a folder.
 *
 * The table is documentation too: `surface.test.ts` fails when a flag in a command's grammar (surface.ts) is not here.
 */
export type Options = {
  /** Flags that take the next argument (or `=value`) as their value. */
  readonly value?: readonly string[];
  /** Flags that stand alone. */
  readonly flag?: readonly string[];
  /**
   * Subcommands with options of their own, keyed by their leading words (`"execute"`, `"migrations apply"`): when the
   * arguments start with one, its entry is what is checked, and the command's own `value`/`flag` are not.
   * Arguments that start with none of them are checked against the command's own options.
   */
  readonly sub?: Readonly<Record<string, Options>>;
  /**
   * The command's subcommands parse (and refuse) their own options, so only the plain verbs are checked, where the
   * command itself does it (`storage` in main.ts).
   */
  readonly own?: true;
};

export const COMMAND_OPTIONS = {
  init: {},
  check: {},
  types: {},
  dev: { value: ["--port"], flag: ["--no-watch"] },
  run: { value: ["--binary", "--port", "--data-dir", "--require"], flag: ["--check"] },
  build: {
    value: ["--target"],
    flag: ["--standalone", "--release", "--deploy-files", "--with-restore", "--emit-only"],
  },
  toolchain: { flag: ["--json"] },
  deploy: {
    value: ["--account", "--artifact", "--module", "--sproutd", "--generation", "--secrets-file"],
    flag: ["--dry-run", "--no-wait", "--no-provision"],
  },
  versions: {},
  deployments: {
    sub: {
      list: { value: ["--account"], flag: ["--json"] },
      status: { value: ["--account"], flag: ["--json"] },
      tail: { value: ["--account"] },
    },
  },
  rollback: {},
  tail: {
    value: ["--format", "--status", "--method", "--sampling-rate", "--search", "--outcome", "--file", "--lines"],
    flag: ["--recent", "--sprout", "--no-follow"],
  },
  delete: { value: ["--name"], flag: ["--yes", "-y"] },
  domains: {},
  // `secret` is the same command (surface.ts); `list | put | delete | bulk` share these, `--value` is put's.
  secrets: { value: ["--value", "--account"], flag: ["--no-deploy"] },
  kv: {
    value: ["--output", "--path", "--prefix", "--cursor", "--limit"],
    flag: ["--force", "--text", "--yes"],
  },
  d1: {
    sub: {
      execute: {
        value: ["--command", "--file", "--persist-to", "--account"],
        flag: ["--json", "--local", "--remote", "--yes", "-y"],
      },
      "migrations create": {},
      "migrations list": { value: ["--persist-to", "--account"], flag: ["--local", "--remote"] },
      "migrations apply": { value: ["--persist-to", "--account"], flag: ["--local", "--remote"] },
    },
  },
  // The Wrangler flags that are not supported yet (--local, --jurisdiction, -J, --storage-class, -s, --persist-to) are
  // listed so the command answers with its own reason instead of "unknown option".
  r2: {
    sub: {
      "object get": {
        value: ["--file", "-f", "--account", "--jurisdiction", "-J", "--storage-class", "-s", "--persist-to"],
        flag: ["--pipe", "-p", "--remote", "--local"],
      },
      "object put": {
        value: [
          "--file",
          "-f",
          "--content-type",
          "--ct",
          "--content-disposition",
          "--cd",
          "--content-encoding",
          "--ce",
          "--content-language",
          "--cl",
          "--cache-control",
          "--cc",
          "--expires",
          "--account",
          "--jurisdiction",
          "-J",
          "--storage-class",
          "-s",
          "--persist-to",
        ],
        flag: ["--pipe", "-p", "--remote", "--local"],
      },
      "object delete": {
        value: ["--account", "--jurisdiction", "-J", "--storage-class", "-s", "--persist-to"],
        flag: ["--remote", "--local"],
      },
    },
  },
  queues: {},
  login: { value: ["--token", "--account"] },
  logout: { value: ["--account"] },
  whoami: { value: ["--account"] },
  profile: {},
  complete: {},
} as const satisfies Record<string, Options>;

/** The commands that talk to a control plane, so `--api-url` means something to them. */
export const ENDPOINT_COMMANDS: ReadonlySet<string> = new Set([
  "deploy",
  "versions",
  "deployments",
  "rollback",
  "tail",
  "delete",
  "domains",
  "secrets",
  "kv",
  "d1",
  "r2",
  "queues",
  "login",
  "logout",
  "whoami",
]);

/** Commands whose positionals are never URL-valued (`kv key put <key> <value>` may take one, so `kv` is not here). */
const URL_REFUSED = new Set(Object.keys(COMMAND_OPTIONS).filter((name) => name !== "kv"));

const URL_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export type OptionsCheck = { args: string[] } | { error: string };

const flagsOf = (spec: Options) => [...(spec.value ?? []), ...(spec.flag ?? [])];

/** The subcommand's options when `args` start with one of the command's `sub` entries (one or two words). */
function subOptions(spec: Options, args: readonly string[]): Options | undefined {
  if (!spec.sub) return undefined;
  const named = [args.slice(0, 2).join(" "), args.slice(0, 1).join(" ")];
  for (const key of named) if (Object.hasOwn(spec.sub, key)) return spec.sub[key];
  return undefined;
}

/** Every flag a command takes in any of its forms: its own and its subcommands'. */
export function allFlags(spec: Options): string[] {
  return [...new Set([...flagsOf(spec), ...Object.values(spec.sub ?? {}).flatMap(flagsOf)])];
}

/** The closest known flag to a mistyped one, when one is near enough to be a typo. */
function suggest(name: string, known: readonly string[]): string | undefined {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, at) => at);
    for (let i = 1; i <= a.length; i += 1) {
      let diagonal = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const above = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return row[b.length]!;
  };
  const best = known
    .map((candidate) => ({ candidate, away: distance(name, candidate) }))
    .sort((left, right) => left.away - right.away)[0];
  return best && best.away <= 2 ? best.candidate : undefined;
}

/**
 * Check `args` (what is left after the global flags) for `command`. Returns them with `--flag=value` split in two, or
 * the first problem. A command that is not in the table is not checked here.
 */
export function checkOptions(command: string, args: readonly string[]): OptionsCheck {
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) return { args: [...args] };
  // SAFETY: `command` is a key of the table, checked above.
  const top: Options = COMMAND_OPTIONS[command as keyof typeof COMMAND_OPTIONS];
  if (top.own) return { args: [...args] };
  const spec = subOptions(top, args) ?? top;
  const values = new Set(spec.value);
  const flags = new Set(spec.flag);
  const out: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--") {
      out.push(...args.slice(at));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      if (URL_REFUSED.has(command) && URL_WITH_SCHEME.test(arg))
        return {
          error: `"${arg}" looks like a URL, not a project directory or a name. To pick the control plane use --api-url <url>, --profile <name> or SPROUTBOAT_API_URL`,
        };
      out.push(arg);
      continue;
    }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (values.has(name)) {
      out.push(name);
      if (equals > 0) out.push(arg.slice(equals + 1));
      else if (at + 1 < args.length) out.push(args[(at += 1)]!);
      continue;
    }
    if (flags.has(name)) {
      if (equals > 0) return { error: `${name} takes no value` };
      out.push(name);
      continue;
    }
    const near = suggest(name, flagsOf(spec));
    return {
      error: `unknown option ${name}${near ? ` (did you mean ${near}?)` : ""}${
        flagsOf(spec).length === 0 ? `; \`${command}\` takes no options` : ""
      }`,
    };
  }
  return { args: out };
}
