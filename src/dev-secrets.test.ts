import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Argument handling of `sproutboat dev` for secret input (#275). The files
// themselves are covered in env-file.test.ts; these end before any build.
async function withProject<T>(
  run: (dir: string, dev: (args: string[]) => Promise<{ code: number; text: string }>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sb-dev-secrets-"));
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "index.js"), "export default { fetch() { return new Response('x'); } };\n");
    await writeFile(
      join(dir, "sproutboat.jsonc"),
      JSON.stringify({ name: "app", main: "src/index.js", compatibility_date: "2026-09-28", secrets: ["API_KEY"] }),
    );
    const dev = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "dev", ...args], {
        cwd: dir,
        env: { ...process.env, SPROUTBOAT_NO_UPDATE_CHECK: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, text: out + err };
    };
    return await run(dir, dev);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("dev: an --env-file that does not exist stops the start; its path is not taken for the project directory", async () => {
  await withProject(async (dir, dev) => {
    const result = await dev(["--env-file", join(dir, "nope.env"), dir, "--no-watch"]);
    expect(result.code).toBe(1);
    expect(result.text).toContain("env file not found");
    expect(result.text).not.toContain("Building");
  });
});

test("dev: --env-file, --env and --port need a value, and --env takes a plain name", async () => {
  await withProject(async (dir, dev) => {
    for (const flag of ["--env-file", "--env", "--port"]) {
      const result = await dev([dir, flag]);
      expect(result.code).toBe(2);
      expect(result.text).toContain(`${flag} needs a value`);
    }
    const bad = await dev([dir, "--env", "../etc"]);
    expect(bad.code).toBe(2);
    expect(bad.text).toContain("--env takes a name");
  });
});
