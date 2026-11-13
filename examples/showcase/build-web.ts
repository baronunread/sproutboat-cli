/**
 * Build the page's static files into site/ (what the Cloud edge, workerd and a standalone binary serve).
 *
 *   assets/main.js      web/main.tsx bundled for the browser (React, the scenes)
 *   assets/app.css      web/styles.css through Tailwind, with ikada's theme and the stage tokens
 *   code.json           the "How it works" panels: the text between `// #region name` markers in the real
 *                       source files, highlighted with Shiki. A missing marker fails the build.
 *   build-info.json     when it was built and a hash of the Worker's source
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { codeToHtml } from "shiki";
import { extractRegions, PANELS, type Part } from "./regions";
import { tokensCss } from "./web/system/tokens";

const HERE = import.meta.dir;
const read = (path: string) => readFileSync(join(HERE, path), "utf8");

async function panels() {
  const out: Record<string, { label: string; note?: string; html: string }[]> = {};
  for (const [name, parts] of Object.entries<Part[]>(PANELS)) {
    out[name] = [];
    for (const part of parts) {
      let text = read(part.file).trimEnd();
      if (part.region) {
        const found = extractRegions(text).get(part.region);
        if (!found) throw new Error(`${part.file} has no \`// #region ${part.region}\` block`);
        text = found;
      }
      const html = await codeToHtml(text, { lang: part.lang, theme: "github-dark-default" });
      out[name].push({ label: part.label, note: `${part.file}. ${part.note ?? ""}`.trim(), html });
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

export async function buildWebUi(): Promise<void> {
  const began = performance.now();
  const out = join(HERE, "site");
  // Written only when it changes: serve.ts rebuilds when a file under web/ changes, and this is one of them.
  const tokens = join(HERE, "web/tokens.generated.css");
  if (!existsSync(tokens) || readFileSync(tokens, "utf8") !== tokensCss()) writeFileSync(tokens, tokensCss());

  // Build beside site/ and swap, so a request during a rebuild never finds half a page.
  const next = join(HERE, ".site-next");
  rmSync(next, { recursive: true, force: true });
  mkdirSync(join(next, "assets"), { recursive: true });

  const bundle = await Bun.build({
    entrypoints: [join(HERE, "web/main.tsx")],
    outdir: join(next, "assets"),
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));

  // Not spawnSync: serve.ts calls this while it is serving, and a blocked loop would show up as slow requests.
  const tailwind = Bun.spawn(
    ["bunx", "@tailwindcss/cli", "-i", "web/styles.css", "-o", join(next, "assets/app.css"), "--minify"],
    { cwd: HERE, stdout: "pipe", stderr: "pipe" },
  );
  if ((await tailwind.exited) !== 0) throw new Error(await new Response(tailwind.stderr).text());

  cpSync(join(HERE, "web/index.html"), join(next, "index.html"));
  cpSync(join(HERE, "web/favicon.svg"), join(next, "favicon.svg"));
  cpSync(join(HERE, "web/fonts"), join(next, "fonts"), { recursive: true });
  writeFileSync(join(next, "code.json"), JSON.stringify(await panels()) + "\n");
  const info = { builtAt: new Date().toISOString(), sourceSha256: sourceHash() };
  writeFileSync(join(next, "build-info.json"), JSON.stringify(info, null, 2) + "\n");

  rmSync(out, { recursive: true, force: true });
  cpSync(next, out, { recursive: true });
  rmSync(next, { recursive: true, force: true });
  console.log(
    `  built the page in ${Math.round(performance.now() - began)} ms (source ${info.sourceSha256.slice(0, 12)})`,
  );
}

if (import.meta.main) await buildWebUi();
