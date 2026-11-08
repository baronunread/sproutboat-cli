import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunArgs } from "./run";

const parse = (...args: string[]) => {
  const result = parseRunArgs(args);
  if ("error" in result) throw new Error(result.error);
  return result.args;
};
const failure = (...args: string[]) => {
  const result = parseRunArgs(args);
  return "error" in result ? result.error : "";
};

test("arguments: defaults and every option", () => {
  expect(parse()).toMatchObject({ dir: undefined, require: [], check: false });
  expect(
    parse(
      "./app",
      "--binary",
      "bin/app",
      "--env-file=prod.env",
      "--env-file",
      "extra.env",
      "--port",
      "9001",
      "--data-dir",
      "/srv/app",
      "--require",
      "A,B",
      "--require",
      "C",
      "--check",
    ),
  ).toMatchObject({
    dir: "./app",
    binary: "bin/app",
    envFiles: ["prod.env", "extra.env"],
    port: 9001,
    dataDir: "/srv/app",
    require: ["A", "B", "C"],
    check: true,
  });
});

test("arguments: rejects bad input", () => {
  expect(failure("--port", "0")).toContain("--port");
  expect(failure("--port", "70000")).toContain("--port");
  expect(failure("--port", "http")).toContain("--port");
  expect(failure("--require", "9BAD")).toContain("--require");
  expect(failure("--env-file")).toContain("needs a value");
  expect(failure("--nope")).toContain("unknown flag");
  expect(failure("a", "b")).toContain("unexpected argument");
});

// The launcher is exercised through the real command with a stand-in for the
// standalone binary: a shell script that records what it was started with.
async function withApp<T>(
  options: { secrets?: string[]; script?: string; noBinary?: boolean },
  run: (ctx: {
    dir: string;
    out: string;
    launch: (args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sb-run-"));
  try {
    const out = join(dir, "record.txt");
    await writeFile(
      join(dir, "sproutboat.jsonc"),
      JSON.stringify({
        name: "app",
        main: "src/index.js",
        compatibility_date: "2026-09-28",
        secrets: options.secrets ?? ["API_KEY", "DB_URL"],
      }),
    );
    if (!options.noBinary) {
      await mkdir(join(dir, "dist"));
      const script =
        options.script ?? `#!/bin/sh\nprintf '%s|%s|%s|%s' "$PORT" "$SB_DATA_DIR" "$API_KEY" "$DB_URL" > "$RECORD"\n`;
      await writeFile(join(dir, "dist", "app"), script);
      await chmod(join(dir, "dist", "app"), 0o755);
    }
    const launch = async (args: string[], env: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "run", dir, ...args], {
        cwd: dir,
        env: {
          ...process.env,
          SPROUTBOAT_NO_UPDATE_CHECK: "1",
          RECORD: out,
          API_KEY: "",
          DB_URL: "",
          PORT: "",
          SB_DATA_DIR: "",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    };
    return await run({ dir, out, launch });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("run: the env file beats the environment, an explicit option beats both, and values stay out of the output", async () => {
  await withApp({}, async ({ dir, out, launch }) => {
    await writeFile(join(dir, "prod.env"), "API_KEY=file-secret-xyz\nPORT=1111\nSB_DATA_DIR=/from/file\n");
    const result = await launch(["--env-file", "prod.env", "--port", "9001", "--data-dir", "data-root"], {
      API_KEY: "env-secret-abc",
      DB_URL: "env-db-secret-def",
      PORT: "2222",
    });
    expect(result.code).toBe(0);
    const [port, data, apiKey, dbUrl] = (await readFile(out, "utf8")).split("|");
    expect(port).toBe("9001");
    expect(data).toBe(join(await realpath(dir), "data-root"));
    expect(apiKey).toBe("file-secret-xyz");
    expect(dbUrl).toBe("env-db-secret-def");
    const shown = result.stdout + result.stderr;
    for (const value of ["file-secret-xyz", "env-secret-abc", "env-db-secret-def"]) expect(shown).not.toContain(value);
    expect(shown).toContain("API_KEY (env file)");
    expect(shown).toContain("DB_URL (environment)");
  });
});

test("run: without an env file the inherited environment supplies the secrets", async () => {
  await withApp({}, async ({ out, launch }) => {
    const result = await launch([], { API_KEY: "a-secret", DB_URL: "d-secret", PORT: "7000" });
    expect(result.code).toBe(0);
    expect((await readFile(out, "utf8")).split("|")).toEqual(["7000", "", "a-secret", "d-secret"]);
  });
});

test("run: a missing or empty declared secret fails before the application starts", async () => {
  await withApp({}, async ({ dir, out, launch }) => {
    await writeFile(join(dir, "p.env"), "API_KEY=present-value\nDB_URL=\n");
    const result = await launch(["--env-file", "p.env"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing declared secret: DB_URL");
    expect(result.stdout + result.stderr).not.toContain("present-value");
    expect(existsSync(out)).toBe(false);
  });
});

test("run: --require adds names the config does not declare", async () => {
  await withApp({ secrets: [] }, async ({ out, launch }) => {
    const result = await launch(["--require", "EXTRA_TOKEN"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("EXTRA_TOKEN");
    expect(existsSync(out)).toBe(false);
  });
});

test("run: a skipped line is a warning with file and line and never a value; a missing env file is an error", async () => {
  await withApp({}, async ({ dir, out, launch }) => {
    await writeFile(join(dir, "bad.env"), "API_KEY=ok-value\nthis-is-a-leaked-secret\nDB_URL=a\nDB_URL=b\n");
    const result = await launch(["--env-file", "bad.env"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("bad.env:2: skipped");
    expect(result.stdout + result.stderr).not.toContain("this-is-a-leaked-secret");
    expect(result.stdout + result.stderr).not.toContain("ok-value");
    // the last repeat of a name wins, as in dotenv
    expect((await readFile(out, "utf8")).split("|")[3]).toBe("b");
    const absent = await launch(["--env-file", "nope.env"]);
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("env file not found");
  });
});

test("run: repeated --env-file flags layer, later files overriding earlier ones", async () => {
  await withApp({}, async ({ dir, out, launch }) => {
    await writeFile(join(dir, "base.env"), "API_KEY=base-key\nDB_URL=base-db\n");
    await writeFile(join(dir, "override.env"), "DB_URL=override-db\n");
    const result = await launch(["--env-file", "base.env", "--env-file", "override.env"]);
    expect(result.code).toBe(0);
    const [, , apiKey, dbUrl] = (await readFile(out, "utf8")).split("|");
    expect([apiKey, dbUrl]).toEqual(["base-key", "override-db"]);
  });
});

test("run: --check validates and prints a summary without starting the binary", async () => {
  await withApp({}, async ({ dir, out, launch }) => {
    await writeFile(join(dir, "ok.env"), "API_KEY=k\nDB_URL=d\n");
    const result = await launch(["--env-file", "ok.env", "--check"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ready to launch");
    expect(existsSync(out)).toBe(false);
  });
});

test("run: the binary's exit code is the launcher's, and a missing binary says how to build it", async () => {
  await withApp({ script: "#!/bin/sh\nexit 7\n" }, async ({ launch }) => {
    expect((await launch([], { API_KEY: "a", DB_URL: "d" })).code).toBe(7);
  });
  await withApp({ noBinary: true }, async ({ launch }) => {
    const result = await launch([], { API_KEY: "a", DB_URL: "d" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("build --standalone");
  });
});

test("run: SIGTERM reaches the binary, which is stopped, and the launcher exits with the signal's status", async () => {
  await withApp({ script: '#!/bin/sh\necho $$ > "$RECORD"\nexec sleep 60\n' }, async ({ dir, out }) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "run", dir], {
      cwd: dir,
      env: { ...process.env, SPROUTBOAT_NO_UPDATE_CHECK: "1", RECORD: out, API_KEY: "a", DB_URL: "d" },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let waited = 0; waited < 8000 && !existsSync(out); waited += 25) await Bun.sleep(25);
    await Bun.sleep(100);
    const pid = Number((await readFile(out, "utf8")).trim());
    expect(pid).toBeGreaterThan(1);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
