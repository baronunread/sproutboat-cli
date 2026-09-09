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
