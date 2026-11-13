/** What can be checked without starting anything: the code panels exist, the tokens are well formed, the limits hold. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
