import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config";
import { checkTypes, parseTypesArgs, planTypes, refreshTypes } from "./types-cmd";
import { LEGACY_TYPES_HEADER } from "./types-gen";

describe("parseTypesArgs", () => {
  test("no arguments: the defaults", () => {
    expect(parseTypesArgs([])).toEqual({ options: {}, check: false });
  });

  test("the positional is the output path", () => {
    expect(parseTypesArgs(["types/env.d.ts"])).toEqual({ options: {}, check: false, positional: "types/env.d.ts" });
  });

  test("--flag=value arrives as --flag value, and booleans take true or false", () => {
    expect(parseTypesArgs(["--strict-vars", "false", "--include-runtime", "false", "--include-env", "true"])).toEqual({
      options: { strictVars: false, includeRuntime: false, includeEnv: true },
      check: false,
    });
    expect(parseTypesArgs(["--env-interface", "MyEnv", "--check"])).toEqual({
      options: { envInterface: "MyEnv" },
      check: true,
    });
  });

  test("a bare boolean flag means true, and the --no- forms mean false", () => {
    expect(parseTypesArgs(["--strict-vars"])).toEqual({ options: { strictVars: true }, check: false });
    expect(parseTypesArgs(["--no-strict-vars", "--no-include-runtime", "--no-include-env"])).toEqual({
      options: { strictVars: false, includeRuntime: false, includeEnv: false },
      check: false,
    });
  });

  test("refuses what it cannot read", () => {
    expect(parseTypesArgs(["--env-interface"])).toEqual({ error: "--env-interface needs a name" });
    expect(parseTypesArgs(["--env-interface", "not valid"])).toEqual({
      error: '"not valid" is not a valid interface name',
    });
    expect(parseTypesArgs(["--strict-vars", "maybe"])).toEqual({
      error: '--strict-vars takes true or false, not "maybe"',
    });
    expect(parseTypesArgs(["a.d.ts", "b.d.ts"])).toEqual({ error: 'unexpected argument "b.d.ts"' });
    expect(parseTypesArgs(["--wat"])).toEqual({ error: "unknown option --wat" });
  });
});

let root: string;
const config = (source: string) => {
  const parsed = parseConfig(source);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-types-cmd-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/index.ts"),
    "export class Counter {}\nexport default { fetch() { return new Response(); } };\n",
  );
  await writeFile(join(root, "src/index.js"), "export class Counter {}\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const TS =
  '{ "name": "demo", "main": "src/index.ts", "compatibility_date": "2026-11-18", "durable_objects": { "C": "Counter" } }';

describe("planTypes", () => {
  test("writes worker-configuration.d.ts in the project, and types the Durable Object from a TypeScript entry", async () => {
    const plan = await planTypes({ options: {}, check: false }, config(TS), root, root);
    expect(plan.path).toBe(join(root, "worker-configuration.d.ts"));
    expect(plan.legacyDirectory).toBe(false);
    expect(plan.text).toContain('C: DurableObjectNamespaceAsync<import("./src/index").Counter>;');
  });

  test("a JavaScript entry leaves the namespace untyped: its types would be any", async () => {
    const plan = await planTypes(
      { options: {}, check: false },
      config(TS.replace("src/index.ts", "src/index.js")),
      root,
      root,
    );
    expect(plan.text).toContain("C: DurableObjectNamespaceAsync; /* Counter */");
  });

  test("a path argument is relative to the working directory, and the import path is relative to the file", async () => {
    const plan = await planTypes({ options: {}, check: false, positional: "types/env.d.ts" }, config(TS), root, root);
    expect(plan.path).toBe(join(root, "types/env.d.ts"));
    expect(plan.text).toContain('import("../src/index").Counter');
    expect(plan.text).toContain("by running `sproutboat types types/env.d.ts` (hash:");
  });

  test("a positional that is an existing directory is the project directory, as it was before", async () => {
    const plan = await planTypes({ options: {}, check: false, positional: root }, config(TS), root, tmpdir());
    expect(plan.legacyDirectory).toBe(true);
    expect(plan.path).toBe(join(root, "worker-configuration.d.ts"));
  });

  test("flags that differ from the defaults are recorded, the defaults are not", async () => {
    const plan = await planTypes(
      { options: { envInterface: "MyEnv", strictVars: false, includeRuntime: false }, check: false },
      config(TS),
      root,
      root,
    );
    expect(plan.text).toContain(
      "`sproutboat types --env-interface=MyEnv --strict-vars=false --include-runtime=false` (hash:",
    );
    const plain = await planTypes(
      { options: { strictVars: true, envInterface: "Env" }, check: false },
      config(TS),
      root,
      root,
    );
    expect(plain.text).toContain("by running `sproutboat types` (hash:");
  });
});

describe("checkTypes", () => {
  test("missing, current, and stale", async () => {
    const plan = await planTypes({ options: {}, check: false, positional: "check.d.ts" }, config(TS), root, root);
    expect(await checkTypes(plan)).toBe("missing");
    await writeFile(plan.path, plan.text);
    expect(await checkTypes(plan)).toBe("current");
    const changed = await planTypes(
      { options: {}, check: false, positional: "check.d.ts" },
      config(TS.replace('"durable_objects"', '"kv_namespaces": ["KV"], "durable_objects"')),
      root,
      root,
    );
    expect(await checkTypes(changed)).toBe("stale");
    await writeFile(plan.path, "// written by hand\n");
    expect(await checkTypes(plan)).toBe("stale");
  });

  test("the legacy header is the line earlier releases wrote", () => {
    expect(LEGACY_TYPES_HEADER).toBe("// Generated by `sproutboat types`. Do not edit.");
  });
});

describe("refreshTypes, for dev and deploy", () => {
  const plain = config(TS);

  const dir = async () => {
    const project = await mkdtemp(join(tmpdir(), "sb-types-refresh-"));
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src/index.ts"), "export class Counter {}\n");
    return project;
  };

  test("a project with no tsconfig and no file gets none", async () => {
    const project = await dir();
    expect(await refreshTypes(project, plain)).toEqual({ wrote: false, removedLegacy: false });
    expect(existsSync(join(project, "worker-configuration.d.ts"))).toBe(false);
    await rm(project, { recursive: true });
  });

  test("a project with a tsconfig gets the file, and then nothing more until the config changes", async () => {
    const project = await dir();
    await writeFile(join(project, "tsconfig.json"), "{}");
    expect(await refreshTypes(project, plain)).toEqual({ wrote: true, removedLegacy: false });
    expect(await refreshTypes(project, plain)).toEqual({ wrote: false, removedLegacy: false });
    const more = config(TS.replace('"durable_objects"', '"kv_namespaces": ["KV"], "durable_objects"'));
    expect(await refreshTypes(project, more)).toEqual({ wrote: true, removedLegacy: false });
    expect(await readFile(join(project, "worker-configuration.d.ts"), "utf8")).toContain("KV: KVNamespaceAsync;");
    await rm(project, { recursive: true });
  });

  test("a file made with other flags, or by hand, is left alone", async () => {
    const project = await dir();
    const path = join(project, "worker-configuration.d.ts");
    const custom = await planTypes({ options: { strictVars: false }, check: false }, plain, project, project);
    await writeFile(path, custom.text);
    expect(
      await refreshTypes(
        project,
        config(TS.replace('"durable_objects"', '"kv_namespaces": ["KV"], "durable_objects"')),
      ),
    ).toEqual({
      wrote: false,
      removedLegacy: false,
    });
    expect(await readFile(path, "utf8")).toBe(custom.text);
    await writeFile(path, "// mine\n");
    expect((await refreshTypes(project, plain)).wrote).toBe(false);
    await rm(project, { recursive: true });
  });

  test("the file earlier releases wrote goes when its replacement is written", async () => {
    const project = await dir();
    await writeFile(join(project, "tsconfig.json"), "{}");
    await writeFile(join(project, "sproutboat-env.d.ts"), `${LEGACY_TYPES_HEADER}\n`);
    expect(await refreshTypes(project, plain)).toEqual({ wrote: true, removedLegacy: true });
    expect(existsSync(join(project, "sproutboat-env.d.ts"))).toBe(false);
    await rm(project, { recursive: true });
  });
});
