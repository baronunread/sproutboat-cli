/**
 * "update available 0.4.4" notice, wrangler-style. Checks npm at most once a
 * day, caches the answer next to the credentials, and never fails or blocks the
 * command for more than a second. Silent when up to date, offline, in CI, or
 * when SPROUTBOAT_NO_UPDATE_CHECK is set.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configDirectory } from "./credentials";
import { isSafeInteger, isString, jsonObject, parseJsonValue } from "./json";
import { dim } from "./style";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org/sproutboat/latest";

type Cache = { checkedAt: number; latest: string };

/** Decode our own cache file, which a stale version or a partial write can corrupt. */
function parseCache(source: string): Cache | undefined {
  const record = jsonObject(parseJsonValue(source));
  return record && isSafeInteger(record.checkedAt) && isString(record.latest)
    ? { checkedAt: record.checkedAt, latest: record.latest }
    : undefined;
}

function cachePath(): string {
  return resolve(configDirectory(), "update-check.json");
}

/** Numeric x.y.z compare; a trailing `-tag` (prerelease) sorts before its release. */
function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

async function latestVersion(): Promise<string | undefined> {
  try {
    const cached = parseCache(await readFile(cachePath(), "utf8"));
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached.latest;
  } catch {
    /* no cache yet, or unreadable — fetch below */
  }

  try {
    const response = await fetch(REGISTRY, {
      signal: AbortSignal.timeout(1000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const latest = jsonObject(parseJsonValue(await response.text()))?.version;
    if (!isString(latest)) return undefined;
    await writeFile(cachePath(), JSON.stringify({ checkedAt: Date.now(), latest } satisfies Cache)).catch(() => {});
    return latest;
  } catch {
    /* offline / slow / DNS — skip silently */
  }
  return undefined;
}

/** Print one dim line to stderr if a newer `sproutboat` is on npm. Never throws. */
export async function notifyIfOutdated(current: string): Promise<void> {
  if (process.env.SPROUTBOAT_NO_UPDATE_CHECK || process.env.CI) return;
  const latest = await latestVersion();
  if (latest && isNewer(latest, current)) {
    console.error(
      dim(
        `  update available: sproutboat ${current} → ${latest}  ·  bump the dependency or run \`bunx sproutboat@latest\``,
      ),
    );
  }
}
