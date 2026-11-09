import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION } from "./report";
import { detectPackageManager, planPackageJson, runScriptCommand } from "./init-package";

async function init(cwd: string, name: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "init", name], {
    cwd,
    env: { ...process.env, SPROUTBOAT_NO_UPDATE_CHECK: "1", npm_config_user_agent: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function scratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sb-init-pkg-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("init in a fresh directory writes package.json with the CLI as a devDependency", () =>
  scratch(async (dir) => {
    const { code, stdout } = await init(dir, "hello");
    expect(code).toBe(0);
    const pkg = await Bun.file(join(dir, "hello", "package.json")).json();
    expect(pkg).toEqual({
      name: "hello",
      version: "0.0.0",
      private: true,
      scripts: { dev: "sproutboat dev", deploy: "sproutboat deploy", check: "sproutboat check" },
      devDependencies: { sproutboat: `^${CLI_VERSION}` },
    });
    expect(stdout).toContain("Created hello/package.json");
    expect(stdout).toContain("Next: cd hello && npm install && npm run dev");
  }));

test("init merges into an existing package.json and keeps its indentation and fields", () =>
  scratch(async (dir) => {
    await mkdir(join(dir, "hello"));
    await writeFile(
      join(dir, "hello", "package.json"),
      '{\n\t"name": "mine",\n\t"scripts": { "test": "vitest" },\n\t"devDependencies": { "vitest": "^3" }\n}\n',
    );
    const { code, stdout } = await init(dir, "hello");
    expect(code).toBe(0);
    const text = await Bun.file(join(dir, "hello", "package.json")).text();
    expect(text.startsWith('{\n\t"name": "mine"')).toBe(true);
    const pkg = JSON.parse(text);
    expect(pkg.name).toBe("mine");
    expect(pkg.scripts).toEqual({
      test: "vitest",
      dev: "sproutboat dev",
      deploy: "sproutboat deploy",
      check: "sproutboat check",
    });
    expect(pkg.devDependencies).toEqual({ sproutboat: `^${CLI_VERSION}`, vitest: "^3" });
    expect(stdout).toContain("Updated hello/package.json");
  }));

test("init never overwrites a script that already exists, and says so", () =>
  scratch(async (dir) => {
    await mkdir(join(dir, "hello"));
    await writeFile(
      join(dir, "hello", "package.json"),
      JSON.stringify({ scripts: { deploy: "node ship.js", dev: "sproutboat dev" } }),
    );
    const { code, stdout } = await init(dir, "hello");
    expect(code).toBe(0);
    const pkg = await Bun.file(join(dir, "hello", "package.json")).json();
    expect(pkg.scripts.deploy).toBe("node ship.js");
    expect(pkg.scripts.check).toBe("sproutboat check");
    expect(stdout).toContain('"deploy" script');
    expect(stdout).not.toContain('"dev" script');
  }));

test("init keeps an existing sproutboat range", () =>
  scratch(async (dir) => {
    await mkdir(join(dir, "hello"));
    await writeFile(join(dir, "hello", "package.json"), JSON.stringify({ dependencies: { sproutboat: "0.40.0" } }));
    expect((await init(dir, "hello")).code).toBe(0);
    const pkg = await Bun.file(join(dir, "hello", "package.json")).json();
    expect(pkg.dependencies.sproutboat).toBe("0.40.0");
    expect(pkg.devDependencies).toBeUndefined();
  }));

test("init refuses an unreadable package.json before writing anything", () =>
  scratch(async (dir) => {
    await mkdir(join(dir, "hello"));
    await writeFile(join(dir, "hello", "package.json"), "{ not json");
    const { code, stderr } = await init(dir, "hello");
    expect(code).toBe(1);
    expect(stderr).toContain("package.json");
    expect(await Bun.file(join(dir, "hello", "sproutboat.jsonc")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "hello", "package.json")).text()).toBe("{ not json");
  }));

test("init prints the next step for the package manager that launched it", () =>
  scratch(async (dir) => {
    const pnpm = await init(dir, "one", { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22" });
    expect(pnpm.stdout).toContain("Next: cd one && pnpm install && pnpm run dev");
    await mkdir(join(dir, "two"));
    await writeFile(join(dir, "two", "yarn.lock"), "");
    const yarn = await init(dir, "two", { npm_config_user_agent: "bun/1.3.0" });
    expect(yarn.stdout).toContain("Next: cd two && yarn install && yarn dev");
  }));

test("package manager detection: lockfile, then user agent, then npm", () =>
  scratch(async (dir) => {
    expect(detectPackageManager(dir, undefined)).toBe("npm");
    expect(detectPackageManager(dir, "bun/1.3.0 npm/? node/v24")).toBe("bun");
    expect(detectPackageManager(dir, "yarn/4.1.0 npm/? node/v22")).toBe("yarn");
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(dir, "bun/1.3.0")).toBe("pnpm");
    expect(runScriptCommand("bun", "dev")).toBe("bun run dev");
    expect(runScriptCommand("pnpm", "deploy")).toBe("pnpm run deploy");
    expect(runScriptCommand("yarn", "deploy")).toBe("yarn deploy");
  }));

test("planPackageJson rejects a package.json that is an array", () => {
  expect(() => planPackageJson("x", "[]", "1.0.0")).toThrow("package.json");
});
