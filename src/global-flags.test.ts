import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { extractGlobalFlags, locateProject } from "./global-flags";

const parse = (...argv: string[]) => {
  const result = extractGlobalFlags(argv);
  if ("error" in result) throw new Error(result.error);
  return result;
};

test("global flags are found before, after and between the command's own arguments", () => {
  const { flags, rest } = parse(
    "-c",
    "app/sproutboat.jsonc",
    "deploy",
    "--dry-run",
    "--profile",
    "work",
    "-e",
    "staging",
  );
  expect(flags).toMatchObject({ config: "app/sproutboat.jsonc", profile: "work", env: "staging", version: false });
  expect(rest).toEqual(["deploy", "--dry-run"]);
});

test("--flag=value works for every global flag", () => {
  const { flags, rest } = parse(
    "dev",
    "--config=a.jsonc",
    "--cwd=/tmp/x",
    "--env=prod",
    "--env-file=.env",
    "--profile=p",
    "-c=b.jsonc",
  );
  expect(flags.config).toBe("b.jsonc");
  expect(flags).toMatchObject({ cwd: "/tmp/x", env: "prod", profile: "p", envFiles: [".env"] });
  expect(rest).toEqual(["dev"]);
});

test("--env-file repeats and keeps its order, so later files win", () => {
  const { flags } = parse("run", "--env-file", "base.env", "--env-file", "local.env", "--env-file=last.env");
  expect(flags.envFiles).toEqual(["base.env", "local.env", "last.env"]);
});

test("a repeated single-value flag takes the last one", () => {
  const { flags } = parse("--profile", "a", "deploy", "--profile", "b", "-e", "x", "-e", "y");
  expect(flags.profile).toBe("b");
  expect(flags.env).toBe("y");
});

test("-v and --version are found anywhere, and -h is left for the command", () => {
  expect(parse("deploy", "-v").flags.version).toBe(true);
  expect(parse("--version").flags.version).toBe(true);
  expect(parse("deploy", "--help").rest).toEqual(["deploy", "--help"]);
});

test("everything after -- is left alone", () => {
  const { flags, rest } = parse("kv", "key", "put", "k", "--", "-e", "--profile", "-v");
  expect(rest).toEqual(["kv", "key", "put", "k", "--", "-e", "--profile", "-v"]);
  expect(flags).toEqual({ envFiles: [], version: false });
});

test("the value of a free-text flag is never read as a global flag", () => {
  const { flags, rest } = parse("secrets", "put", "TOKEN", "--value", "-e", "tail", "--search", "-v");
  expect(rest).toEqual(["secrets", "put", "TOKEN", "--value", "-e", "tail", "--search", "-v"]);
  expect(flags.env).toBeUndefined();
  expect(flags.version).toBe(false);
});

test("a global flag without a value is an error", () => {
  for (const argv of [["--profile"], ["-c"], ["deploy", "--env-file", "--dry-run"], ["--cwd="], ["-e", "-v"]])
    expect(extractGlobalFlags(argv)).toEqual({ error: expect.stringContaining("needs a value") });
});

test("--config names the project: its directory is the project directory", () => {
  const cwd = "/work";
  expect(locateProject(undefined, "app/sproutboat.jsonc", cwd)).toEqual({
    directory: resolve(cwd, "app"),
    configPath: resolve(cwd, "app/sproutboat.jsonc"),
  });
  expect(locateProject("app", "app/sproutboat.jsonc", cwd).directory).toBe(resolve(cwd, "app"));
  expect(() => locateProject("other", "app/sproutboat.jsonc", cwd)).toThrow("pass one");
});

test("without --config the project is the directory given, or the current one", () => {
  expect(locateProject("site", undefined, "/work")).toEqual({
    directory: "/work/site",
    configPath: "/work/site/sproutboat.jsonc",
  });
  expect(locateProject(undefined, undefined, "/work").configPath).toBe("/work/sproutboat.jsonc");
});

test("--api-url is a global flag in both forms, so every command that talks to a control plane honours it", () => {
  for (const argv of [
    ["deploy", "--api-url", "https://a.test", "--dry-run"],
    ["--api-url=https://a.test", "deploy", "--dry-run"],
    ["deploy", "--dry-run", "--api-url=https://a.test"],
  ]) {
    const { flags, rest } = parse(...argv);
    expect(flags.apiUrl).toBe("https://a.test");
    expect(rest).toEqual(["deploy", "--dry-run"]);
  }
  expect(extractGlobalFlags(["deploy", "--api-url"])).toEqual({ error: "--api-url needs a value" });
  expect(parse("deploy", "--api-url", "https://a.test", "--api-url=https://b.test").flags.apiUrl).toBe(
    "https://b.test",
  );
});
