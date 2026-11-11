import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudIo } from "./cloud";
import { buildAndDeploy } from "./cloud-deploy";
import { FAKE_KEY, startFakeCloud, type FakeOptions } from "./cloud-fake";

const MAIN = join(import.meta.dir, "main.ts");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const io: CloudIo = {
  log: () => {},
  warn: () => {},
  interactive: false,
  openUrl: () => true,
  sleep: async () => {},
  choose: async (_q, choices) => choices[0]!,
};

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-deployments-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "sproutboat.jsonc"),
    `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07" }`,
  );
  writeFileSync(join(dir, "sprout.generated.js"), "export default { fetch() { return new Response('hi'); } };\n");
  return dir;
}

const env = (url: string) => ({ SPROUTBOAT_API_URL: url, SPROUTBOAT_API_TOKEN: FAKE_KEY });

function spawnCli(dir: string, args: string[], extra: Record<string, string>) {
  return Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1", SPROUTBOAT_NO_UPDATE_CHECK: "1", SPROUTBOAT_TOKEN: "", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function cli(dir: string, args: string[], extra: Record<string, string>) {
  const child = spawnCli(dir, args, extra);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function deploy(dir: string, cloud: ReturnType<typeof startFakeCloud>, times: number) {
  for (let i = 0; i < times; i++)
    await buildAndDeploy(
      {
        apiUrl: cloud.url,
        token: FAKE_KEY,
        tokenFromEnv: false,
        project: "hello",
        hosts: ["hello.acme.sproutboat.app"],
        sourcePath: join(dir, "sprout.generated.js"),
        cli: { version: "9.9.9" },
        noWait: false,
      },
      io,
    );
}

async function withCloud(
  options: FakeOptions,
  run: (cloud: ReturnType<typeof startFakeCloud>, dir: string) => Promise<void>,
) {
  const cloud = startFakeCloud(options);
  try {
    await run(cloud, project());
  } finally {
    cloud.stop();
  }
}

describe("deployments on the Cloud", () => {
  test("list shows the builds newest first with the live one marked, and --json", async () => {
    await withCloud({}, async (cloud, dir) => {
      await deploy(dir, cloud, 2);
      const run = await cli(dir, ["deployments", "list"], env(cloud.url));
      expect(run.code).toBe(0);
      const text = run.stdout;
      expect(text.indexOf("bld_2")).toBeLessThan(text.indexOf("bld_1"));
      expect(text).toContain("Generation:  2");
      expect(text.match(/live/g)).toHaveLength(1);
      expect(text.slice(text.indexOf("bld_2"), text.indexOf("bld_1"))).toContain("live");
      expect(cloud.calls.some((c) => c.path === "/v1/apps/hello/builds" && c.method === "GET")).toBe(true);
      const json = JSON.parse((await cli(dir, ["deployments", "list", "--json"], env(cloud.url))).stdout);
      expect(json.map((d: { id: string; live: boolean }) => [d.id, d.live])).toEqual([
        ["bld_2", true],
        ["bld_1", false],
      ]);
    });
  });

  test("status says what is live and whether a host applied it", async () => {
    await withCloud({}, async (cloud, dir) => {
      await deploy(dir, cloud, 1);
      const run = await cli(dir, ["deployments", "status"], env(cloud.url));
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Application:  hello");
      expect(run.stdout).toContain("applied by a host");
      expect(run.stdout).toContain("bld_1  ready  (live)");
      const json = JSON.parse((await cli(dir, ["deployments", "status", "--json"], env(cloud.url))).stdout);
      expect(json).toMatchObject({
        application: "hello",
        live: { recordGeneration: 1, appliedGeneration: 1, state: "applied" },
        latest: { id: "bld_1" },
      });
    });
    await withCloud({ appExists: false }, async (cloud, dir) => {
      expect((await cli(dir, ["deployments", "status"], env(cloud.url))).stdout).toContain("hello is not deployed yet");
      expect((await cli(dir, ["deployments", "list"], env(cloud.url))).stdout).toContain("no deployments of hello yet");
    });
  });

  test("tail follows a finished build from its first log line and exits 0", async () => {
    await withCloud({}, async (cloud, dir) => {
      await deploy(dir, cloud, 1);
      const run = await cli(dir, ["deployments", "tail", "bld_1"], env(cloud.url));
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("porffor: compiled in 1.0 s");
      expect(run.stdout).toContain("ready; record generation 1");
    });
  });

  test("tail of a failed build exits 1 with the reason; an unknown id says so", async () => {
    await withCloud({ build: { mode: "failed" } }, async (cloud, dir) => {
      await buildAndDeploy(
        {
          apiUrl: cloud.url,
          token: FAKE_KEY,
          tokenFromEnv: false,
          project: "hello",
          hosts: ["h.example"],
          sourcePath: join(dir, "sprout.generated.js"),
          cli: { version: "9.9.9" },
          noWait: true,
        },
        io,
      );
      const run = await cli(dir, ["deployments", "tail", "bld_1"], env(cloud.url));
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("failed: porffor: unsupported syntax at index.js:3");
      const missing = await cli(dir, ["deployments", "tail", "bld_99"], env(cloud.url));
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('no deployment "bld_99" in this team');
      expect((await cli(dir, ["deployments", "tail"], env(cloud.url))).code).toBe(2);
    });
  });

  test("Ctrl-C while tailing detaches: exit 130, and the build is not cancelled", async () => {
    await withCloud({ build: { mode: "hang" } }, async (cloud, dir) => {
      await buildAndDeploy(
        {
          apiUrl: cloud.url,
          token: FAKE_KEY,
          tokenFromEnv: false,
          project: "hello",
          hosts: ["h.example"],
          sourcePath: join(dir, "sprout.generated.js"),
          cli: { version: "9.9.9" },
          noWait: true,
        },
        io,
      );
      const child = spawnCli(dir, ["deployments", "tail", "bld_1"], env(cloud.url));
      const reader = child.stdout.getReader();
      let seen = "";
      while (!seen.includes("porffor: compiled")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      child.kill("SIGINT");
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(130);
      expect(stderr).toContain("detached: the deployment keeps running");
      expect(cloud.cancels).toEqual([]);
    });
  });

  test("a usage mistake is exit 2", async () => {
    await withCloud({}, async (cloud, dir) => {
      expect((await cli(dir, ["deployments"], env(cloud.url))).code).toBe(2);
      expect((await cli(dir, ["deployments", "wat"], env(cloud.url))).code).toBe(2);
      expect((await cli(dir, ["deployments", "list", "extra"], env(cloud.url))).code).toBe(2);
    });
  });
});

describe("deployments on self-hosted Community", () => {
  async function withCommunity(run: (url: string, dir: string) => Promise<void>) {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/projects/hello/deployments")
          return Response.json([
            { id: "d2", artifact: "b".repeat(64), deployedAt: "2026-11-02T00:00:00Z", active: true },
            { id: "d1", artifact: "a".repeat(64), deployedAt: "2026-11-01T00:00:00Z", active: false },
          ]);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await run(`http://127.0.0.1:${server.port}`, project());
    } finally {
      server.stop(true);
    }
  }
  const community = (url: string) => ({ SPROUTBOAT_API_URL: url, SPROUTBOAT_TOKEN: "tok" });

  test("list and status read the project's versions; tail has nothing to follow", async () => {
    await withCommunity(async (url, dir) => {
      const list = await cli(dir, ["deployments", "list"], community(url));
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("d2  ✓ active");
      expect(list.stdout).toContain("d1");
      expect(JSON.parse((await cli(dir, ["deployments", "status", "--json"], community(url))).stdout)).toMatchObject({
        id: "d2",
        active: true,
      });
      const tail = await cli(dir, ["deployments", "tail", "d2"], community(url));
      expect(tail.code).toBe(1);
      expect(tail.stderr).toContain("not supported on self-hosted Community");
    });
  });
});
