import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("management commands work without application source or build artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sb-management-"));
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (request.headers.get("x-api-key") !== "test-token") return new Response("unauthorized", { status: 401 });
      if (path.endsWith("/activate")) return Response.json({ url: "https://example.test" });
      if (path.includes("/logs/")) return new Response("example log\n");
      if (path.endsWith("/v1")) return Response.json({ id: "v1", active: true });
      return Response.json([{ id: "v1", artifact: "artifact", deployedAt: "2026-09-09", active: true }]);
    },
  });
  try {
    await writeFile(
      join(directory, "sproutboat.jsonc"),
      JSON.stringify({
        name: "management-test",
        main: "src/missing-entry.js",
        compatibility_date: "2026-09-07",
      }),
    );
    for (const args of [
      ["versions", "list"],
      ["versions", "view", "v1"],
      ["rollback", "v1"],
      ["tail"],
      ["tail", "--sprout"],
    ]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args, directory], {
        env: {
          ...process.env,
          SPROUTBOAT_API_URL: `http://127.0.0.1:${server.port}`,
          SPROUTBOAT_TOKEN: "test-token",
          SPROUTBOAT_NO_UPDATE_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 5000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ command: args.join(" "), code, stderr }).toEqual({ command: args.join(" "), code: 0, stderr: "" });
        expect(stdout.length).toBeGreaterThan(0);
      } finally {
        clearTimeout(timeout);
        child.kill();
      }
    }
    expect(requests).toEqual([
      "GET /api/projects/management-test/deployments",
      "GET /api/projects/management-test/deployments/v1",
      "POST /api/projects/management-test/deployments/v1/activate",
      "GET /api/projects/management-test/logs/recent",
      "GET /api/projects/management-test/logs/sprout",
    ]);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("init scaffolds a sproutboat.jsonc pointing at the published schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sb-init-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "init", "hello"], {
      cwd: directory,
      env: { ...process.env, SPROUTBOAT_NO_UPDATE_CHECK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const config = JSON.parse(await Bun.file(join(directory, "hello", "sproutboat.jsonc")).text());
    // #196 — sproutboat.com/schema.json used to 404; this only regresses if the
    // published schema is ever pulled without updating the scaffold to match.
    expect(config.$schema).toBe("https://sproutboat.com/schema.json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// baronunread/sproutboat#204 — logging into a second endpoint used to
// silently repoint the machine-wide active endpoint, so `whoami` and `deploy`
// could disagree about which endpoint an unrelated project would target.
test("login to a second endpoint keeps whoami reporting the first, with the source", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sb-login-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ profile: { username: "prod-account" }, user: { email: "prod@example.test" } }),
  });
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    SPROUTBOAT_CONFIG_DIR: configDirectory,
    SPROUTBOAT_NO_UPDATE_CHECK: "1",
    ...extra,
  });
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
      env: env(extra),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    const prodUrl = `http://127.0.0.1:${server.port}`;
    const first = await run(["login", "--api-url", prodUrl, "--token", "prod-token"]);
    expect(first).toEqual({
      code: 0,
      stdout: expect.stringContaining(`endpoint  ${prodUrl}  (--api-url)`),
      stderr: "",
    });
    expect(first.stdout).not.toContain("active endpoint remains");

    const second = await run(["login", "--api-url", "http://127.0.0.1:1", "--token", "dev-token"]);
    expect(second.stdout).toContain(`active endpoint remains ${prodUrl}`);

    const who = await run(["whoami"]);
    expect(who).toEqual({
      code: 0,
      stdout: expect.stringContaining(`endpoint  ${prodUrl}  (saved active endpoint)`),
      stderr: "",
    });
    expect(who.stdout).toContain("prod-account");
  } finally {
    server.stop(true);
    await rm(configDirectory, { recursive: true, force: true });
  }
}, 30000);
