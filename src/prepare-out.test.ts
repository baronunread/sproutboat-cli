import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");

async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", MAIN, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("deploy --prepare-out", () => {
  let root: string;
  let project: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "prepare-out-"));
    project = join(root, "site");
    mkdirSync(join(project, "dist"), { recursive: true });
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(
      join(project, "sproutboat.jsonc"),
      JSON.stringify({
        name: "demo-site",
        main: "src/index.js",
        compatibility_date: "2026-11-18",
        kv_namespaces: [{ binding: "LIVE", id: "kv_07eda0cba339cb78383f6b8d" }],
        triggers: { crons: ["* * * * *"] },
        services: [{ binding: "PEER", service: "other-app" }],
        assets: { directory: "dist", binding: "ASSETS", not_found_handling: "404-page" },
      }),
    );
    writeFileSync(join(project, "dist", "index.html"), "<h1>hi</h1>\n");
    writeFileSync(join(project, "dist", "a.css"), "a{}\n");
    writeFileSync(
      join(project, "src", "index.js"),
      'export default { async fetch() { return new Response("ok"); } };\n',
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("writes the source, build.json, a spec with service bindings by name, the manifest and each blob once, without any network or login", async () => {
    const out = join(root, "out");
    // A dead API address and no credentials: nothing may be contacted or asked.
    const r = await run(["deploy", project, "--prepare-out", out], {
      SPROUTBOAT_API_URL: "http://127.0.0.1:9",
      SPROUTBOAT_API_TOKEN: "",
      HOME: join(root, "home"),
    });
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(out, "sprout.generated.js"), "utf8").length).toBeGreaterThan(1000);
    expect(JSON.parse(readFileSync(join(out, "build.json"), "utf8"))).toMatchObject({ v: 1, name: "demo-site" });
    const spec = JSON.parse(readFileSync(join(out, "spec.json"), "utf8"));
    expect(spec.compatibility_date).toBe("2026-11-18");
    expect(spec.crons).toEqual(["* * * * *"]);
    expect(spec.services).toEqual([{ binding: "PEER", service: "other-app" }]); // names only: resolving them needs the team's apps
    expect(spec.bindings.map((b: { name: string }) => b.name)).toEqual(["LIVE", "ASSETS"]);
    expect(JSON.stringify(spec)).not.toContain("secret");
    const manifest = JSON.parse(readFileSync(join(out, "assets", "manifest.json"), "utf8"));
    // SAFETY: the manifest was just parsed from the file this test asked the CLI to write; every entry has a hash (checked by the digest loop below).
    const hashes = Object.values(manifest.files).map((f) => (f as { hash: string }).hash);
    expect(readdirSync(join(out, "assets", "blobs")).sort()).toEqual([...new Set(hashes)].sort());
    for (const h of hashes)
      expect(
        createHash("sha256")
          .update(readFileSync(join(out, "assets", "blobs", h)))
          .digest("hex"),
      ).toBe(h);
  });

  test("refuses what a Cloud deploy would refuse, before writing anything", async () => {
    writeFileSync(
      join(project, "sproutboat.jsonc"),
      JSON.stringify({
        name: "demo-site",
        main: "src/index.js",
        compatibility_date: "2026-08-31",
        services: [{ binding: "PEER", service: "other-app" }],
      }),
    );
    const out = join(root, "out2");
    const r = await run(["deploy", project, "--prepare-out", out], { HOME: join(root, "home") });
    expect(r.code).toBe(1);
    expect(r.err).toContain("2026-11-18");
    expect(() => readdirSync(out)).toThrow();
  });
});
