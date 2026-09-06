/**
 * #15 — `sproutboat build --standalone`.
 *
 * Emits ONE executable carrying the compiled sprout, its static assets and its
 * binding declarations, with SQLite linked in so there is no broker and no
 * second process. The build is thin on purpose: `buildArtifact` with the
 * embedded transport already produces exactly the binary we want, so this
 * copies it out and enforces the one thing a standalone binary cannot do.
 */
import { chmod, cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildArtifact, type BuildInput } from "./build";
import type { Bindings } from "./wrap";

export type StandaloneBuildInput = BuildInput & {
  /** Where to write the executable. Defaults to `<projectDir>/dist/<name>`. */
  outPath?: string;
};

export type StandaloneBuildResult = { outPath: string; bytes: number };

/**
 * Bindings a standalone binary cannot serve.
 *
 * A build error, not a runtime no-op: a binary whose binding silently does
 * nothing is discovered in production, on a device someone has to reach
 * physically.
 *
 * Outbound `fetch` is deliberately absent from this list — it works over
 * `http://`, and an `https://` call reports at runtime that TLS is not compiled
 * in. Blocking the build would refuse every project that only talks to its own
 * network.
 */
export function unsupportedBindings(bindings: Partial<Bindings>): string[] {
  const reasons: string[] = [];
  if ((bindings.services ?? []).length > 0) {
    reasons.push("service bindings call another deployment through an edge, which a standalone binary has none of");
  }
  return reasons;
}

export async function buildStandalone(input: StandaloneBuildInput): Promise<StandaloneBuildResult> {
  const artifact = await buildArtifact({ ...input, transport: "embedded" });

  let bindings: Partial<Bindings> = {};
  try {
    // SAFETY: bindings.json is written by buildArtifact from the validated
    // config in this same call — our own output, not user input.
    bindings = JSON.parse(await readFile(resolve(artifact.artifactDir, "bindings.json"), "utf8")) as Partial<Bindings>;
  } catch {
    bindings = {}; // a project with no bindings at all
  }

  const blocked = unsupportedBindings(bindings);
  if (blocked.length > 0) {
    throw new Error(`cannot build a standalone binary for this project:\n  - ${blocked.join("\n  - ")}`);
  }

  // The sprout *is* the binary: assets and bindings are compiled into it, and
  // everything else it needs (port, data dir, secrets) arrives at run time.
  const outPath = input.outPath ?? resolve(input.projectDir, "dist", input.config.name);
  await mkdir(resolve(outPath, ".."), { recursive: true });
  await cp(resolve(artifact.artifactDir, "sprout"), outPath);
  await chmod(outPath, 0o755);
  return { outPath, bytes: Bun.file(outPath).size };
}
