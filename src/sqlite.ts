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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const SQLITE_VERSION = "3.50.4";

/** Same cache root Zig uses, so one `rm -rf ~/.cache/sproutboat` clears everything. */
const cacheDir = (): string => resolve(homedir(), ".cache/sproutboat", `sqlite-${SQLITE_VERSION}`);
const SQLITE_ZIP = `https://sqlite.org/2025/sqlite-amalgamation-3500400.zip`;
const SQLITE_SHA256 = "1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032";

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
  const source = resolve(dir, "sqlite3.c");
  if (existsSync(source)) return source;
  await mkdir(dir, { recursive: true });

  const response = await fetch(SQLITE_ZIP);
  if (!response.ok) throw new Error(`could not download SQLite ${SQLITE_VERSION}: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(zip).digest("hex");
  if (digest !== SQLITE_SHA256) {
    throw new Error(`SQLite amalgamation checksum mismatch: expected ${SQLITE_SHA256}, got ${digest}`);
  }
  const zipPath = resolve(dir, "amalgamation.zip");
  await writeFile(zipPath, zip);
  const unzip = await run("unzip", ["-oqj", zipPath, "-d", dir]);
  if (unzip.code !== 0) throw new Error(`could not unpack the SQLite amalgamation: ${unzip.stderr}`);
  if (!existsSync(source)) throw new Error("the SQLite amalgamation did not contain sqlite3.c");
  return source;
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
  if (existsSync(objectPath)) return objectPath;

  const source = await amalgamation();
  const [cmd, prefix] =
    input.target === "host"
      ? (["cc", []] as const)
      : ([input.zigBin ?? "zig", ["cc", "-target", "x86_64-linux-musl"]] as const);
  const result = await run(cmd, [...prefix, "-c", source, "-o", objectPath, "-O2", ...SQLITE_DEFINES]);
  if (result.code !== 0) throw new Error(`could not compile SQLite for ${input.target}:\n${result.stderr}`);
  return objectPath;
}

/** The SQLite build stamp, for the artifact manifest's provenance string. */
export const sqliteStamp = (): string => `sqlite/${SQLITE_VERSION}`;

/** Read back the compiled object's size, for reporting. */
export async function sqliteObjectSize(path: string): Promise<number> {
  return (await readFile(path)).byteLength;
}
