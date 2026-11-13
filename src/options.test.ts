import { describe, expect, test } from "bun:test";
import { allFlags, checkOptions, COMMAND_OPTIONS, ENDPOINT_COMMANDS, type Options } from "./options";
import { COMMANDS } from "./surface";

const ok = (command: string, args: string[]) => {
  const result = checkOptions(command, args);
  if ("error" in result) throw new Error(result.error);
  return result.args;
};
const bad = (command: string, args: string[]) => {
  const result = checkOptions(command, args);
  if (!("error" in result)) throw new Error(`accepted: ${args.join(" ")}`);
  return result.error;
};

describe("checkOptions", () => {
  test("--flag=value becomes --flag value, for value flags only", () => {
    expect(ok("deploy", ["--account=acme", "--dry-run", "site"])).toEqual(["--account", "acme", "--dry-run", "site"]);
    expect(ok("dev", ["--port=9000"])).toEqual(["--port", "9000"]);
    expect(bad("deploy", ["--dry-run=yes"])).toBe("--dry-run takes no value");
  });

  test("init takes the create-cloudflare switches, and dev takes --ip", () => {
    expect(ok("init", ["blog", "--template=jobs", "--no-git", "--install", "-y", "--list-templates"])).toEqual([
      "blog",
      "--template",
      "jobs",
      "--no-git",
      "--install",
      "-y",
      "--list-templates",
    ]);
    expect(ok("init", ["--accept-defaults", "--git", "--no-install"])).toEqual([
      "--accept-defaults",
      "--git",
      "--no-install",
    ]);
    expect(bad("init", ["--templat", "jobs"])).toContain("did you mean --template?");
    expect(bad("init", ["--git=false"])).toBe("--git takes no value");
    expect(ok("dev", ["--ip=0.0.0.0"])).toEqual(["--ip", "0.0.0.0"]);
  });

  test("an unknown flag is an error, with the nearest known one when it looks like a typo", () => {
    expect(bad("deploy", ["--bogus"])).toContain("unknown option --bogus");
    expect(bad("deploy", ["--dry-runn"])).toContain("did you mean --dry-run?");
    expect(bad("deploy", ["--acount=acme"])).toContain("did you mean --account?");
    expect(bad("check", ["-x"])).toContain("`check` takes no options");
    expect(bad("tail", ["-z"])).toContain("unknown option -z");
  });

  test("a value may start with a dash, and is never read as a flag", () => {
    expect(ok("secrets", ["put", "TOKEN", "--value", "--not-a-flag"])).toEqual([
      "put",
      "TOKEN",
      "--value",
      "--not-a-flag",
    ]);
    expect(ok("secrets", ["put", "TOKEN", "--value=-x"])).toEqual(["put", "TOKEN", "--value", "-x"]);
    expect(ok("dev", ["--port", "-1"])).toEqual(["--port", "-1"]);
  });

  test("everything after -- and a lone - are left alone", () => {
    expect(ok("deploy", ["--dry-run", "--", "--whatever", "https://x.test"])).toEqual([
      "--dry-run",
      "--",
      "--whatever",
      "https://x.test",
    ]);
    expect(ok("kv", ["key", "get", "ns", "-"])).toEqual(["key", "get", "ns", "-"]);
  });

  test("a URL is never a project directory, a name or a hostname", () => {
    for (const command of [
      "deploy",
      "check",
      "types",
      "dev",
      "build",
      "versions",
      "rollback",
      "tail",
      "delete",
      "domains",
    ])
      expect(bad(command, ["https://dash.sproutboat.com"]), command).toContain("looks like a URL");
    expect(bad("deploy", ["--dry-run", "HTTP://example.com/x"])).toContain(
      "--api-url <url>, --profile <name> or SPROUTBOAT_API_URL",
    );
    expect(bad("init", ["ftp://host"])).toContain("looks like a URL");
  });

  test("a URL that is a flag's value, or a value kv stores, is fine", () => {
    expect(ok("deploy", ["--module", "https://x.test/app.so"])).toEqual(["--module", "https://x.test/app.so"]);
    expect(ok("secrets", ["put", "HOOK", "--value", "https://hooks.test/abc"])).toContain("https://hooks.test/abc");
    expect(ok("kv", ["key", "put", "ns", "site", "https://example.com"])).toContain("https://example.com");
    expect(ok("tail", ["--search", "https://x.test"])).toEqual(["--search", "https://x.test"]);
  });

  test("d1 checks the flags of the subcommand it names", () => {
    expect(ok("d1", ["execute", "DB", "--command=SELECT 1", "--json", "-y"])).toEqual([
      "execute",
      "DB",
      "--command",
      "SELECT 1",
      "--json",
      "-y",
    ]);
    expect(ok("d1", ["migrations", "apply", "DB", "--remote", "--persist-to=x"])).toContain("--persist-to");
    expect(bad("d1", ["migrations", "list", "DB", "--json"])).toContain("unknown option --json");
    expect(bad("d1", ["migrations", "create", "DB", "name", "--local"])).toContain("takes no options");
    expect(bad("d1", ["execute", "DB", "--comand", "x"])).toContain("did you mean --command?");
    expect(bad("d1", ["list", "--json"])).toContain("`d1` takes no options");
    expect(bad("d1", ["execute", "https://example.com"])).toContain("looks like a URL");
  });

  test("secrets takes --no-deploy and bulk's file, and refuses the rest", () => {
    expect(ok("secrets", ["bulk", "keys.json", "--no-deploy", "--account=acme"])).toEqual([
      "bulk",
      "keys.json",
      "--no-deploy",
      "--account",
      "acme",
    ]);
    expect(bad("secrets", ["put", "TOKEN", "--no-deplyo"])).toContain("did you mean --no-deploy?");
    expect(bad("secrets", ["--no-deploy=yes"])).toBe("--no-deploy takes no value");
    expect(bad("secrets", ["bulk", "https://example.com/keys.json"])).toContain("looks like a URL");
  });

  test("deployments checks the flags of the subcommand it names", () => {
    expect(ok("deployments", ["list", "--json", "--account=acme"])).toEqual(["list", "--json", "--account", "acme"]);
    expect(ok("deployments", ["tail", "build_1", "--account", "acme"])).toContain("build_1");
    expect(bad("deployments", ["tail", "build_1", "--json"])).toContain("unknown option --json");
    expect(bad("deployments", ["status", "--jsno"])).toContain("did you mean --json?");
    expect(bad("deployments", ["--json"])).toContain("takes no options");
  });

  test("r2 object checks the flags of the subcommand it names", () => {
    expect(ok("r2", ["object", "put", "ASSETS/a.txt", "--file=a.txt", "--ct", "text/plain", "-p"])).toEqual([
      "object",
      "put",
      "ASSETS/a.txt",
      "--file",
      "a.txt",
      "--ct",
      "text/plain",
      "-p",
    ]);
    expect(ok("r2", ["object", "get", "ASSETS/a.txt", "--remote"])).toContain("--remote");
    // Unsupported Wrangler flags reach the command, which says why.
    expect(ok("r2", ["object", "get", "ASSETS/a.txt", "--local"])).toContain("--local");
    expect(bad("r2", ["object", "get", "ASSETS/a.txt", "--content-type", "x"])).toContain("unknown option");
    expect(bad("r2", ["object", "delete", "ASSETS/a.txt", "--pipe"])).toContain("unknown option --pipe");
    expect(bad("r2", ["object", "delete", "ASSETS/a.txt", "--file", "x"])).toContain("unknown option --file");
    expect(bad("r2", ["object", "put", "ASSETS/a.txt", "--cache-controll", "x"])).toContain(
      "did you mean --cache-control?",
    );
    expect(bad("r2", ["list", "--json"])).toContain("`r2` takes no options");
  });

  test("a command that is not in the table is not checked", () => {
    expect(ok("surprise", ["--anything", "https://x.test"])).toEqual(["--anything", "https://x.test"]);
  });
});

describe("the table and the grammar agree", () => {
  const GLOBAL = new Set(["--config", "--cwd", "--env", "--env-file", "--profile", "--version", "--help", "--api-url"]);

  test("every command in the help has an entry", () => {
    for (const command of COMMANDS) expect(Object.hasOwn(COMMAND_OPTIONS, command.name), command.name).toBe(true);
  });

  test("every flag a command's grammar names is accepted", () => {
    for (const command of COMMANDS) {
      // SAFETY: the previous test checked that every command name is a key of the table.
      const spec: Options = COMMAND_OPTIONS[command.name as keyof typeof COMMAND_OPTIONS];
      if (spec.own) continue;
      const known = new Set(allFlags(spec));
      for (const [flag] of command.args.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g))
        if (!GLOBAL.has(flag)) expect(known.has(flag), `${command.name} documents ${flag}`).toBe(true);
    }
  });

  test("--api-url is documented only for commands that talk to a control plane", () => {
    for (const command of COMMANDS)
      if (command.args.includes("--api-url")) expect(ENDPOINT_COMMANDS.has(command.name), command.name).toBe(true);
  });
});
