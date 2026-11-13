/**
 * The rules in examples/README.md that can be checked without running anything: every public example is written
 * in the standard Workers style, is registered with the runners that hold it to it, and has its generated types and
 * documentation. The runtime half (workerd, Cloudflare's types) is `bun run examples:workerd`.
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
import { EXAMPLES_DIR, FIXTURES, publicExamples } from "../examples/lib/public-examples";
import { parseConfig } from "./config";
import { checkTypes, parseTypesArgs, planTypes } from "./types-cmd";

const examples = publicExamples();
const STANDARD_DATE = "2026-09-28";

/** Examples that are not TypeScript, and why. Each is a promise to fix it or to keep the reason true. */
const NOT_TYPESCRIPT = new Map<string, string>([
  [
    "kitchen-sink",
    "1,800 lines whose Code panels excerpt src/index.js between #region markers, run by a harness that compiles it unbundled",
  ],
]);

const read = (example: string) => {
  const parsed = parseConfig(readFileSync(join(EXAMPLES_DIR, example, "sproutboat.jsonc"), "utf8"));
  if (!parsed.ok) throw new Error(`${example}: ${parsed.errors.join("; ")}`);
  return parsed.value;
};

describe("which directories are examples", () => {
  test("every directory with a sproutboat.jsonc is an example, unless it is a named fixture", () => {
    const withConfig = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(EXAMPLES_DIR, entry.name, "sproutboat.jsonc")))
      .map((entry) => entry.name);
    for (const name of withConfig) expect(FIXTURES.has(name) !== examples.includes(name), name).toBe(true);
    expect(examples).toContain("service-bindings/caller");
  });

  test("the fixtures that exist are not examples", () => {
    for (const name of FIXTURES)
      expect(
        examples.some((example) => example.split("/")[0] === name),
        name,
      ).toBe(false);
  });
});

describe("each example", () => {
  for (const example of examples) {
    describe(example, () => {
      const config = read(example);

      test("has a README and a tsconfig", () => {
        expect(existsSync(join(EXAMPLES_DIR, example, "README.md")) || example.startsWith("service-bindings/")).toBe(
          true,
        );
        if (!NOT_TYPESCRIPT.has(example)) expect(existsSync(join(EXAMPLES_DIR, example, "tsconfig.json"))).toBe(true);
      });

      test("is TypeScript, and at a compatibility date with the Workers handler arguments", () => {
        if (NOT_TYPESCRIPT.has(example)) expect(config.main).toMatch(/\.js$/);
        else expect(config.main).toMatch(/\.ts$/);
        expect(config.compatibility_date >= STANDARD_DATE, config.compatibility_date).toBe(true);
      });

      test("has a worker-configuration.d.ts that is current", async () => {
        if (NOT_TYPESCRIPT.has(example)) return;
        const dir = join(EXAMPLES_DIR, example);
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
        const source = readFileSync(join(EXAMPLES_DIR, example, config.main.replace(/^\.\//, "")), "utf8");
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
  for (const example of examples) {
    test(`${example} has none`, () => {
      for (const sub of ["src", "public"]) {
        const dir = join(EXAMPLES_DIR, example, sub);
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
    for (const example of [...WORKERD_PARTIAL_SKIPS.keys(), ...CLOUDFLARE_TYPES_SKIPS.keys()])
      expect(readme, example).toContain(`\`${example}\``);
  });
});
