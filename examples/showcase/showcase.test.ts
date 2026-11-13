/** What can be checked without starting anything: the code panels exist, the tokens are well formed, the limits hold. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import comparison from "./data/comparison.json";
import { FLEET_LIMITS } from "./fleet-local";
import { extractRegions, PANELS, type Part } from "./regions";
import { color, tokensCss } from "./web/system/tokens";

const HERE = import.meta.dir;

describe("code panels", () => {
  for (const [panel, parts] of Object.entries<Part[]>(PANELS)) {
    for (const part of parts) {
      test(`${panel}: ${part.file} has region ${part.region}`, () => {
        const regions = extractRegions(readFileSync(join(HERE, part.file), "utf8"));
        if (part.region) expect(regions.get(part.region)?.length ?? 0).toBeGreaterThan(40);
      });
    }
  }

  test("an indented region loses its indent", () => {
    const found = extractRegions("x\n  // #region a\n  one\n    two\n  // #endregion\n").get("a");
    expect(found).toBe("one\n  two");
  });
});

describe("tokens", () => {
  test("every colour is OKLCH within range and becomes a custom property", () => {
    const css = tokensCss();
    for (const [name, [lightness, chroma, hue]] of Object.entries(color)) {
      expect(lightness).toBeGreaterThanOrEqual(0);
      expect(lightness).toBeLessThanOrEqual(1);
      expect(chroma).toBeLessThan(0.4);
      expect(hue).toBeLessThan(360);
      expect(css).toContain(`--stage-${name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}:`);
    }
  });

  test("the live green is not used for anything else: no other colour shares its hue", () => {
    const greens = Object.entries(color).filter(([, value]) => value[1] > 0.05 && Math.abs(value[2] - 150) < 20);
    expect(greens.map(([name]) => name).sort()).toEqual(["alive", "aliveCore"]);
  });
});

describe("local fleet limits", () => {
  test("the page's wave fits under the cap and the rate limit", () => {
    expect(FLEET_LIMITS.maxAwake).toBeLessThan(FLEET_LIMITS.apps);
    expect(FLEET_LIMITS.burst).toBeGreaterThanOrEqual(48);
    expect(FLEET_LIMITS.maxAwake * 6).toBeLessThan(1024); // MiB at about 6 MiB a process
  });
});

describe("comparison", () => {
  type Cell = { value?: string; kind?: string; by?: string; url?: string };
  const KINDS = ["published", "measured", "unpublished", "fact"];
  const cells: [where: string, cell: Cell][] = [
    ...comparison.groups.flatMap((group) =>
      group.rows.flatMap((row) =>
        group.columns.map((column): [string, Cell] => [
          `${group.id} / ${row.name} / ${column.key}`,
          Object.entries<Cell>(row.cells).find(([key]) => key === column.key)?.[1] ?? {},
        ]),
      ),
    ),
    ...comparison.coldStart.rows.map((row): [string, Cell] => [`cold start / ${row.name}`, row]),
    ...comparison.fleet.rows.map((row): [string, Cell] => [
      `fleet / ${row.name}`,
      { ...row, value: String(row.perAppMiB) },
    ]),
  ];

  test("every row has a cell for every column, and every cell says what kind of figure it is", () => {
    for (const [where, cell] of cells) {
      expect(cell.value, where).toBeTruthy();
      expect(KINDS, where).toContain(cell.kind ?? "");
    }
  });

  test("a published figure links to the page it is on", () => {
    for (const [where, cell] of cells) if (cell.kind === "published") expect(cell.url, where).toMatch(/^https:\/\//);
  });

  test("a figure we measured says what it ran on and when", () => {
    for (const [where, cell] of cells) if (cell.kind === "measured") expect(cell.by, where).toMatch(/20\d\d|live/);
  });

  test("every platform row says what it gives that we do not", () => {
    for (const group of comparison.groups)
      for (const row of group.rows) expect(row.gives.length, row.name).toBeGreaterThan(20);
  });

  test("the date the sources were read is a date", () => {
    expect(comparison.readOn).toMatch(/^20\d\d-\d\d-\d\d$/);
  });
});
