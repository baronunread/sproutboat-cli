/**
 * Build the page's static files.
 *
 *   site/              public/ + generated files + downloads/ (the Cloud and workerd deploys serve this)
 *   site-standalone/   the same without downloads/: a binary cannot carry its own copy
 *
 * Generated files:
 *   code.json          the "Show the code" panels. The text between `// #region name` markers in the real
 *                      source files, highlighted with Shiki. A missing marker fails the build, so the code on
 *                      screen is the code in the files.
 *   build-info.json    when it was built, a hash of src/ (the bytes both runtimes ran), the dated benchmark,
 *                      the recorded workerd run and the binaries' measured sizes, if those files exist.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { codeToHtml } from "shiki";
import { extractRegions } from "./regions";

const HERE = import.meta.dir;
const read = (path: string) => readFileSync(join(HERE, path), "utf8");

type Part = { file: string; region?: string; lang: "ts" | "json" | "jsonc" | "bash" };
const PANELS = {
  density: [
    { file: "data/benchmarks.json", lang: "json" },
    { file: "../showcase-sleeper/src/index.ts", region: "sleeper", lang: "ts" },
  ],
  race: [
    { file: "src/race.ts", region: "race", lang: "ts" },
    { file: "src/race.ts", region: "naive", lang: "ts" },
    { file: "src/race.ts", region: "statement", lang: "ts" },
    { file: "src/race.ts", region: "object", lang: "ts" },
    { file: "src/timing.ts", region: "timing", lang: "ts" },
  ],
  cloudflare: [
    { file: "src/index.ts", lang: "ts" },
    { file: "sproutboat.jsonc", lang: "jsonc" },
    { file: "wrangler.jsonc", lang: "jsonc" },
  ],
  binary: [{ file: "build-binaries.ts", region: "build", lang: "ts" }],
} satisfies Record<string, Part[]>;

type Block = { label: string; text: string; html: string };
type CodeJson = { panels: Record<string, Block[]> };

async function panels(): Promise<CodeJson> {
  const out: CodeJson["panels"] = {};
  for (const [name, parts] of Object.entries<Part[]>(PANELS)) {
    out[name] = [];
    for (const part of parts) {
      let text = read(part.file).trimEnd();
      if (part.region) {
        const found = extractRegions(text).get(part.region);
        if (!found) throw new Error(`${part.file} has no \`// #region ${part.region}\` block`);
        text = found;
      }
      const html = await codeToHtml(text, {
        lang: part.lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      });
      out[name].push({
        label: part.file.replace("../", "examples/") + (part.region && parts.length > 1 ? " · " + part.region : ""),
        text,
        html,
      });
    }
  }
  return { panels: out };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** One hash for the bytes of src/: what Sproutboat compiled and what workerd ran. */
export function sourceHash(): string {
  const hash = createHash("sha256");
  for (const file of walk(join(HERE, "src")).sort()) {
    hash.update(relative(HERE, file) + "\0");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

const optionalJson = (path: string) => (existsSync(join(HERE, path)) ? JSON.parse(read(path)) : null);

async function buildSite(dir: string, standalone: boolean, code: CodeJson) {
  const out = join(HERE, dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(HERE, "public"), out, { recursive: true });
  writeFileSync(join(out, "code.json"), JSON.stringify(code) + "\n");
  const binaries = optionalJson("binaries/binaries.json");
  if (!standalone && binaries) {
    mkdirSync(join(out, "downloads"), { recursive: true });
    for (const file of binaries.files) cpSync(join(HERE, "binaries", file.name), join(out, "downloads", file.name));
  }
  const info = {
    builtAt: new Date().toISOString(),
    compatibilityDate: /"compatibility_date":\s*"([^"]+)"/.exec(read("sproutboat.jsonc"))?.[1],
    sourceSha256: sourceHash(),
    standalone,
    benchmarks: optionalJson("data/benchmarks.json"),
    compare: optionalJson("data/compare-recorded.json"),
    binaries: standalone ? null : binaries,
  };
  writeFileSync(join(out, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  if (!existsSync(join(out, "index.html"))) throw new Error("public/index.html is missing");
  return info;
}

export async function buildWebUi(): Promise<void> {
  const code = await panels();
  const info = await buildSite("site", false, code);
  await buildSite("site-standalone", true, code);
  console.log(
    `built the page: source ${info.sourceSha256.slice(0, 12)}, ${info.binaries ? info.binaries.files.length : 0} binaries, ` +
      `${info.compare ? "a recorded workerd run" : "no recorded workerd run"}`,
  );
}

if (import.meta.main) await buildWebUi();
