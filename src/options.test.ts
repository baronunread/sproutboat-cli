import { describe, expect, test } from "bun:test";
import { checkOptions, COMMAND_OPTIONS, ENDPOINT_COMMANDS } from "./options";
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
      const spec: { value?: readonly string[]; flag?: readonly string[]; own?: true } =
        COMMAND_OPTIONS[command.name as keyof typeof COMMAND_OPTIONS];
      if (spec.own) continue;
      const known = new Set([...(spec.value ?? []), ...(spec.flag ?? [])]);
      for (const [flag] of command.args.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g))
        if (!GLOBAL.has(flag)) expect(known.has(flag), `${command.name} documents ${flag}`).toBe(true);
    }
  });

  test("--api-url is documented only for commands that talk to a control plane", () => {
    for (const command of COMMANDS)
      if (command.args.includes("--api-url")) expect(ENDPOINT_COMMANDS.has(command.name), command.name).toBe(true);
  });
});
