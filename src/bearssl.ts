/**
 * #15 — the TLS client an embedded sprout links against.
 *
 * BearSSL (MIT), plus the Mozilla root set compiled in as trust anchors. Both
 * are downloaded, checksummed and built once into ~/.cache/sproutboat, keyed by
 * version and target, in the same shape as the SQLite object.
 *
 * Why compiled-in anchors: a static musl binary has no portable system trust
 * store — locations differ per distro and macOS wants keychain calls — so the
 * root set travels with the binary. celld does the same. `SB_CA_BUNDLE` can
 * point at a different bundle at run time.
 *
 * Why BearSSL over mbedTLS: measured, not assumed. A complete static client
 * with all 121 anchors came to 192 KB against a 1.9 MB sprout.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const BEARSSL_VERSION = "0.6";
const BEARSSL_URL = `https://bearssl.org/bearssl-${BEARSSL_VERSION}.tar.gz`;
const BEARSSL_SHA256 = "6705bba1714961b41a728dfc5debbe348d2966c117649392f8c8139efc83ff14";

/**
 * The Mozilla root set, as curl publishes it. Pinned by hash like everything
 * else: a root store that changed under us without a version bump would be a
 * silent change to what the binary trusts.
 *
 * ponytail: pinned per CLI release, so a certificate authority added after this
 * release is unknown until the next one. Fine while releases are frequent;
 * revisit if a user is ever stuck on an old CLI for months.
 */
const CACERT_URL = "https://curl.se/ca/cacert.pem";
const CACERT_SHA256 = "f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9";

const cacheDir = (): string =>
  resolve(
    process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? resolve(homedir(), ".cache/sproutboat"),
    `bearssl-${BEARSSL_VERSION}`,
  );

const digest = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function withBearsslLock<T>(dir: string, name: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = resolve(dir, `.${name}.lock`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for BearSSL cache lock ${lock}`);
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

export type BearsslInput = {
  target: "linux-x86_64" | "host";
  /** Zig binary, required for the linux target. */
  zigBin?: string;
};

export type BearsslBuild = {
  /** Add to the compile step so the prelude can `#include <bearssl.h>`. */
  includeDir: string;
  /** Objects to add to the link line: the library plus the trust anchors. */
  objects: string[];
};

const run = (cmd: string, args: string[], cwd?: string): Promise<{ code: number; stderr: string }> =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => done({ code: code ?? 1, stderr }));
  });

async function download(url: string, expected: string, to: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) throw new Error(`checksum mismatch for ${url}: expected ${expected}, got ${digest}`);
  await writeFile(to, bytes);
  return bytes;
}

/** Unpack the source tree once, and build the host tools we need from it. */
async function sourceTree(): Promise<string> {
  const dir = cacheDir();
  const tree = resolve(dir, `bearssl-${BEARSSL_VERSION}`);
  return withBearsslLock(dir, "source", async () => {
    const tarball = resolve(dir, "bearssl.tar.gz");
    const sourceManifest = resolve(tree, ".sproutboat-source");
    try {
      // SAFETY: this untrusted JSON is checked against pinned and computed hashes below.
      const manifest = JSON.parse(await readFile(sourceManifest, "utf8")) as {
        archive?: string;
        header?: string;
      };
      if (manifest.archive === BEARSSL_SHA256 && manifest.header === (await digest(resolve(tree, "inc/bearssl.h"))))
        return tree;
    } catch {
      /* rebuild an incomplete or corrupt source cache below */
    }
    await rm(tree, { recursive: true, force: true });
    if (!existsSync(tarball) || (await digest(tarball)) !== BEARSSL_SHA256) {
      await rm(tarball, { force: true });
      await download(BEARSSL_URL, BEARSSL_SHA256, tarball);
    }
    const stage = resolve(dir, `.bearssl-stage-${process.pid}-${crypto.randomUUID()}`);
    await mkdir(stage, { recursive: true });
    const untar = await run("tar", ["xzf", tarball, "-C", stage]);
    if (untar.code !== 0) throw new Error(`could not unpack BearSSL: ${untar.stderr}`);
    const stagedTree = resolve(stage, `bearssl-${BEARSSL_VERSION}`);
    if (!existsSync(resolve(stagedTree, "inc/bearssl.h"))) {
      await rm(stage, { recursive: true, force: true });
      throw new Error("BearSSL archive did not contain bearssl.h");
    }
    await writeFile(
      resolve(stagedTree, ".sproutboat-source"),
      JSON.stringify({ archive: BEARSSL_SHA256, header: await digest(resolve(stagedTree, "inc/bearssl.h")) }),
      { mode: 0o444 },
    );
    await rename(stagedTree, tree);
    await rm(stage, { recursive: true, force: true });
    return tree;
  });
}

/** Every .c under src/, which is what the library is. */
async function sources(tree: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".c")) found.push(path);
    }
  };
  await walk(resolve(tree, "src"));
  return found.sort();
}

/**
 * `brssl ta` turns a PEM bundle into C trust-anchor structs. It is a host tool,
 * so it is built with the host compiler whatever the sprout's target is.
 */
async function trustAnchorTool(tree: string): Promise<string> {
  const tool = resolve(tree, "build/brssl");
  if (existsSync(tool)) return tool;
  const make = await run("make", ["-j8", "build/brssl"], tree);
  if (!existsSync(tool)) throw new Error(`could not build brssl: ${make.stderr}`);
  return tool;
}

/**
 * Generate the trust anchors as linkable C.
 *
 * `brssl` emits them `static`, which is right for its own samples and useless
 * to us: the prelude has to reach them from another translation unit. Rename
 * the array and publish a count beside it.
 */
async function trustAnchorSource(tree: string): Promise<string> {
  const out = resolve(cacheDir(), "trust-anchors.c");
  return withBearsslLock(cacheDir(), "anchors", async () => {
    const manifestPath = resolve(cacheDir(), ".sproutboat-anchors");
    const pem = resolve(cacheDir(), "cacert.pem");
    try {
      // SAFETY: this untrusted JSON is checked against pinned and computed hashes below.
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { pem?: string; source?: string };
      if (manifest.pem === CACERT_SHA256 && manifest.source === (await digest(out))) return out;
    } catch {
      /* regenerate an incomplete or corrupt trust-anchor cache below */
    }
    if (!existsSync(pem) || (await digest(pem)) !== CACERT_SHA256) {
      await rm(pem, { force: true });
      await download(CACERT_URL, CACERT_SHA256, pem);
    }
    const tool = await trustAnchorTool(tree);

    const generated = await new Promise<string>((done, fail) => {
      const child = spawn(tool, ["ta", pem], { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      let err = "";
      child.stdout.on("data", (chunk) => (text += String(chunk)));
      child.stderr.on("data", (chunk) => (err += String(chunk)));
      child.on("close", (code) => (code === 0 ? done(text) : fail(new Error(`brssl ta failed: ${err}`))));
    });

    const count = /#define TAs_NUM\s+(\d+)/.exec(generated)?.[1];
    if (!count) throw new Error("brssl ta produced no TAs_NUM — its output format changed");
    const linkable = generated
      .replace(/static const br_x509_trust_anchor TAs\[/, "const br_x509_trust_anchor sb_trust_anchors[")
      .replace(/#define TAs_NUM\s+\d+/, `const size_t sb_trust_anchor_count = ${count};`);
    const stage = `${out}.${process.pid}.${crypto.randomUUID()}`;
    await writeFile(stage, `#include <stddef.h>\n#include "bearssl.h"\n${linkable}\n`);
    await rename(stage, out);
    const manifestStage = `${manifestPath}.${process.pid}.${crypto.randomUUID()}`;
    await writeFile(manifestStage, JSON.stringify({ pem: CACERT_SHA256, source: await digest(out) }), { mode: 0o444 });
    await rename(manifestStage, manifestPath);
    return out;
  });
}

/** Compile one C file, caching on the output path. */
async function compile(cc: string, prefix: string[], source: string, out: string, includes: string[]): Promise<void> {
  if (existsSync(out)) return;
  const result = await run(cc, [...prefix, "-c", source, "-o", out, "-Os", ...includes.flatMap((i) => ["-I", i])]);
  if (result.code !== 0) throw new Error(`could not compile ${source}:\n${result.stderr}`);
}

/** BearSSL objects plus trust anchors for this target, building them on first use. */
export async function ensureBearssl(input: BearsslInput): Promise<BearsslBuild> {
  const tree = await sourceTree();
  const includeDir = resolve(tree, "inc");
  const objDir = resolve(cacheDir(), `obj-${input.target}`);
  const [cc, prefix] =
    input.target === "host"
      ? (["cc", []] as const)
      : ([input.zigBin ?? "zig", ["cc", "-target", "x86_64-linux-musl"]] as const);
  const includes = [includeDir, resolve(tree, "src")];
  const sourceFiles = await sources(tree);
  const anchors = await trustAnchorSource(tree);
  const sourceHashes = Object.fromEntries(
    await Promise.all(sourceFiles.map(async (source) => [source, await digest(source)] as const)),
  );
  const anchorSha256 = await digest(anchors);
  const manifestPath = resolve(objDir, ".sproutboat-complete");
  const objectNames = [
    ...sourceFiles.map((source) => `${source.split("/").pop()!.replace(/\.c$/, "")}.o`),
    "trust-anchors.o",
  ];
  const flags = ["-Os", ...includes.flatMap((include) => ["-I", include])];
  const validCache = async (): Promise<boolean> => {
    try {
      // SAFETY: the manifest is private data written below. Every source, target,
      // compiler invocation, and object digest must match before reuse.
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        target?: string;
        command?: string[];
        flags?: string[];
        sources?: Record<string, string>;
        anchors?: string;
        objects?: Record<string, string>;
      };
      const validObjects = await Promise.all(
        objectNames.map(async (name) => manifest.objects?.[name] === (await digest(resolve(objDir, name)))),
      );
      return (
        manifest.target === input.target &&
        JSON.stringify(manifest.command) === JSON.stringify([cc, ...prefix]) &&
        JSON.stringify(manifest.flags) === JSON.stringify(flags) &&
        JSON.stringify(manifest.sources) === JSON.stringify(sourceHashes) &&
        manifest.anchors === anchorSha256 &&
        validObjects.every(Boolean)
      );
    } catch {
      return false;
    }
  };
  if (await validCache()) return { includeDir, objects: objectNames.map((name) => resolve(objDir, name)) };

  return withBearsslLock(cacheDir(), `objects-${input.target}`, async () => {
    if (await validCache()) return { includeDir, objects: objectNames.map((name) => resolve(objDir, name)) };
    await rm(objDir, { recursive: true, force: true });
    await mkdir(objDir, { recursive: true });

    const objects: string[] = [];
    // Sequential rather than parallel: this runs once per target and a burst of
    // ~180 compiler processes is a worse neighbour than a slow first build.
    for (const source of sourceFiles) {
      const out = resolve(objDir, `${source.split("/").pop()!.replace(/\.c$/, "")}.o`);
      await compile(cc, [...prefix], source, out, includes);
      objects.push(out);
    }

    const anchorObject = resolve(objDir, "trust-anchors.o");
    await compile(cc, [...prefix], anchors, anchorObject, includes);
    objects.push(anchorObject);

    const objectHashes = Object.fromEntries(
      await Promise.all(objects.map(async (object) => [object.split("/").pop()!, await digest(object)] as const)),
    );
    const stagedManifest = `${manifestPath}.${process.pid}.${crypto.randomUUID()}`;
    await writeFile(
      stagedManifest,
      JSON.stringify({
        target: input.target,
        command: [cc, ...prefix],
        flags,
        sources: sourceHashes,
        anchors: anchorSha256,
        objects: objectHashes,
      }),
      { mode: 0o444 },
    );
    await rename(stagedManifest, manifestPath);

    return { includeDir, objects };
  });
}

export const bearsslStamp = (): string => `bearssl/${BEARSSL_VERSION}`;
