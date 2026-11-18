import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configWorkersDev, describePlatformName, parseProjectConfig, resolveWorkersDev } from "./account-field";
import { FAKE_KEY, startFakeCloud } from "./cloud-fake";

const config = (extra: string) =>
  `{ "name": "static-demo", "compatibility_date": "2026-11-18", "assets": { "directory": "public" }${extra === "" ? "" : `, ${extra}`} }`;

describe("workers_dev in the config", () => {
  test("is read as a boolean and does not reach the shared schema", () => {
    expect(configWorkersDev(config(`"workers_dev": false`))).toBe(false);
    expect(configWorkersDev(config(`"workers_dev": true`))).toBe(true);
    expect(configWorkersDev(config(""))).toBeUndefined();
    for (const value of [false, true]) {
      const parsed = parseProjectConfig(config(`"workers_dev": ${value}`));
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && "workers_dev" in parsed.value).toBe(false);
    }
  });

  test("works with comments and beside the other CLI-owned fields", () => {
    const source = `{
      // not served on <app>.<team>.sproutboat.app
      "name": "static-demo", "compatibility_date": "2026-11-18", "assets": { "directory": "public" },
      "account": "acme", "migrations_dir": "db", "workers_dev": false,
    }`;
    expect(configWorkersDev(source)).toBe(false);
    expect(parseProjectConfig(source).ok).toBe(true);
  });

  test("a value that is not a boolean is an error that names the field", () => {
    for (const value of [`"false"`, "0", "null", "[]"]) {
      const parsed = parseProjectConfig(config(`"workers_dev": ${value}`));
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? [] : parsed.errors).toContain("workers_dev must be true or false");
    }
  });

  test("route and routes are not config fields yet, so the default never turns false", () => {
    for (const key of ["route", "routes"]) {
      const parsed = parseProjectConfig(config(`"${key}": "example.com/*"`));
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? [] : parsed.errors).toContain(`unsupported config field: ${key}`);
    }
    expect(resolveWorkersDev(undefined)).toEqual({ enabled: true, from: "default" });
  });

  test("an explicit value wins, true or false", () => {
    expect(resolveWorkersDev(true)).toEqual({ enabled: true, from: "config" });
    expect(resolveWorkersDev(false)).toEqual({ enabled: false, from: "config" });
  });

  test("the deploy line says on or off and why", () => {
    const host = "static-demo.acme.sproutboat.app";
    expect(describePlatformName(resolveWorkersDev(undefined), "sproutboat.jsonc", host)).toBe(
      `https://${host}  (workers_dev is on by default: the config declares no routes)`,
    );
    expect(describePlatformName(resolveWorkersDev(true), "sproutboat.jsonc", host)).toBe(
      `https://${host}  (workers_dev: true in sproutboat.jsonc)`,
    );
    expect(describePlatformName(resolveWorkersDev(false), "wrangler.jsonc", host)).toBe(
      `off  (workers_dev: false in wrangler.jsonc; a deploy removes ${host} and keeps every other route)`,
    );
    expect(describePlatformName(resolveWorkersDev(false), "sproutboat.jsonc", undefined)).toContain(
      "removes the platform name",
    );
  });
});

describe("deploy and workers_dev", () => {
  const main = join(import.meta.dir, "main.ts");
  const PLATFORM = "static-demo.acme.sproutboat.app";
  let project: string;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "sb-workers-dev-"));
    await mkdir(join(project, "public"));
    await writeFile(join(project, "public", "index.html"), "<h1>hi</h1>");
  });
  afterEach(() => rm(project, { recursive: true, force: true }));

  const setConfig = (extra: string) =>
    writeFile(join(project, "sproutboat.jsonc"), config(`"account": "acme"${extra === "" ? "" : `, ${extra}`}`));
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, main, ...args], {
      cwd: project,
      env: { ...process.env, SPROUTBOAT_NO_UPDATE_CHECK: "1", SPROUTBOAT_API_TOKEN: "", SPROUTBOAT_TOKEN: "", ...env },
      stdin: "ignore",
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
  const deploy = (url: string, ...args: string[]) =>
    run(["deploy", ...args], { SPROUTBOAT_API_URL: url, SPROUTBOAT_API_TOKEN: FAKE_KEY });

  test("with no workers_dev the platform name is added, as before, and the line says it is the default", async () => {
    await setConfig("");
    const cloud = startFakeCloud({ teamKey: true, existingHosts: ["risulta.dev"] });
    try {
      const out = await deploy(cloud.url);
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain(`route     https://${PLATFORM}  (workers_dev is on by default`);
      expect(out.stdout).toContain(`https://${PLATFORM}`);
      expect(cloud.buildRequests[0]).toMatchObject({ spec: { hosts_patch: { add: [PLATFORM] } } });
      expect(cloud.spec.hosts).toEqual(["risulta.dev", PLATFORM]);
    } finally {
      cloud.stop();
    }
  });

  test("workers_dev true says it comes from the config", async () => {
    await setConfig(`"workers_dev": true`);
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await deploy(cloud.url);
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain("(workers_dev: true in sproutboat.jsonc)");
      expect(cloud.spec.hosts).toEqual([PLATFORM]);
    } finally {
      cloud.stop();
    }
  });

  test("workers_dev false removes the platform name, keeps the custom routes, and says where it is served now", async () => {
    await setConfig(`"workers_dev": false`);
    const cloud = startFakeCloud({ teamKey: true, existingHosts: [PLATFORM, "risulta.dev", "risulta.dev/blog"] });
    try {
      const out = await deploy(cloud.url);
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain(
        `route     off  (workers_dev: false in sproutboat.jsonc; a deploy removes ${PLATFORM}`,
      );
      expect(cloud.buildRequests[0]).toMatchObject({ spec: { hosts_patch: { remove: [PLATFORM] } } });
      expect(cloud.spec.hosts).toEqual(["risulta.dev", "risulta.dev/blog"]);
      expect(out.stdout).toContain(`not on ${PLATFORM}; routed on risulta.dev, risulta.dev/blog`);
      expect(out.stdout).not.toContain(`https://${PLATFORM}`);
    } finally {
      cloud.stop();
    }
  });

  test("workers_dev false on an app with no other route is allowed and says the app has no public address", async () => {
    await setConfig(`"workers_dev": false`);
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await deploy(cloud.url);
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain("no public address");
      expect(cloud.spec.hosts).toEqual([]);
    } finally {
      cloud.stop();
    }
  });

  test("--dry-run prints the line and sends nothing", async () => {
    await setConfig(`"workers_dev": false`);
    const cloud = startFakeCloud({ teamKey: true, existingHosts: [PLATFORM] });
    try {
      const out = await deploy(cloud.url, "--dry-run");
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain("route     off  (workers_dev: false in sproutboat.jsonc");
      expect(cloud.buildRequests).toEqual([]);
      expect(cloud.spec.hosts).toEqual([PLATFORM]);
    } finally {
      cloud.stop();
    }
  });

  test("a config file named with --config is read for workers_dev and named in the line", async () => {
    await writeFile(join(project, "wrangler.jsonc"), config(`"account": "acme", "workers_dev": false`));
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await run(["deploy", "--dry-run", "--config", "wrangler.jsonc"], {
        SPROUTBOAT_API_URL: cloud.url,
        SPROUTBOAT_API_TOKEN: FAKE_KEY,
      });
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toContain("route     off  (workers_dev: false in wrangler.jsonc");
    } finally {
      cloud.stop();
    }
  });

  test("--prepare-out writes workers_dev false into spec.json, and nothing when the name stays on", async () => {
    const env = { SPROUTBOAT_API_URL: "http://127.0.0.1:9", HOME: join(project, "home") };
    await setConfig(`"workers_dev": false`);
    const off = join(project, "off");
    const first = await run(["deploy", "--prepare-out", off], env);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("route     off  (workers_dev: false in sproutboat.jsonc");
    expect(JSON.parse(await readFile(join(off, "spec.json"), "utf8"))).toMatchObject({ workers_dev: false });

    await setConfig(`"workers_dev": true`);
    const on = join(project, "on");
    const second = await run(["deploy", "--prepare-out", on], env);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain("route     on  (workers_dev: true in sproutboat.jsonc)");
    expect(JSON.parse(await readFile(join(on, "spec.json"), "utf8"))).not.toHaveProperty("workers_dev");
  });

  test("a workers_dev that is not a boolean stops the deploy before anything is sent", async () => {
    await setConfig(`"workers_dev": "no"`);
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await deploy(cloud.url);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("workers_dev must be true or false");
      expect(cloud.calls.filter((c) => c.method !== "GET")).toEqual([]);
    } finally {
      cloud.stop();
    }
  });
});
