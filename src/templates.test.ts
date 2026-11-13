/**
 * The starter templates and `sproutboat init` around them: the embedded copy matches templates/, every starter is
 * a project that follows the rules for one (a package.json that init can finish, a README that says how to move to
 * Wrangler, a config only made of keys Wrangler has), and the whole flow (prompts, files, git, install) works with
 * a fake terminal. Running the starters is `src/templates-run.test.ts`; the gates are `bun run examples`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTemplates, render } from "../scripts/embed-templates";
import { projects, TEMPLATES_DIR } from "../test/fixtures/lib/projects";
import { parseConfig } from "./config";
import { InitError, parseInitArgs, runInit, templateListing, type InitIo, type InitOptions } from "./init";
import { jsonObject, parseJsonValue, type JsonValue } from "./json";
import { listTemplates, firstRunTemplates } from "./templates";
import { EMBEDDED_TEMPLATES } from "./templates-embedded";
import { checkTypes, parseTypesArgs, planTypes } from "./types-cmd";

const obj = (value: JsonValue | undefined) => (value === undefined ? undefined : jsonObject(value));

const names = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(TEMPLATES_DIR, entry.name, "sproutboat.jsonc")))
  .map((entry) => entry.name)
  .sort();

describe("the embedded copy", () => {
  test("is what scripts/embed-templates.ts writes from templates/ (run `bun run templates:embed`)", () => {
    expect(readFileSync(join(import.meta.dir, "templates-embedded.ts"), "utf8")).toBe(render(readTemplates()));
  });

  test("holds every template once, without what a project generates or installs", () => {
    expect(Object.keys(EMBEDDED_TEMPLATES).sort()).toEqual(names);
    for (const template of Object.values(EMBEDDED_TEMPLATES))
      for (const path of Object.keys(template.files)) {
        expect(path).not.toContain("node_modules");
        expect(path).not.toBe("worker-configuration.d.ts");
        expect(path).not.toMatch(/lock/);
      }
  });

  test("is small: the starters are text, and the CLI carries them in every executable", () => {
    const bytes = new TextEncoder().encode(render(readTemplates())).length;
    expect(bytes).toBeLessThan(200 * 1024);
  });
});

describe("each template", () => {
  const ALLOWED_KEYS = new Set([
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "vars",
    "kv_namespaces",
    "d1_databases",
    "queues",
    "durable_objects",
    "triggers",
    "assets",
  ]);

  for (const name of names) {
    describe(name, () => {
      const dir = join(TEMPLATES_DIR, name);
      const pkg = jsonObject(parseJsonValue(readFileSync(join(dir, "package.json"), "utf8")));

      test("is registered with the runners, so smoke, workerd, typecheck and the rules cover it", () => {
        expect(projects().some((project) => project.name === `templates/${name}`)).toBe(true);
      });

      test("has a package.json init can finish: named for the directory, described, private, with the scripts", () => {
        expect(pkg?.name).toBe(name);
        expect(String(pkg?.description).length).toBeGreaterThan(20);
        expect(pkg?.private).toBe(true);
        const scripts = obj(pkg?.scripts);
        for (const script of ["dev", "deploy", "check", "types", "typecheck", "test"])
          expect(scripts?.[script]).toBeDefined();
        // `sproutboat` is added by init at the CLI's own version, so the template must not pin one.
        expect(obj(pkg?.devDependencies)?.sproutboat).toBeUndefined();
        expect(obj(pkg?.devDependencies)?.typescript).toBeDefined();
      });

      test("is TypeScript with a README, its own tests and a committed worker-configuration.d.ts", () => {
        for (const file of [
          "README.md",
          "tsconfig.json",
          "worker-configuration.d.ts",
          "test/tsconfig.json",
          ".gitignore",
        ])
          expect(existsSync(join(dir, file)), file).toBe(true);
        expect(readdirSync(join(dir, "test")).some((file) => file.endsWith(".test.ts"))).toBe(true);
        const config = parseConfig(readFileSync(join(dir, "sproutboat.jsonc"), "utf8"));
        expect(config.ok && config.value.main).toMatch(/\.ts$/);
      });

      test("says how to move to Wrangler, and uses only config keys a wrangler.jsonc has", () => {
        const readme = readFileSync(join(dir, "README.md"), "utf8");
        expect(readme).toContain("## Moving to Wrangler");
        expect(readme).toContain("sproutboat migrate");
        const loose = jsonObject(
          parseJsonValue(
            readFileSync(join(dir, "sproutboat.jsonc"), "utf8")
              .replace(/^\s*\/\/.*$/gm, "")
              .replace(/,(\s*[}\]])/g, "$1"),
          ),
        );
        for (const key of Object.keys(loose ?? {})) expect(ALLOWED_KEYS.has(key), `${name}: ${key}`).toBe(true);
      });

      test("names no Sproutboat-only API (the workerd gate runs it unchanged; this is the quick check)", () => {
        for (const file of readdirSync(join(dir, "src"))) {
          const source = readFileSync(join(dir, "src", file), "utf8");
          expect(source, file).not.toMatch(/\.query\(|resetAt|\bSB_[A-Z]/);
          // workerd refuses a module whose exports are not handlers or classes, so only those may be exported (types are fine).
          if (file === "index.ts") expect(source, file).not.toMatch(/^export (const|let|var|function) /m);
        }
      });
    });
  }

  test("the first-run scripts name templates that have them", () => {
    for (const template of firstRunTemplates()) {
      const scripts = obj(jsonObject(parseJsonValue(EMBEDDED_TEMPLATES[template]!.files["package.json"]!))?.scripts);
      expect(scripts?.["db:migrate"], template).toBeDefined();
    }
  });
});

// -------------------------------------------------------------- init, with a fake terminal

type Calls = { logs: string[]; warnings: string[]; ran: string[]; captured: string[]; asked: string[] };

function fakeIo(cwd: string, overrides: Partial<InitIo> = {}, calls: Calls = blank()): InitIo & { calls: Calls } {
  return {
    cwd,
    cliVersion: "9.9.9",
    interactive: false,
    log: (line) => calls.logs.push(line),
    warn: (line) => calls.warnings.push(line),
    ask: async (question, fallback) => (calls.asked.push(question), fallback),
    choose: async (question, _choices, fallback) => (calls.asked.push(question), fallback),
    confirm: async (question, fallback) => (calls.asked.push(question), fallback),
    run: async (command, args) => (calls.ran.push([command, ...args].join(" ")), 0),
    capture: async (command, args) => {
      calls.captured.push([command, ...args].join(" "));
      return { code: command === "git" && args[0] === "rev-parse" ? 128 : 0, stdout: "" };
    },
    ...overrides,
    calls,
  };
}
const blank = (): Calls => ({ logs: [], warnings: [], ran: [], captured: [], asked: [] });

const scratch: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-init-test-"));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const options = (extra: Partial<InitOptions> = {}): InitOptions => ({ yes: false, list: false, ...extra });
const read = (path: string) => readFileSync(path, "utf8");

describe("init arguments", () => {
  test("take a name, a template and the create-cloudflare switches", () => {
    expect(parseInitArgs([])).toEqual({ yes: false, list: false });
    expect(parseInitArgs(["blog", "--template", "jobs", "--no-git", "--install", "-y"])).toEqual({
      name: "blog",
      template: "jobs",
      git: false,
      install: true,
      yes: true,
      list: false,
    });
    expect(parseInitArgs(["--accept-defaults", "--git", "--no-install", "--list-templates"])).toEqual({
      git: true,
      install: false,
      yes: true,
      list: true,
    });
  });

  test("refuse what they cannot read", () => {
    expect(parseInitArgs(["--template"])).toEqual({ error: "--template needs a template name" });
    expect(parseInitArgs(["--template", "--git"])).toEqual({ error: "--template needs a template name" });
    expect(parseInitArgs(["a", "b"])).toHaveProperty("error");
    expect(parseInitArgs(["--nope"])).toEqual({ error: "unknown option --nope" });
  });
});

describe("init --list-templates", () => {
  test("lists hello first, then every template with its description", async () => {
    const io = fakeIo(tmp());
    await runInit(options({ list: true }), io);
    const out = io.calls.logs.join("\n");
    expect(listTemplates()[0]!.name).toBe("hello");
    for (const { name, description } of listTemplates()) {
      expect(out).toContain(name);
      expect(out).toContain(description);
    }
    expect(out).toBe(`Templates (sproutboat init --template <name>):\n${templateListing()}`);
  });
});

describe("init --template", () => {
  for (const name of names) {
    test(`${name}: writes its files under the project's name, with types that are current`, async () => {
      const cwd = tmp();
      const io = fakeIo(cwd);
      await runInit(options({ name: "my-app", template: name }), io);
      const dir = join(cwd, "my-app");

      for (const path of Object.keys(EMBEDDED_TEMPLATES[name]!.files))
        expect(existsSync(join(dir, path)), path).toBe(true);
      const config = parseConfig(read(join(dir, "sproutboat.jsonc")));
      expect(config.ok && config.value.name).toBe("my-app");
      expect(read(join(dir, "sproutboat.jsonc"))).not.toContain(`"${name}"`);

      const pkg = jsonObject(parseJsonValue(read(join(dir, "package.json"))));
      expect(pkg?.name).toBe("my-app");
      expect(obj(pkg?.devDependencies)?.sproutboat).toBe("^9.9.9");
      expect(obj(pkg?.scripts)?.dev).toBe("sproutboat dev");

      // The d.ts is written for the new project, so `sproutboat types --check` is happy at once.
      if (!config.ok) throw new Error("config");
      const args = parseTypesArgs([]);
      if ("error" in args) throw new Error(args.error);
      expect(await checkTypes(await planTypes(args, config.value, dir, dir))).toBe("current");

      // Nothing runs that no flag asked for, and the next steps name the package manager.
      expect(io.calls.ran).toEqual([]);
      expect(io.calls.captured).toEqual([]);
      expect(io.calls.logs.join("\n")).toContain("Next: cd my-app && npm install");
    });
  }

  test("api-d1's next steps include applying the migrations, which dev needs first", async () => {
    const io = fakeIo(tmp());
    await runInit(options({ name: "tasks", template: "api-d1" }), io);
    expect(io.calls.logs.join("\n")).toContain("npm install && npm run db:migrate && npm run dev");
  });

  test("a directory path makes the app named for its last segment", async () => {
    const cwd = tmp();
    await runInit(options({ name: "apps/blog", template: "site-api" }), fakeIo(cwd));
    const config = parseConfig(read(join(cwd, "apps/blog/sproutboat.jsonc")));
    expect(config.ok && config.value.name).toBe("blog");
  });

  test("without a name the project is named for the template", async () => {
    const cwd = tmp();
    await runInit(options({ template: "jobs" }), fakeIo(cwd));
    expect(existsSync(join(cwd, "jobs/sproutboat.jsonc"))).toBe(true);
  });

  test("refuses an unknown template, listing the real ones, and writes nothing", async () => {
    const cwd = tmp();
    const failure = await runInit(options({ name: "x-app", template: "nope" }), fakeIo(cwd)).catch((error) => error);
    expect(failure).toBeInstanceOf(InitError);
    expect(failure.message).toContain('unknown template "nope"');
    for (const { name } of listTemplates()) expect(failure.message).toContain(name);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("never overwrites: one existing file stops it before any is written", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "taken/src"), { recursive: true });
    writeFileSync(join(cwd, "taken/src/index.ts"), "mine");
    const failure = await runInit(options({ name: "taken", template: "jobs" }), fakeIo(cwd)).catch((error) => error);
    expect(failure.message).toBe("taken already contains src/index.ts");
    expect(read(join(cwd, "taken/src/index.ts"))).toBe("mine");
    expect(existsSync(join(cwd, "taken/sproutboat.jsonc"))).toBe(false);
  });

  test("keeps an existing .gitignore", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "keep"));
    writeFileSync(join(cwd, "keep/.gitignore"), "mine\n");
    await runInit(options({ name: "keep", template: "jobs" }), fakeIo(cwd));
    expect(read(join(cwd, "keep/.gitignore"))).toBe("mine\n");
  });

  test("refuses a name that is not a slug", async () => {
    const failure = await runInit(options({ name: "Bad_Name", template: "jobs" }), fakeIo(tmp())).catch(
      (error) => error,
    );
    expect(failure.message).toBe("project name must be a 3–32 character lowercase slug");
  });
});

describe("init without a template", () => {
  test("is the hello starter it always was", async () => {
    const cwd = tmp();
    await runInit(options({ name: "hello" }), fakeIo(cwd));
    expect(readdirSync(join(cwd, "hello")).sort()).toEqual([".gitignore", "package.json", "sproutboat.jsonc", "src"]);
    expect(read(join(cwd, "hello/src/index.js"))).toContain("hello from Sproutboat");
    expect(existsSync(join(cwd, "hello/worker-configuration.d.ts"))).toBe(false);
  });

  test("--template hello is the same thing", async () => {
    const cwd = tmp();
    await runInit(options({ name: "again", template: "hello" }), fakeIo(cwd));
    expect(existsSync(join(cwd, "again/src/index.js"))).toBe(true);
  });
});

describe("init in a terminal and with the create-cloudflare switches", () => {
  test("asks for the template, the directory, installing and git, in that order, with C3's defaults", async () => {
    const cwd = tmp();
    const io = fakeIo(cwd, {
      interactive: true,
      choose: async (question, choices) => (
        io.calls.asked.push(question),
        choices.find((c) => c.value === "jobs")!.value
      ),
      ask: async (question) => (io.calls.asked.push(question), "nightly"),
    });
    await runInit(options(), io);
    expect(io.calls.asked).toEqual([
      "Which template would you like to use?",
      "In which directory do you want to create your application?",
      "Do you want to install dependencies with npm?",
      "Do you want to use git for version control?",
    ]);
    expect(existsSync(join(cwd, "nightly/src/digest.ts"))).toBe(true);
    // Both questions default to yes, so both ran: install first, then git with its first commit.
    expect(io.calls.ran).toEqual(["npm install"]);
    expect(io.calls.captured.filter((call) => call.startsWith("git commit"))).toHaveLength(1);
  });

  test("asks nothing that a flag or -y already answered", async () => {
    const cwd = tmp();
    const io = fakeIo(cwd, { interactive: true });
    await runInit(options({ name: "quiet", template: "jobs", install: false, git: false }), io);
    expect(io.calls.asked).toEqual([]);
    expect(io.calls.ran).toEqual([]);
  });

  test("-y takes every default without asking: installs, and makes a repository with a first commit", async () => {
    const cwd = tmp();
    const io = fakeIo(cwd, { interactive: true });
    await runInit(options({ name: "fast-app", template: "site-api", yes: true }), io);
    expect(io.calls.asked).toEqual([]);
    expect(io.calls.ran).toEqual(["npm install"]);
    expect(io.calls.captured).toEqual([
      "git --version",
      "git rev-parse --is-inside-work-tree",
      "git init --quiet",
      "git add -A",
      "git commit --quiet -m Initial commit (by sproutboat init)",
    ]);
    // Installed, so the next step is not "npm install" again.
    expect(io.calls.logs.join("\n")).toContain("Next: cd fast-app && npm run dev");
  });

  test("--git inside an existing repository does not nest another", async () => {
    const io = fakeIo(tmp(), {
      capture: async (command, args) => ({
        code: 0,
        stdout: command === "git" && args[0] === "rev-parse" ? "true\n" : "",
      }),
    });
    await runInit(options({ name: "inner", template: "jobs", git: true }), io);
    expect(io.calls.logs.join("\n")).toContain("already inside a git repository");
  });

  test("a failed install is a warning, not a failure, and the next steps still say to install", async () => {
    const io = fakeIo(tmp(), { run: async () => 1 });
    await runInit(options({ name: "flaky", template: "jobs", install: true }), io);
    expect(io.calls.warnings.join("\n")).toContain("npm install failed");
    expect(io.calls.logs.join("\n")).toContain("Next: cd flaky && npm install && npm run dev");
  });

  test("git missing is a warning", async () => {
    const io = fakeIo(tmp(), { capture: async () => ({ code: 127, stdout: "" }) });
    await runInit(options({ name: "nogit", template: "jobs", git: true }), io);
    expect(io.calls.warnings.join("\n")).toContain("git is not installed");
  });

  test("uses the package manager the lockfile or the launching tool names", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "pnp"));
    writeFileSync(join(cwd, "pnp/pnpm-lock.yaml"), "");
    const io = fakeIo(cwd);
    await runInit(options({ name: "pnp", template: "jobs", install: true }), io);
    expect(io.calls.ran).toEqual(["pnpm install"]);
  });
});
