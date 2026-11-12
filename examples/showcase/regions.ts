/** The code between `// #region name` and `// #endregion`, by name. */
export function extractRegions(source: string): Map<string, string> {
  const regions = new Map<string, string>();
  for (const match of source.matchAll(/^\/\/ #region (\w+)\n([\s\S]*?)^\/\/ #endregion$/gm)) {
    if (match[1] && match[2] !== undefined) regions.set(match[1], match[2].trimEnd());
  }
  return regions;
}

/** Every region the page shows, by file: the build fails when one is missing, and so does a test. */
export const REGIONS = {
  "src/race.ts": ["race", "naive", "statement", "object"],
  "src/timing.ts": ["timing"],
  "../showcase-sleeper/src/index.ts": ["sleeper"],
  "build-binaries.ts": ["build"],
} satisfies Record<string, string[]>;
