/**
 * What a person gets from `sproutboat init --template <name>`, run: each starter is scaffolded by the real CLI into a
 * temp directory, typechecks there (the Worker against the generated types, the tests against Node's), and passes its
 * own tests against `sproutboat dev`, which is what `npm test` does in a new project. A package install is replaced
 * by two links and a launcher, so the test needs no network.
 *
 * `bun run examples` and `bun run examples:workerd` run the same tests against a standalone binary and workerd.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listTemplates } from "./templates";

const REPO = resolve(import.meta.dir, "..");
const MAIN = join(REPO, "src/main.ts");

async function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, NO_COLOR: "1", SPROUTBOAT_NO_UPDATE_CHECK: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 280_000,
    killSignal: "SIGKILL",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: (out + err).trim() };
}

/** Whether the `node` on PATH runs .ts files as they are (Node 22.18 and later), as the starters' `npm test` needs. */
async function nodeRunsTypeScript(): Promise<boolean> {
  const probe = await run(["node", "-p", "Boolean(process.features.typescript)"], REPO).catch(() => undefined);
  return probe?.code === 0 && probe.output === "true";
}

for (const { name } of listTemplates().filter((template) => template.name !== "hello")) {
  test(`${name}: a scaffolded project typechecks and passes its own tests against sproutboat dev`, async () => {
    const root = mkdtempSync(join(tmpdir(), `sb-run-${name}-`));
    try {
      const made = await run(
        [process.execPath, MAIN, "init", "app", "--template", name, "--no-install", "--no-git"],
        root,
      );
      expect(made.code, made.output).toBe(0);
      const project = join(root, "app");

      // What `npm install` would give it: the CLI on PATH for `npm test`, its types, and Node's types.
      mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
      const launcher = join(project, "node_modules/.bin/sproutboat");
      writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MAIN)} "$@"\n`);
      chmodSync(launcher, 0o755);
      symlinkSync(REPO, join(project, "node_modules/sproutboat"));
      symlinkSync(join(REPO, "node_modules/@types"), join(project, "node_modules/@types"));

      const tsc = join(REPO, "node_modules/.bin/tsc");
      const worker = await run([tsc, "-p", "."], project);
      expect(worker.code, worker.output).toBe(0);
      const tests = await run([tsc, "-p", "test"], project);
      expect(tests.code, tests.output).toBe(0);

      // The starter's own tests, which start `sproutboat dev` for the project on a free port.
      // Bun stops a hook after 5 s unless told otherwise, and the first `dev` build is longer than that.
      const bun = await run([process.execPath, "test", "--timeout", "240000", "test/"], project);
      expect(bun.code, bun.output).toBe(0);
      if (await nodeRunsTypeScript()) {
        const node = await run(
          ["node", "--test", ...(await Array.fromAsync(new Bun.Glob("test/*.test.ts").scan({ cwd: project })))],
          project,
        );
        expect(node.code, node.output).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
}
