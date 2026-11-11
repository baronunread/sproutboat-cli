import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configMigrationsDir, parseProjectConfig } from "./account-field";
import { FAKE_KEY, startFakeCloud, type FakeOptions } from "./cloud-fake";
import {
  nextMigrationNumber,
  parseD1Flags,
  pickBinding,
  localDatabasePath,
  createMigration,
  type D1Io,
} from "./d1-cli";

const MAIN = join(import.meta.dir, "main.ts");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-d1-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "sproutboat.jsonc"),
    `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07", "d1_databases": ["DB"] ${extra} }`,
  );
  return dir;
}

async function cli(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      SPROUTBOAT_NO_UPDATE_CHECK: "1",
      SPROUTBOAT_API_TOKEN: "",
      SPROUTBOAT_TOKEN: "",
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
}

const quiet: D1Io = { log: () => {}, note: () => {}, interactive: false, confirm: async () => true };

describe("arguments and config", () => {
  test("flags: values, =values, booleans and refusals", () => {
    const usage = "d1 execute";
    expect(parseD1Flags(["DB", "--command", "SELECT 1", "--json", "-y"], usage)).toEqual({
      positional: ["DB"],
      flags: { command: "SELECT 1", json: true, local: false, remote: false, yes: true },
    });
    expect(parseD1Flags(["DB", "--file=a.sql", "--remote", "--account", "acme"], usage).flags).toMatchObject({
      file: "a.sql",
      remote: true,
      account: "acme",
    });
    expect(() => parseD1Flags(["--local", "--remote"], usage)).toThrow("not both");
    expect(() => parseD1Flags(["--remote", "--persist-to", "x"], usage)).toThrow("local database");
    expect(() => parseD1Flags(["--command"], usage)).toThrow("needs a value");
    expect(() => parseD1Flags(["--wat"], usage)).toThrow("unknown option --wat");
  });

  test("migrations_dir is a CLI field: validated, then hidden from the shared schema", () => {
    const base = `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07"`;
    expect(parseProjectConfig(`${base}, "migrations_dir": "db/migrations" }`).ok).toBe(true);
    expect(configMigrationsDir(`${base}, "migrations_dir": "db/migrations" }`)).toBe("db/migrations");
    expect(configMigrationsDir(`${base} }`)).toBeUndefined();
    for (const bad of ["../up", "/abs", "C:\\x", "", "a/../../b"]) {
      const parsed = parseProjectConfig(`${base}, "migrations_dir": ${JSON.stringify(bad)} }`);
      expect(parsed.ok).toBe(false);
    }
    expect(parseProjectConfig(`${base}, "account": "acme", "migrations_dir": "m" }`).ok).toBe(true);
  });

  test("a binding is found by name, and a miss lists the project's own", () => {
    const config = parseProjectConfig(
      `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07", "d1_databases": ["DB", { "binding": "LOGS", "id": "d1_0123456789abcdef01234567" }] }`,
    );
    if (!config.ok) throw new Error("config");
    expect(pickBinding(config.value, "DB")).toEqual({ binding: "DB" });
    expect(() => pickBinding(config.value, "NOPE")).toThrow(
      'no D1 binding "NOPE" in sproutboat.jsonc (it has: DB, LOGS)',
    );
    expect(localDatabasePath("/p", { binding: "DB" })).toBe("/p/.sproutboat/dev/d1/DB.sqlite");
    expect(localDatabasePath("/p", { binding: "LOGS", resourceId: "d1_0123456789abcdef01234567" }, "state")).toBe(
      "/p/state/resources/d1_0123456789abcdef01234567.sqlite",
    );
  });

  test("migration files are numbered one past the highest and named from the message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-mig-"));
    roots.push(dir);
    const folder = join(dir, "migrations");
    expect(nextMigrationNumber(folder)).toBe("0001");
    expect(await createMigration(folder, "create users table", quiet, new Date("2026-11-11T10:00:00Z"))).toBe(
      "0001_create_users_table.sql",
    );
    writeFileSync(join(folder, "0007_gap.sql"), "");
    expect(await createMigration(folder, "next", quiet)).toBe("0008_next.sql");
    expect(readFileSync(join(folder, "0001_create_users_table.sql"), "utf8")).toBe(
      "-- Migration number: 0001 \t 2026-11-11T10:00:00.000Z\n",
    );
  });
});

describe("local database", () => {
  test("execute runs every statement in order and prints JSON when stdout is not a terminal", async () => {
    const dir = project();
    const run = await cli(dir, [
      "d1",
      "execute",
      "DB",
      "--command",
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a;b'); SELECT * FROM t",
    ]);
    expect(run.code).toBe(0);
    const results = JSON.parse(run.stdout);
    expect(results).toHaveLength(3);
    expect(results[1].meta).toMatchObject({ changes: 1, last_row_id: 1 });
    expect(results[2]).toMatchObject({ success: true, results: [{ id: 1, name: "a;b" }] });
    expect(readdirSync(join(dir, ".sproutboat/dev/d1"))).toContain("DB.sqlite");
    expect(run.stderr).toContain("Executing on local database");
    expect(run.stderr).toContain("--remote");
  });

  test("--file runs a script, and a failure rolls the whole script back", async () => {
    const dir = project();
    writeFileSync(join(dir, "seed.sql"), "CREATE TABLE a (x);\nINSERT INTO a VALUES (1);\n-- done\n");
    expect((await cli(dir, ["d1", "execute", "DB", "--file", "seed.sql"])).code).toBe(0);
    writeFileSync(join(dir, "bad.sql"), "CREATE TABLE b (x); INSERT INTO nope VALUES (1);");
    const bad = await cli(dir, ["d1", "execute", "DB", "--file", "bad.sql"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("no such table: nope");
    const after = await cli(dir, [
      "d1",
      "execute",
      "DB",
      "--command",
      "SELECT name FROM sqlite_master WHERE name IN ('a','b')",
    ]);
    expect(JSON.parse(after.stdout)[0].results).toEqual([{ name: "a" }]);
    expect((await cli(dir, ["d1", "execute", "DB", "--file", "missing.sql"])).stderr).toContain(
      "missing.sql: no such file",
    );
  });

  test("it needs exactly one of --command and --file, and a binding the project has", async () => {
    const dir = project();
    expect((await cli(dir, ["d1", "execute", "DB"])).code).toBe(2);
    const both = await cli(dir, ["d1", "execute", "DB", "--command", "SELECT 1", "--file", "x.sql"]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("either --command or --file");
    const miss = await cli(dir, ["d1", "execute", "OTHER", "--command", "SELECT 1"]);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain('no D1 binding "OTHER" in sproutboat.jsonc (it has: DB)');
    expect((await cli(dir, ["d1", "execute", "--command", "SELECT 1"])).code).toBe(2);
    expect((await cli(dir, ["d1", "migrations"])).code).toBe(2);
  });

  test("--persist-to moves the database", async () => {
    const dir = project();
    expect(
      (await cli(dir, ["d1", "execute", "DB", "--command", "CREATE TABLE t (x)", "--persist-to", "state"])).code,
    ).toBe(0);
    expect(readdirSync(join(dir, "state/d1"))).toEqual(["DB.sqlite"]);
  });

  test("migrations: create, list, apply in order with tracking rows, and apply again is a no-op", async () => {
    const dir = project();
    expect((await cli(dir, ["d1", "migrations", "create", "DB", "create users"])).stdout).toContain(
      "0001_create_users.sql",
    );
    expect((await cli(dir, ["d1", "migrations", "create", "DB", "add email"])).stdout).toContain("0002_add_email.sql");
    writeFileSync(
      join(dir, "migrations/0001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n",
    );
    writeFileSync(
      join(dir, "migrations/0002_add_email.sql"),
      "ALTER TABLE users ADD COLUMN email TEXT;\nINSERT INTO users (name, email) VALUES ('a', 'a@x.test');\n",
    );
    const list = await cli(dir, ["d1", "migrations", "list", "DB"]);
    expect(list.stdout).toContain("Migrations to be applied:");
    expect(list.stdout).toContain("0001_create_users.sql");
    const apply = await cli(dir, ["d1", "migrations", "apply", "DB"]);
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain("2 migrations applied");
    const rows = await cli(dir, [
      "d1",
      "execute",
      "DB",
      "--command",
      "SELECT name FROM d1_migrations ORDER BY id; SELECT email FROM users",
    ]);
    const [applied, users] = JSON.parse(rows.stdout);
    expect(applied.results).toEqual([{ name: "0001_create_users.sql" }, { name: "0002_add_email.sql" }]);
    expect(users.results).toEqual([{ email: "a@x.test" }]);
    expect((await cli(dir, ["d1", "migrations", "list", "DB"])).stdout).toContain("No migrations to apply");
    expect((await cli(dir, ["d1", "migrations", "apply", "DB"])).stdout).toContain("No migrations to apply");
    // A later migration is the only pending one.
    writeFileSync(join(dir, "migrations/0003_more.sql"), "INSERT INTO users (name) VALUES ('b');\n");
    const next = await cli(dir, ["d1", "migrations", "apply", "DB"]);
    expect(next.stdout).toContain("1 migration applied");
  });

  test("a failing migration is rolled back with its row, earlier ones stay, later ones do not run", async () => {
    const dir = project();
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "migrations/0001_ok.sql"), "CREATE TABLE t (x);");
    writeFileSync(join(dir, "migrations/0002_bad.sql"), "INSERT INTO t VALUES (1); INSERT INTO missing VALUES (1);");
    writeFileSync(join(dir, "migrations/0003_never.sql"), "CREATE TABLE never (x);");
    const apply = await cli(dir, ["d1", "migrations", "apply", "DB"]);
    expect(apply.code).toBe(1);
    expect(apply.stderr).toContain("0002_bad.sql: no such table: missing");
    expect(apply.stderr).toContain("1 earlier migration stay applied");
    const state = await cli(dir, [
      "d1",
      "execute",
      "DB",
      "--command",
      "SELECT name FROM d1_migrations; SELECT count(*) AS n FROM t; SELECT name FROM sqlite_master WHERE name = 'never'",
    ]);
    const [names, count, never] = JSON.parse(state.stdout);
    expect(names.results).toEqual([{ name: "0001_ok.sql" }]);
    expect(count.results).toEqual([{ n: 0 }]);
    expect(never.results).toEqual([]);
  });

  test("migrations_dir moves the folder", async () => {
    const dir = project(`, "migrations_dir": "db/migrations"`);
    expect((await cli(dir, ["d1", "migrations", "create", "DB", "first"])).code).toBe(0);
    expect(readdirSync(join(dir, "db/migrations"))).toEqual(["0001_first.sql"]);
    expect((await cli(dir, ["check"])).stderr).not.toContain("unsupported config field");
  });
});

describe("remote database on a Cloud endpoint", () => {
  async function withCloud(
    options: FakeOptions,
    run: (cloud: ReturnType<typeof startFakeCloud>, env: Record<string, string>) => Promise<void>,
  ) {
    const cloud = startFakeCloud({ appExists: true, d1: ["DB"], ...options });
    try {
      await run(cloud, { SPROUTBOAT_API_URL: cloud.url, SPROUTBOAT_API_TOKEN: FAKE_KEY });
    } finally {
      cloud.stop();
    }
  }

  test("execute --remote posts one transaction to the app's database and prints the results", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      const run = await cli(
        dir,
        [
          "d1",
          "execute",
          "DB",
          "--remote",
          "--command",
          "CREATE TABLE t (x); INSERT INTO t VALUES (1); SELECT x FROM t",
        ],
        env,
      );
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)[2].results).toEqual([{ x: 1 }]);
      expect(cloud.calls.some((call) => call.method === "POST" && call.path === "/v1/apps/hello/d1/DB/query")).toBe(
        true,
      );
      expect(cloud.d1Requests[0]).toMatchObject({ transaction: true });
      expect(run.stderr).not.toContain("--remote for the deployed app");
      // Nothing touched the local database.
      expect(() => readdirSync(join(dir, ".sproutboat/dev/d1"))).toThrow();
    });
  });

  test("a SQL error names the message and leaves the database as it was", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      const run = await cli(
        dir,
        ["d1", "execute", "DB", "--remote", "--command", "CREATE TABLE t (x); INSERT INTO nope VALUES (1)"],
        env,
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("no such table: nope");
      expect(cloud.databases.get("DB")!.query("SELECT name FROM sqlite_master WHERE name = 't'").all()).toEqual([]);
    });
  });

  test("migrations apply --remote records each migration with its tracking row", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      mkdirSync(join(dir, "migrations"));
      writeFileSync(join(dir, "migrations/0001_users.sql"), "CREATE TABLE users (id INTEGER PRIMARY KEY);");
      writeFileSync(join(dir, "migrations/0002_rows.sql"), "INSERT INTO users DEFAULT VALUES;");
      expect((await cli(dir, ["d1", "migrations", "list", "DB", "--remote"], env)).stdout).toContain("0001_users.sql");
      const apply = await cli(dir, ["d1", "migrations", "apply", "DB", "--remote"], env);
      expect(apply.code).toBe(0);
      expect(cloud.databases.get("DB")!.query("SELECT name FROM d1_migrations ORDER BY id").all()).toEqual([
        { name: "0001_users.sql" },
        { name: "0002_rows.sql" },
      ]);
      const migration = cloud.d1Requests.find(
        (body) =>
          JSON.stringify(body).includes("0002_rows.sql") && JSON.stringify(body).includes("INSERT INTO d1_migrations"),
      );
      expect(migration).toMatchObject({
        transaction: true,
        statements: [{ sql: expect.stringContaining("INSERT INTO users") }, { params: ["0002_rows.sql"] }],
      });
      expect((await cli(dir, ["d1", "migrations", "list", "DB", "--remote"], env)).stdout).toContain(
        "No migrations to apply",
      );
    });
  });

  test("a read-only key may SELECT but is told it needs app:write to change data", async () => {
    await withCloud({ denyPermissions: ["app:write"] }, async (_cloud, env) => {
      const dir = project();
      expect((await cli(dir, ["d1", "execute", "DB", "--remote", "--command", "SELECT 1 AS one"], env)).code).toBe(0);
      const write = await cli(dir, ["d1", "execute", "DB", "--remote", "--command", "CREATE TABLE t (x)"], env);
      expect(write.code).toBe(1);
      expect(write.stderr).toContain("app:write");
    });
  });

  test("an app that is not deployed, and a database it does not have, each say so", async () => {
    await withCloud({ appExists: false }, async (_cloud, env) => {
      const run = await cli(project(), ["d1", "execute", "DB", "--remote", "--command", "SELECT 1"], env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("hello is not deployed yet");
    });
    await withCloud({ d1: [] }, async (_cloud, env) => {
      const run = await cli(project(), ["d1", "execute", "DB", "--remote", "--command", "SELECT 1"], env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('has no D1 database "DB" on its host yet');
    });
  });

  test("an oversized file is refused before any request", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      writeFileSync(join(dir, "big.sql"), `INSERT INTO t VALUES ('${"x".repeat(4 * 1024 * 1024)}');`);
      const run = await cli(dir, ["d1", "execute", "DB", "--remote", "--file", "big.sql"], env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("at most 4 MiB");
      expect(cloud.d1Requests).toEqual([]);
    });
  });
});

describe("remote database on self-hosted Community", () => {
  test("a 404 from the control plane is reported as not supported yet", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      const run = await cli(project(), ["d1", "execute", "DB", "--remote", "--command", "SELECT 1"], {
        SPROUTBOAT_API_URL: `http://127.0.0.1:${server.port}`,
        SPROUTBOAT_TOKEN: "test-token",
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("not supported on self-hosted Community yet");
    } finally {
      server.stop(true);
    }
  });
});

describe("migrations create", () => {
  test("the dev state directory is not created by migrations create", async () => {
    const dir = project();
    await cli(dir, ["d1", "migrations", "create", "DB", "x"]);
    expect(readdirSync(dir)).not.toContain(".sproutboat");
  });
});
