/** The code between `// #region name` and `// #endregion` (at any indent), by name, with the indent removed. */
export function extractRegions(source: string): Map<string, string> {
  const regions = new Map<string, string>();
  for (const match of source.matchAll(/^([ \t]*)\/\/ #region (\w+)\n([\s\S]*?)^[ \t]*\/\/ #endregion$/gm)) {
    const [, indent = "", name, body] = match;
    if (!name || body === undefined) continue;
    regions.set(
      name,
      body
        .split("\n")
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
        .join("\n")
        .trimEnd(),
    );
  }
  return regions;
}

export type Part = { file: string; region?: string; lang: "ts" | "tsx" | "jsonc"; label: string; note?: string };

/**
 * Every "How it works" panel: which real files, and which regions of them. The build fails when a region is
 * missing and so does a test, so the code on the page is the code that runs.
 */
export const PANELS = {
  fleet: [
    {
      label: "The app",
      file: "fleet-app/src/index.ts",
      region: "fleet",
      lang: "ts",
      note: "Every dot is this file, deployed under its own name.",
    },
    {
      label: "The page's request",
      file: "web/fleet/store.ts",
      region: "wake",
      lang: "ts",
      note: "What a sweep or a wave sends, once per dot.",
    },
    {
      label: "Local preview only",
      file: "fleet-local.ts",
      region: "supervisor",
      lang: "ts",
      note: "On a laptop there is no sproutd, so serve.ts starts and stops real processes itself. On Sproutboat Cloud this part is the platform.",
    },
  ],
} satisfies Record<string, Part[]>;
