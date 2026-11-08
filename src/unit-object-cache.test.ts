import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact } from "./build";
import { clearRenderedUnits } from "./compile";

test("clearRenderedUnits drops the previous render and keeps the objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-units-"));
  try {
    await mkdir(join(dir, "obj"));
    await writeFile(join(dir, "obj", "porf_runtime.o"), "object");
    await writeFile(join(dir, "obj", "porf_runtime.o.stamp"), "stamp");
    await writeFile(join(dir, "porf.h"), "header");
    await writeFile(join(dir, "shared-prelude.js.old.c"), "stale unit");
    await clearRenderedUnits(dir);
    expect((await readdir(dir)).sort()).toEqual(["obj"]);
    expect((await readdir(join(dir, "obj"))).sort()).toEqual(["porf_runtime.o", "porf_runtime.o.stamp"]);
    // a directory that does not exist yet is fine: the first build renders into it
    await clearRenderedUnits(join(dir, "missing"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A real host build (a minute or two cold), so it only runs when asked: SB_NATIVE_BUILD_TESTS=1 bun test src/unit-object-cache.test.ts
const native = process.env.SB_NATIVE_BUILD_TESTS === "1" ? test : test.skip;

native(
  "a warm rebuild hits the compile cache, a string edit leaves the prelude unit alone, a logic edit recompiles the main unit and no more than a few others",
  async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "sb-objcache-"));
    try {
      const config = { name: "objcache", main: "src/index.js", compatibility_date: "2026-10-01" };
      const sourcePath = join(projectDir, "src/index.js");
      const build = (source: string) =>
        buildArtifact({ projectDir, config, sourcePath, source, target: "host", transport: "embedded" });
      const objDir = join(projectDir, ".sproutboat/porffor-units/host-embedded-release/units-a22/obj");
      const mtimes = async () => {
        const out: Record<string, number> = {};
        for (const name of (await readdir(objDir)).filter((n) => n.endsWith(".o")))
          out[name] = (await stat(join(objDir, name))).mtimeMs;
        return out;
      };
      const changed = (before: Record<string, number>, after: Record<string, number>) =>
        Object.keys(after).filter((name) => before[name] !== after[name]);
      const literal = (text: string) => `export default { fetch() { return new Response("${text}"); } };`;

      const cold = await build(literal("one"));
      expect(cold.compileCache).toBe("miss");
      const objects = await mtimes();
      expect(Object.keys(objects).length).toBeGreaterThan(5);

      // same source: the compile cache answers, nothing is rendered or compiled
      const warm = await build(literal("one"));
      expect(warm.compileCache).toBe("hit");
      expect(changed(objects, await mtimes())).toEqual([]);

      // a string-literal edit: only the main unit changes
      const edited = await build(literal("two"));
      expect(edited.compileCache).toBe("miss");
      const afterLiteral = await mtimes();
      expect(changed(objects, afterLiteral).filter((name) => name.startsWith("porf__main"))).toHaveLength(1);
      // the unit holding the 7 MB prelude is untouched, which is the expensive one to recompile
      expect(changed(objects, afterLiteral).some((name) => name.startsWith("shared-prelude"))).toBe(false);
      expect(changed(objects, afterLiteral).length).toBeLessThanOrEqual(2);

      // a logic edit: new code can shift numbering in the other generated units, but never all of them
      await build(
        `export default { fetch(r) { const q = []; for (let i = 0; i < r.url.length; i++) q.push(i * 3); return new Response(q.join(",")); } };`,
      );
      const afterLogic = await mtimes();
      const logicChanged = changed(afterLiteral, afterLogic);
      expect(logicChanged.some((name) => name.startsWith("porf__main"))).toBe(true);
      expect(logicChanged.length).toBeLessThan(Object.keys(afterLogic).length);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  },
  600_000,
);
