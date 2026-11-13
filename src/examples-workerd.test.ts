/**
 * The examples are standard Cloudflare Workers, and these two tests are what say so in CI (the `check` job runs
 * `bun test`): every example's generated types are current and typecheck, and every example runs unchanged under
 * workerd, typechecked against Cloudflare's own runtime types, answering the requests in examples/checks.ts.
 * What is skipped is printed with its reason by the runner. See "Rules for examples" in examples/README.md.
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

async function run(script: string, timeout: number) {
  const child = Bun.spawn([process.execPath, script], {
    cwd: REPO,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

test("every example's worker-configuration.d.ts is current and typechecks", async () => {
  const { code, output } = await run("examples/typecheck.ts", 240_000);
  expect(code, output).toBe(0);
}, 300_000);

test("every example runs unchanged under workerd and typechecks against Cloudflare's types", async () => {
  const { code, output } = await run("examples/workerd.ts", 540_000);
  expect(code, output).toBe(0);
  console.log(output.slice(output.indexOf("summary")));
}, 600_000);
