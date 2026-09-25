import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type CacheRecord = { key: string; hash: string; size: number };

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verified(entry: string, key: string): Promise<Buffer | null> {
  try {
    // SAFETY: cache.json is private cache data; the key, metadata and binary
    // digest are all checked before this entry can be used.
    const record = JSON.parse(await readFile(resolve(entry, "cache.json"), "utf8")) as CacheRecord;
    if (record.key !== key) return null;
    const path = resolve(entry, "sprout");
    const info = await stat(path);
    if (!info.isFile() || (info.mode & 0o111) === 0 || info.size !== record.size) return null;
    const bytes = await readFile(path);
    return digest(bytes) === record.hash ? bytes : null;
  } catch {
    return null;
  }
}

async function publish(bytes: Uint8Array, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const candidate = `${outPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(candidate, bytes);
    await chmod(candidate, 0o555);
    await rename(candidate, outPath);
  } finally {
    await rm(candidate, { force: true });
  }
}

/** A per-project binary cache. The lock covers compilation and publication, so
 * another process can only read a complete, checksum-verified entry. */
export async function compileCached(
  cacheRoot: string,
  key: string,
  outPath: string,
  compile: (candidatePath: string) => Promise<void>,
): Promise<"hit" | "miss"> {
  const entry = resolve(cacheRoot, key);
  const cached = await verified(entry, key);
  if (cached) {
    await publish(cached, outPath);
    return "hit";
  }
  await mkdir(cacheRoot, { recursive: true });
  const lock = `${entry}.lock`;
  const deadline = Date.now() + 12 * 60_000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      // SAFETY: Node filesystem errors expose code; unrelated failures are
      // rethrown instead of being treated as a held lock.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ready = await verified(entry, key);
      if (ready) {
        await publish(ready, outPath);
        return "hit";
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for compile cache lock ${lock}`);
      const lockInfo = await stat(lock).catch(() => null);
      if (lockInfo && Date.now() - lockInfo.mtimeMs > 15 * 60_000) await rm(lock, { recursive: true, force: true });
      else await Bun.sleep(100);
    }
  }
  let stage: string | undefined;
  try {
    const ready = await verified(entry, key);
    if (ready) {
      await publish(ready, outPath);
      return "hit";
    }
    await rm(entry, { recursive: true, force: true });
    stage = await mkdtemp(resolve(cacheRoot, `.candidate-${key}-`));
    const candidate = resolve(stage, "sprout");
    await compile(candidate);
    const bytes = await readFile(candidate);
    const record: CacheRecord = { key, hash: digest(bytes), size: bytes.byteLength };
    await chmod(candidate, 0o555);
    await writeFile(resolve(stage, "cache.json"), JSON.stringify(record));
    await rename(stage, entry);
    stage = undefined;
    await publish(bytes, outPath);
    return "miss";
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
