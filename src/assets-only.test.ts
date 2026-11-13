import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSETS_ONLY_MAIN, assetsOnlySource, parseProjectConfig } from "./account-field";
import { FAKE_KEY, startFakeCloud } from "./cloud-fake";

const config = (extra: string) => `{ "name": "static-demo", "compatibility_date": "2026-11-18", ${extra} }`;

describe("a project with assets and no main", () => {
  test("is a Worker with only static assets: the entry and the assets binding are filled in", () => {
    const parsed = parseProjectConfig(config(`"assets": { "directory": "public" }`));
    expect(parsed).toMatchObject({
      ok: true,
      value: { main: ASSETS_ONLY_MAIN, assets: { directory: "public", binding: "ASSETS" } },
    });
  });

  test("keeps the binding and not_found_handling the config names, and works beside the CLI-owned fields", () => {
    const parsed = parseProjectConfig(
      config(
        `"account": "acme", "migrations_dir": "db", "assets": { "directory": "dist", "binding": "SITE", "not_found_handling": "single-page-application" }`,
      ),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        main: ASSETS_ONLY_MAIN,
        assets: { directory: "dist", binding: "SITE", not_found_handling: "single-page-application" },
      },
    });
  });

  test("a main the config names is left alone, and no assets with no main is still an error", () => {
    expect(parseProjectConfig(config(`"main": "src/index.js", "assets": { "directory": "public" }`))).toMatchObject({
      ok: true,
      value: { main: "src/index.js", assets: { directory: "public" } },
    });
    const bare = parseProjectConfig(config(`"vars": {}`));
    expect(bare.ok).toBe(false);
    expect(bare.ok ? [] : bare.errors).toContain("main must be a relative entry point under src/");
  });

  test("the entry hands every request that matched no file to the assets binding", () => {
    expect(assetsOnlySource("SITE")).toContain("return env.SITE.fetch(request);");
  });
});

describe("the CLI on an assets-only project", () => {
  const main = join(import.meta.dir, "main.ts");
  let project: string;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "sb-static-"));
    await mkdir(join(project, "public"));
    await writeFile(join(project, "public", "index.html"), "<h1>hi</h1>");
    await writeFile(join(project, "public", "404.html"), "<h1>not here</h1>");
    await writeFile(
      join(project, "sproutboat.jsonc"),
      config(`"assets": { "directory": "public", "not_found_handling": "404-page" }`),
    );
  });
  afterEach(() => rm(project, { recursive: true, force: true }));

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

  test("check passes and says the project is assets only", async () => {
    const out = await run(["check"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("static-demo (assets only, native-fetch)");
    expect(await readFile(join(project, ".sproutboat", "assets-only.js"), "utf8")).toBe(assetsOnlySource("ASSETS"));
  });

  test("a Cloud deploy uploads the generated entry and the assets, with the assets binding in the record", async () => {
    await writeFile(
      join(project, "sproutboat.jsonc"),
      config(`"account": "acme", "assets": { "directory": "public", "not_found_handling": "404-page" }`),
    );
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await run(["deploy"], { SPROUTBOAT_API_URL: cloud.url, SPROUTBOAT_API_TOKEN: FAKE_KEY });
      expect(out.stderr).toBe("");
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("Bundling   assets only");
      const [source] = [...cloud.sources.values()];
      expect(new TextDecoder().decode(source)).toContain("env.ASSETS.fetch");
      expect(cloud.blobs.size).toBe(2);
      expect(cloud.buildRequests[0]).toMatchObject({
        spec: { bindings: [{ name: "ASSETS", kind: "assets" }] },
      });
    } finally {
      cloud.stop();
    }
  });
});
