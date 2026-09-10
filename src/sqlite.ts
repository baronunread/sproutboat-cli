/**
 * #15 — the SQLite object an embedded-backend sprout links against.
 *
 * Built once and cached: the amalgamation is a single 9 MB C file that takes
 * ~10s to compile, which is fine once per toolchain and intolerable per build.
 * Cached beside the Zig toolchain, keyed by version + target, so switching
 * targets or bumping SQLite cannot silently reuse the wrong object.
 *
 * The amalgamation is downloaded rather than vendored: 9 MB of third-party C in
 * the repo would dwarf the CLI, and the checksum below is what makes the
 * download safe to trust.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const SQLITE_VERSION = "3.50.4";

/** Same cache root Zig uses, so one `rm -rf ~/.cache/sproutboat` clears everything. */
const cacheDir = (): string =>
  resolve(
    process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? resolve(homedir(), ".cache/sproutboat"),
    `sqlite-${SQLITE_VERSION}`,
  );
const SQLITE_ZIP = `https://sqlite.org/2025/sqlite-amalgamation-3500400.zip`;
const SQLITE_SHA256 = "1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032";

const digest = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function withSqliteLock<T>(dir: string, name: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = resolve(dir, `.${name}.lock`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for SQLite cache lock ${lock}`);
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 5 * 60_000) await rm(lock, { recursive: true, force: true });
      } catch {
        /* publisher released the lock while it was being inspected */
      }
      await Bun.sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function validAmalgamation(dir: string): Promise<string | null> {
  const source = resolve(dir, "sqlite3.c");
  try {
    // SAFETY: this manifest is private data written below. The immutable
    // archive identity and the consumed source digest are both verified.
    const manifest = JSON.parse(await readFile(resolve(dir, ".sproutboat-source"), "utf8")) as {
      archiveSha256?: string;
      sourceSha256?: string;
    };
    return manifest.archiveSha256 === SQLITE_SHA256 && manifest.sourceSha256 === (await digest(source)) ? source : null;
  } catch {
    return null;
  }
}

/**
 * Compile flags. THREADSAFE=0 because a sprout serves one turn at a time;
 * DQS=0 rejects double-quoted string literals, which is the setting that turns
 * a typo'd column name in user SQL into an error instead of a string.
 */
const SQLITE_DEFINES = [
  "-DSQLITE_THREADSAFE=0",
  "-DSQLITE_OMIT_LOAD_EXTENSION",
  "-DSQLITE_DQS=0",
  "-DSQLITE_DEFAULT_MEMSTATUS=0",
  "-DSQLITE_OMIT_DEPRECATED",
  "-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1",
];

const run = (cmd: string, args: string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => done({ code: code ?? 1, stderr }));
  });

async function amalgamation(): Promise<string> {
  const dir = cacheDir();
  const ready = await validAmalgamation(dir);
  if (ready) return ready;
  return withSqliteLock(dir, "source", async () => (await validAmalgamation(dir)) ?? acquireAmalgamation(dir));
}

async function acquireAmalgamation(dir: string): Promise<string> {
  const source = resolve(dir, "sqlite3.c");
  const manifestPath = resolve(dir, ".sproutboat-source");
  const stage = resolve(dir, `.source-${process.pid}-${crypto.randomUUID()}`);
  try {
    await mkdir(stage);
    const response = await fetch(SQLITE_ZIP);
    if (!response.ok) throw new Error(`could not download SQLite ${SQLITE_VERSION}: HTTP ${response.status}`);
    const zip = Buffer.from(await response.arrayBuffer());
    const archiveDigest = createHash("sha256").update(zip).digest("hex");
    if (archiveDigest !== SQLITE_SHA256) {
      throw new Error(`SQLite amalgamation checksum mismatch: expected ${SQLITE_SHA256}, got ${archiveDigest}`);
    }
    const zipPath = resolve(stage, "amalgamation.zip");
    await writeFile(zipPath, zip);
    const unzip = await run("unzip", ["-oqj", zipPath, "-d", stage]);
    if (unzip.code !== 0) throw new Error(`could not unpack the SQLite amalgamation: ${unzip.stderr}`);
    const stagedSource = resolve(stage, "sqlite3.c");
    if (!existsSync(stagedSource)) throw new Error("the SQLite amalgamation did not contain sqlite3.c");
    const sourceSha256 = await digest(stagedSource);
    const stagedManifest = resolve(stage, ".sproutboat-source");
    await writeFile(stagedManifest, JSON.stringify({ archiveSha256: archiveDigest, sourceSha256 }), { mode: 0o444 });
    await rename(stagedSource, source);
    await rename(stagedManifest, manifestPath);
    return source;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export type SqliteObjectInput = {
  /** `host` compiles with cc; `linux-x86_64` cross-compiles with the pinned Zig. */
  target: "linux-x86_64" | "host";
  /** Zig binary, required for the linux target. */
  zigBin?: string;
};

/** Path to `sqlite3.o` for this target, building it on first use. */
export async function ensureSqliteObject(input: SqliteObjectInput): Promise<string> {
  const dir = cacheDir();
  const objectPath = resolve(dir, `sqlite3-${input.target}.o`);
  const source = await amalgamation();
  const sourceSha256 = await digest(source);
  const manifestPath = `${objectPath}.sproutboat-complete`;
  const flags = ["-O2", ...SQLITE_DEFINES];
  const [cmd, prefix] =
    input.target === "host"
      ? (["cc", []] as const)
      : ([input.zigBin ?? "zig", ["cc", "-target", "x86_64-linux-musl"]] as const);
  const command = [cmd, ...prefix];
  const validCache = async (): Promise<boolean> => {
    try {
      // SAFETY: the manifest is private data written below. Its source, target,
      // flags, and object digest must all agree before the cached object is used.
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        sourceSha256?: string;
        target?: string;
        command?: string[];
        flags?: string[];
        objectSha256?: string;
      };
      return (
        manifest.sourceSha256 === sourceSha256 &&
        manifest.target === input.target &&
        JSON.stringify(manifest.command) === JSON.stringify(command) &&
        JSON.stringify(manifest.flags) === JSON.stringify(flags) &&
        manifest.objectSha256 === (await digest(objectPath))
      );
    } catch {
      return false;
    }
  };
  if (await validCache()) return objectPath;
  return withSqliteLock(dir, `object-${input.target}`, async () => {
    if (await validCache()) return objectPath;
    const stage = `${objectPath}.${process.pid}.${crypto.randomUUID()}`;
    try {
      const result = await run(cmd, [...prefix, "-c", source, "-o", stage, ...flags]);
      if (result.code !== 0) throw new Error(`could not compile SQLite for ${input.target}:\n${result.stderr}`);
      const objectSha256 = await digest(stage);
      const stagedManifest = `${manifestPath}.${process.pid}.${crypto.randomUUID()}`;
      await writeFile(
        stagedManifest,
        JSON.stringify({ sourceSha256, target: input.target, command, flags, objectSha256 }),
        { mode: 0o444 },
      );
      await rename(stage, objectPath);
      await rename(stagedManifest, manifestPath);
      return objectPath;
    } finally {
      await rm(stage, { force: true });
    }
  });
}

/** The SQLite build stamp, for the artifact manifest's provenance string. */
export const sqliteStamp = (): string => `sqlite/${SQLITE_VERSION}`;

/** Read back the compiled object's size, for reporting. */
export async function sqliteObjectSize(path: string): Promise<number> {
  return (await readFile(path)).byteLength;
}
