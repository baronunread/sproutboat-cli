import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvFileError,
  mergeEntries,
  missingSecrets,
  parseDotenv,
  readEnvFile,
  resolveDevVars,
  resolveEnvironment,
} from "./env-file";

const values = (text: string) => Object.fromEntries(parseDotenv(text, "t.env").entries.map((e) => [e.key, e.value]));
const warnings = (text: string) => parseDotenv(text, "t.env").warnings;

test("dotenv syntax: assignments, comments, export, spaces, colon form, dotted names", () => {
  expect(
    values(`# a comment
API_KEY=abc123

  DB_URL = postgres://u:p@h/db
export TOKEN=xyz
EMPTY=
EQ=a=b=c
dotted.name-1=ok
COLON: value
INLINE=before # after
HASH=a#b
PATH_LIKE=C:\\temp\\x
DOLLAR=$HOME-literal
`),
  ).toEqual({
    API_KEY: "abc123",
    DB_URL: "postgres://u:p@h/db",
    TOKEN: "xyz",
    EMPTY: "",
    EQ: "a=b=c",
    "dotted.name-1": "ok",
    COLON: "value",
    INLINE: "before",
    HASH: "a",
    PATH_LIKE: "C:\\temp\\x",
    DOLLAR: "$HOME-literal",
  });
});

test("quotes: single and backtick are literal, double expands \\n and \\r, comments may follow", () => {
  expect(
    values(`A='no \\n expansion, # and $X kept'
B="line\\nbreak and # kept"
C=\`back \\n tick\`
D="a" # trailing comment
E='  padded  '
F="say \\"hi\\""
`),
  ).toEqual({
    A: "no \\n expansion, # and $X kept",
    B: "line\nbreak and # kept",
    C: "back \\n tick",
    D: "a",
    E: "  padded  ",
    F: 'say \\"hi\\"',
  });
});

test("quoted values may span lines; CRLF and a byte order mark are accepted; the last repeat wins", () => {
  expect(
    values(`KEY="-----BEGIN KEY-----
abc
-----END KEY-----"
RAW='one
two'
`),
  ).toEqual({ KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----", RAW: "one\ntwo" });
  expect(values('\uFEFFA=1\r\nB="x\r\ny"\r\nA=2\r\n')).toEqual({ A: "2", B: "x\ny" });
});

test("a bad line is a warning with file and line, and the rest still loads", () => {
  const text = 'OK=1\nnot an assignment\n=novalue\nAFTER=2\nUN="never closed\nMORE=3\n';
  expect(warnings(text)).toEqual([
    "t.env:2: skipped, not a NAME=value assignment",
    "t.env:3: skipped, not a NAME=value assignment",
    't.env:5: skipped, unterminated " quote',
  ]);
  expect(values(text)).toEqual({ OK: "1", AFTER: "2" });
});

test("warnings never contain a value, a bad name or any text of the line", () => {
  const secret = "s3cr3t-value-xyz";
  const text = [`${secret}`, `${secret} ${secret}`, `OK=fine`, `Q="${secret} never closed`].join("\n");
  const found = warnings(text);
  expect(found.length).toBe(3);
  expect(found.join("\n")).not.toContain(secret);
});

test("precedence for run: options beat the files (later file beats earlier), which beat the environment", () => {
  const first = parseDotenv("PORT=2\nAPI_KEY=first\nONLY_FIRST=1\nSB_DATA_DIR=/file\n", "a").entries;
  const second = parseDotenv("API_KEY=second\nONLY_SECOND=2\n", "b").entries;
  const { env, sources } = resolveEnvironment({
    inherited: { PORT: "1", SB_DATA_DIR: "/inherited", API_KEY: "from-env", ONLY_ENV: "e" },
    file: mergeEntries([first, second]),
    options: { PORT: "3", SB_DATA_DIR: "/option" },
  });
  expect(env).toMatchObject({
    PORT: "3",
    SB_DATA_DIR: "/option",
    API_KEY: "second",
    ONLY_FIRST: "1",
    ONLY_SECOND: "2",
    ONLY_ENV: "e",
  });
  expect(Object.fromEntries(sources)).toMatchObject({ PORT: "option", API_KEY: "env file", ONLY_ENV: "environment" });
  expect(resolveEnvironment({ inherited: { A: undefined } }).env).toEqual({});
});

test("an unset or empty declared secret is missing", () => {
  const { env } = resolveEnvironment({
    inherited: { EMPTY_ENV: "" },
    file: parseDotenv("SET=1\nEMPTY=\n", "f").entries,
  });
  expect(missingSecrets(["SET", "EMPTY", "EMPTY_ENV", "ABSENT"], env)).toEqual(["EMPTY", "EMPTY_ENV", "ABSENT"]);
});

async function withProject<T>(files: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sb-env-file-"));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const dev = (dir: string, over: Partial<Parameters<typeof resolveDevVars>[0]> = {}) =>
  resolveDevVars({ projectDir: dir, declared: [], inherited: {}, ...over });

test("dev: .dev.vars alone", async () => {
  await withProject({ ".dev.vars": "A=1\nB=2\n" }, async (dir) => {
    const result = await dev(dir);
    expect(result.values).toEqual({ A: "1", B: "2" });
    expect(result.used).toEqual([join(dir, ".dev.vars")]);
    expect(result.warnings).toEqual([]);
  });
});

test("dev: .dev.vars or the .env files, never both, and the ignored files are named", async () => {
  await withProject({ ".dev.vars": "A=from-dev-vars\n", ".env": "A=from-env\nB=only-env\n" }, async (dir) => {
    const result = await dev(dir);
    expect(result.values).toEqual({ A: "from-dev-vars" });
    expect(result.warnings).toEqual([
      `${join(dir, ".dev.vars")} exists, so the .env files are not loaded (ignored: ${join(dir, ".env")})`,
    ]);
  });
});

test("dev: .dev.vars.<env> replaces .dev.vars when it exists, else .dev.vars is used", async () => {
  await withProject({ ".dev.vars": "A=base\nB=base\n", ".dev.vars.staging": "A=staging\n" }, async (dir) => {
    expect((await dev(dir, { envName: "staging" })).values).toEqual({ A: "staging" });
    expect((await dev(dir, { envName: "other" })).values).toEqual({ A: "base", B: "base" });
    expect((await dev(dir)).values).toEqual({ A: "base", B: "base" });
  });
});

test("dev: the .env files layer, most specific first", async () => {
  await withProject(
    {
      ".env": "A=env\nB=env\nC=env\nD=env\n",
      ".env.staging": "B=staging\nC=staging\nD=staging\n",
      ".env.local": "C=local\nD=local\n",
      ".env.staging.local": "D=staging-local\n",
    },
    async (dir) => {
      expect((await dev(dir, { envName: "staging" })).values).toEqual({
        A: "env",
        B: "staging",
        C: "local",
        D: "staging-local",
      });
      // without an environment name only .env and .env.local apply
      expect((await dev(dir)).values).toEqual({ A: "env", B: "env", C: "local", D: "local" });
    },
  );
});

test("dev: CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false turns the .env files off", async () => {
  await withProject({ ".env": "A=1\n" }, async (dir) => {
    expect((await dev(dir, { inherited: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } })).values).toEqual({});
    expect((await dev(dir, { inherited: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true" } })).values).toEqual({
      A: "1",
    });
  });
});

test("dev: --env-file replaces the default set, a later file overrides an earlier one, and a missing one is an error", async () => {
  await withProject(
    { ".env": "A=default\nB=default\n", "one.env": "A=one\nB=one\n", "two.env": "B=two\n" },
    async (dir) => {
      const result = await dev(dir, { envFiles: [join(dir, "one.env"), join(dir, "two.env")] });
      expect(result.values).toEqual({ A: "one", B: "two" });
      expect(result.used).toEqual([join(dir, "one.env"), join(dir, "two.env")]);
      const missing = await dev(dir, { envFiles: [join(dir, "nope.env")] }).catch((error) => error);
      expect(missing).toBeInstanceOf(EnvFileError);
      expect(missing.message).toContain("env file not found");
    },
  );
  await withProject({ ".dev.vars": "A=1\n", "one.env": "A=one\n" }, async (dir) => {
    const result = await dev(dir, { envFiles: [join(dir, "one.env")] });
    expect(result.values).toEqual({ A: "1" });
    expect(result.warnings[0]).toContain("ignored:");
  });
});

test("dev: the process environment is not passed unless CLOUDFLARE_INCLUDE_PROCESS_ENV=true, and then only declared names, below the files", async () => {
  await withProject({ ".env": "FROM_FILE=file\nSHARED=file\n" }, async (dir) => {
    const inherited = { FROM_PROCESS: "p", SHARED: "process", UNRELATED: "u", HOME: "/h" };
    const off = await dev(dir, { declared: ["FROM_PROCESS", "SHARED"], inherited });
    expect(off.values).toEqual({ FROM_FILE: "file", SHARED: "file" });
    expect(off.warnings.join("\n")).toContain("FROM_PROCESS");
    const on = await dev(dir, {
      declared: ["FROM_PROCESS", "SHARED"],
      inherited: { ...inherited, CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" },
    });
    expect(on.values).toEqual({ FROM_FILE: "file", SHARED: "file", FROM_PROCESS: "p" });
    expect(on.warnings).toEqual([]);
  });
  await withProject({ ".dev.vars": "A=1\n" }, async (dir) => {
    const withDevVars = await dev(dir, {
      declared: ["FROM_PROCESS"],
      inherited: { FROM_PROCESS: "p", CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" },
    });
    expect(withDevVars.values).toEqual({ A: "1" });
  });
});

test("dev: a declared secret with no value is a warning naming it, never a value or a failure", async () => {
  await withProject({ ".dev.vars": "API_KEY=topsecret-value\nEMPTY=\nbroken line\n" }, async (dir) => {
    const result = await dev(dir, { declared: ["API_KEY", "EMPTY", "NOPE"] });
    expect(result.values).toMatchObject({ API_KEY: "topsecret-value" });
    expect(result.warnings.join("\n")).toContain("EMPTY, NOPE");
    expect(result.warnings.join("\n")).toContain(".dev.vars:3: skipped");
    expect(result.warnings.join("\n")).not.toContain("topsecret-value");
  });
});

test("readEnvFile reports a missing file without throwing a parse error", async () => {
  await withProject({}, async (dir) => {
    await expect(readEnvFile(join(dir, "x.env"))).rejects.toThrow("env file not found");
  });
});
