/**
 * The rules in examples/README.md that can be checked without running anything: every example (and every fixture
 * that is plain Workers code) is written in the standard Workers style, is registered with the runners that hold it
 * to it, and has its generated types and documentation; examples/ holds nothing but examples. The runtime half
 * (workerd, Cloudflare's types) is `bun run examples:workerd`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHECKS,
  CLOUDFLARE_TYPES_SKIPS,
  SECRETS,
  STANDALONE_SKIPS,
  WORKERD_PARTIAL_SKIPS,
  WORKERD_SKIPS,
} from "../examples/checks";
import { EXAMPLES_DIR, projectDir, projects } from "../test/fixtures/lib/projects";
import { parseConfig } from "./config";
import { checkTypes, parseTypesArgs, planTypes } from "./types-cmd";

const all = projects();
const examples = all.map((project) => project.name);
const STANDARD_DATE = "2026-09-28";

/** Examples that are not TypeScript, and why. Each is a promise to fix it or to keep the reason true. */
const NOT_TYPESCRIPT = new Map<string, string>([
  [
    "kitchen-sink",
    "1,800 lines whose Code panels excerpt src/index.js between #region markers, run by a harness that compiles it unbundled",
  ],
]);

const read = (example: string) => {
  const parsed = parseConfig(readFileSync(join(projectDir(example), "sproutboat.jsonc"), "utf8"));
  if (!parsed.ok) throw new Error(`${example}: ${parsed.errors.join("; ")}`);
  return parsed.value;
};

describe("which directories are examples", () => {
  /** What may sit beside the examples in examples/: the runners and the tsconfig they share. */
  const RUNNERS = new Set(["checks.ts", "smoke.ts", "typecheck.ts", "workerd.ts", "README.md", "tsconfig.base.json"]);

  test("examples/ holds only examples: every directory is one (or groups some), and the rest is the runners", () => {
    for (const entry of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        const isExample = existsSync(join(EXAMPLES_DIR, entry.name, "sproutboat.jsonc"));
        const groups = examples.some((example) => example.startsWith(`${entry.name}/`));
        expect(
          isExample || groups,
          `examples/${entry.name} is neither an example nor a group of them; a fixture belongs in test/fixtures`,
        ).toBe(true);
      } else expect(RUNNERS.has(entry.name), `examples/${entry.name}`).toBe(true);
    }
    expect(examples).toContain("service-bindings/caller");
  });

  test("the fixtures that are not plain Workers code are not registered as projects", () => {
    for (const name of ["conformance", "stress", "runtime-comparison", "workers-verbatim", "workers-contract"])
      expect(
        examples.some((example) => example.includes(name)),
        name,
      ).toBe(false);
  });
});

describe("each example", () => {
  for (const example of examples) {
    describe(example, () => {
      const config = read(example);

      test("has a README and a tsconfig", () => {
        expect(existsSync(join(projectDir(example), "README.md")) || example.startsWith("service-bindings/")).toBe(
          true,
        );
        if (!NOT_TYPESCRIPT.has(example)) expect(existsSync(join(projectDir(example), "tsconfig.json"))).toBe(true);
      });

      test("is TypeScript, and at a compatibility date with the Workers handler arguments", () => {
        if (NOT_TYPESCRIPT.has(example)) expect(config.main).toMatch(/\.js$/);
        else expect(config.main).toMatch(/\.ts$/);
        expect(config.compatibility_date >= STANDARD_DATE, config.compatibility_date).toBe(true);
      });

      test("has a worker-configuration.d.ts that is current", async () => {
        if (NOT_TYPESCRIPT.has(example)) return;
        const dir = projectDir(example);
        const parsed = parseTypesArgs([]);
        if ("error" in parsed) throw new Error(parsed.error);
        const plan = await planTypes(parsed, config, dir, dir);
        expect(await checkTypes(plan), "run `sproutboat types` in the example").toBe("current");
      });

      test("is held to the Workers style: it has checks, or says why workerd cannot run it", () => {
        expect(Object.hasOwn(CHECKS, example) || WORKERD_SKIPS.has(example)).toBe(true);
      });

      test("does not read env as a global or the body as a string", () => {
        if (WORKERD_SKIPS.has(example)) return; // said, with its reason, in checks.ts
        const source = readFileSync(join(projectDir(example), config.main.replace(/^\.\//, "")), "utf8");
        // `env` is the handler's second argument, so a handler that only takes (request) cannot be using it.
        expect(source).not.toMatch(/\bfetch\(request\)\s*\{[^}]*\benv\./);
        expect(source).not.toMatch(/JSON\.parse\(\s*request\.body/);
        expect(source).not.toMatch(/\bsetTimeout\(\s*\)/);
      });
    });
  }
});

describe("no test-only code in examples", () => {
  // What exists only so a conformance check can drive it: vectors, internal triggers, the stats feed, fixtures.
  const TEST_ONLY = ["scryptVerify", "h1-regression", "binary-fixture", "/admin/stats", "x-sb-trigger"];
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "fonts" ? [] : sources(path);
      return /\.(?:[cm]?[jt]s|html)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
    });
  // A fixture exists for a test, so it is where test-only code belongs.
  for (const { name: example, group, dir: root } of all) {
    if (group === "fixtures") continue;
    test(`${example} has none`, () => {
      for (const sub of ["src", "public"]) {
        const dir = join(root, sub);
        if (!existsSync(dir)) continue;
        for (const file of sources(dir)) {
          const text = readFileSync(file, "utf8");
          for (const marker of TEST_ONLY) expect(text.includes(marker), `${file} mentions ${marker}`).toBe(false);
        }
      }
    });
  }
});

describe("the skip tables", () => {
  const tables = {
    STANDALONE_SKIPS,
    WORKERD_SKIPS,
    WORKERD_PARTIAL_SKIPS,
    CLOUDFLARE_TYPES_SKIPS,
    NOT_TYPESCRIPT,
  };
  for (const [name, table] of Object.entries(tables)) {
    test(`${name} names only examples that exist, each with a reason`, () => {
      for (const [example, reason] of table) {
        expect(examples, `${name}: ${example}`).toContain(example);
        expect(reason.length, `${name}: ${example}`).toBeGreaterThan(20);
      }
    });
  }

  test("CHECKS names only examples that exist, and every declared secret has a test value", () => {
    for (const example of Object.keys(CHECKS)) expect(examples, example).toContain(example);
    for (const example of SECRETS.keys()) expect(examples, example).toContain(example);
    for (const example of examples) {
      if (WORKERD_SKIPS.has(example)) continue;
      for (const secret of read(example).secrets ?? [])
        expect(Object.hasOwn(SECRETS.get(example) ?? {}, secret), `${example} ${secret}`).toBe(true);
    }
  });

  test("the README lists the same Sproutboat-only exceptions as the tables", () => {
    const readme = readFileSync(join(EXAMPLES_DIR, "README.md"), "utf8");
    // A fixture is not in the README; the examples are.
    for (const example of [...WORKERD_PARTIAL_SKIPS.keys(), ...CLOUDFLARE_TYPES_SKIPS.keys()])
      if (!example.startsWith("fixtures/")) expect(readme, example).toContain(`\`${example}\``);
  });
});
