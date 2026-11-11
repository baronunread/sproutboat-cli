import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY, startFakeCloud, type FakeOptions } from "./cloud-fake";
import { fakeLogin } from "./fake-login";

const MAIN = join(import.meta.dir, "main.ts");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-secrets-cli-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "sproutboat.jsonc"),
    `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07" }`,
  );
  return dir;
}

async function cli(dir: string, args: string[], env: Record<string, string>, stdin?: string) {
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
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
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

async function withCloud(
  options: FakeOptions,
  run: (cloud: ReturnType<typeof startFakeCloud>, env: Record<string, string>) => Promise<void>,
) {
  const cloud = startFakeCloud({ appExists: true, ...options });
  try {
    await run(cloud, { SPROUTBOAT_API_URL: cloud.url, SPROUTBOAT_API_TOKEN: FAKE_KEY });
  } finally {
    cloud.stop();
  }
}

const gets = (cloud: ReturnType<typeof startFakeCloud>) =>
  cloud.calls.filter((c) => c.method === "GET" && c.path === "/v1/apps/hello").length;

describe("secret put and delete on the Cloud", () => {
  test("put waits for a host to apply the new version, and `secret` is `secrets`", async () => {
    await withCloud({}, async (cloud, env) => {
      const run = await cli(project(), ["secret", "put", "API_KEY", "--value", "s3cret-value"], env);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("set API_KEY on hello; a new version is live (generation 1)");
      expect(cloud.secrets).toEqual({ API_KEY: "s3cret-value" });
      expect(gets(cloud)).toBeGreaterThan(0);
      expect(run.stdout + run.stderr).not.toContain("s3cret-value");
      expect((await cli(project(), ["secret", "list"], env)).stdout).toContain("API_KEY");
    });
  });

  test("--no-deploy returns as soon as the write is stored, without waiting for a host", async () => {
    await withCloud({}, async (cloud, env) => {
      const run = await cli(project(), ["secrets", "put", "API_KEY", "--no-deploy"], env, "from-stdin\n");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("applies when a host picks up the new record");
      expect(cloud.secrets).toEqual({ API_KEY: "from-stdin" });
      expect(gets(cloud)).toBe(0);
    });
  });

  test("a host that fails to apply the version is an error with the host's reason", async () => {
    await withCloud({ applyStates: ["failed"] }, async (_cloud, env) => {
      const run = await cli(project(), ["secrets", "put", "API_KEY", "--value", "x"], env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("the host did not apply generation 1 (failed): module failed to load");
    });
  });

  test("delete waits too, and an app that is not deployed says to deploy first", async () => {
    await withCloud({ existingSecrets: { OLD_KEY: "x" } }, async (cloud, env) => {
      const run = await cli(project(), ["secrets", "delete", "OLD_KEY"], env);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("removed OLD_KEY from hello; a new version is live");
      expect(cloud.secrets).toEqual({});
    });
    await withCloud({ appExists: false }, async (_cloud, env) => {
      const run = await cli(project(), ["secrets", "put", "API_KEY", "--value", "x"], env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("hello is not deployed yet");
    });
  });
});

describe("secret bulk", () => {
  test("a JSON file sets and deletes in one PATCH, one new version", async () => {
    await withCloud({ existingSecrets: { OLD_KEY: "old", KEEP: "k" } }, async (cloud, env) => {
      const dir = project();
      writeFileSync(join(dir, "secrets.json"), `{ "API_KEY": "abc", "DB_URL": "postgres://x", "OLD_KEY": null }`);
      const run = await cli(dir, ["secret", "bulk", "secrets.json"], env);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("2 set, 1 deleted on hello; a new version is live (generation 1)");
      expect(cloud.patches).toEqual([{ set: { API_KEY: "abc", DB_URL: "postgres://x" }, delete: ["OLD_KEY"] }]);
      expect(cloud.secrets).toEqual({ API_KEY: "abc", DB_URL: "postgres://x", KEEP: "k" });
      expect(run.stdout + run.stderr).not.toContain("postgres://x");
    });
  });

  test("a .env file from stdin, and --no-deploy", async () => {
    await withCloud({}, async (cloud, env) => {
      const run = await cli(project(), ["secrets", "bulk", "--no-deploy"], env, "A_KEY=1\nB_KEY=two\nEMPTY=\n");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("2 set, 0 deleted on hello; applies when a host picks up the new record");
      expect(run.stderr).toContain("not sent, empty value: EMPTY");
      expect(cloud.patches).toEqual([{ set: { A_KEY: "1", B_KEY: "two" } }]);
      expect(gets(cloud)).toBe(0);
    });
  });

  test("bad input is refused before any request, by name", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      writeFileSync(join(dir, "bad.json"), `{ "lower": "v" }`);
      const run = await cli(dir, ["secrets", "bulk", "bad.json"], env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("not valid: lower");
      expect((await cli(dir, ["secrets", "bulk", "missing.json"], env)).stderr).toContain(
        "missing.json: cannot read the file",
      );
      expect(cloud.patches).toEqual([]);
    });
  });
});

describe("self-hosted Community", () => {
  test("bulk is one call per name and says it applies on the next deploy", async () => {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/config") return new Response("not found", { status: 404 });
        calls.push(`${request.method} ${url.pathname}`);
        return Response.json({ ok: true });
      },
    });
    try {
      const dir = project();
      writeFileSync(join(dir, "s.json"), `{ "A_KEY": "1", "B_KEY": null }`);
      const run = await cli(dir, ["secret", "bulk", "s.json", "--no-deploy"], {
        SPROUTBOAT_API_URL: `http://127.0.0.1:${server.port}`,
        SPROUTBOAT_TOKEN: "tok",
      });
      expect(run.code).toBe(0);
      expect(calls).toEqual(["PUT /api/projects/hello/secrets/A_KEY", "DELETE /api/projects/hello/secrets/B_KEY"]);
      expect(run.stdout).toContain("applies them on the next deploy or restart of the app");
    } finally {
      server.stop(true);
    }
  });
});

describe("global flags and unknown options", () => {
  test("--profile picks the stored Cloud login; -c and --cwd find the project", async () => {
    const cloud = startFakeCloud({ appExists: true, existingSecrets: { OLD_KEY: "x" } });
    const login = fakeLogin(cloud.url);
    roots.push(login.dir);
    const dir = project();
    const elsewhere = mkdtempSync(join(tmpdir(), "sb-secrets-elsewhere-"));
    roots.push(elsewhere);
    try {
      for (const args of [
        ["secrets", "list", "--profile", login.profile],
        ["--profile", login.profile, "secret", "list"],
        ["secrets", "list", `--profile=${login.profile}`],
      ]) {
        const run = await cli(dir, args, login.env);
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain("OLD_KEY");
      }
      const byConfig = await cli(
        elsewhere,
        ["secrets", "list", "-c", join(dir, "sproutboat.jsonc"), "--profile", login.profile],
        login.env,
      );
      expect(byConfig.stdout).toContain("OLD_KEY");
      const byCwd = await cli(
        elsewhere,
        ["--cwd", dir, "secrets", "put", "NEW_KEY", "--value", "-e", "--no-deploy", "--profile", login.profile],
        login.env,
      );
      expect(byCwd.code, byCwd.stderr).toBe(0);
      expect(cloud.secrets.NEW_KEY).toBe("-e");
      // The decoy default is not used when nothing names the profile, so this cannot reach the Cloud.
      expect((await cli(dir, ["secrets", "list"], login.env)).code).toBe(1);
    } finally {
      cloud.stop();
    }
  });

  test("an unknown option is an error, never a quiet no-op or a secret's value", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      for (const args of [
        ["secrets", "put", "API_KEY", "--vlaue", "oops"],
        ["secrets", "list", "--json"],
        ["secrets", "delete", "API_KEY", "--force"],
        ["secrets", "bulk", "--dry-run"],
      ]) {
        const run = await cli(dir, args, env, "{}");
        expect(run.code, args.join(" ")).toBe(2);
        expect(run.stderr).toContain("unknown option");
      }
      expect(cloud.secrets).toEqual({});
    });
  });

  test("--api-url reaches a Community control plane for put as well as bulk", async () => {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/config") return new Response("not found", { status: 404 });
        calls.push(`${request.method} ${url.pathname}`);
        return Response.json({ ok: true });
      },
    });
    try {
      const dir = project();
      const run = await cli(
        dir,
        ["secrets", "put", "A_KEY", "--value", "1", "--api-url", `http://127.0.0.1:${server.port}`],
        { SPROUTBOAT_API_URL: "", SPROUTBOAT_TOKEN: "tok" },
      );
      expect(run.code, run.stderr).toBe(0);
      expect(calls).toEqual(["PUT /api/projects/hello/secrets/A_KEY"]);
    } finally {
      server.stop(true);
    }
  });
});
