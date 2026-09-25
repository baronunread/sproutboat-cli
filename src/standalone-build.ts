/**
 * #15 — `sproutboat build --standalone`.
 *
 * Emits ONE executable carrying the compiled sprout, its static assets and its
 * binding declarations, with SQLite linked in so there is no broker and no
 * second process. The build is thin on purpose: `buildArtifact` with the
 * embedded transport already produces exactly the binary we want, so this
 * copies it out and enforces the one thing a standalone binary cannot do.
 */
import { chmod, cp, mkdir } from "node:fs/promises";
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
 * Outbound `fetch` is absent from this list: http and https both work, with
 * BearSSL and the Mozilla root set compiled in.
 */
export function unsupportedBindings(bindings: Pick<Partial<Bindings>, "services" | "outbound">): string[] {
  const reasons: string[] = [];
  if ((bindings.services ?? []).length > 0) {
    reasons.push("service bindings call another deployment through an edge, which a standalone binary has none of");
  }
  return reasons;
}

export async function buildStandalone(input: StandaloneBuildInput): Promise<StandaloneBuildResult> {
  const blocked = unsupportedBindings(input.config);
  if (blocked.length > 0) {
    throw new Error(`cannot build a standalone binary for this project:\n  - ${blocked.join("\n  - ")}`);
  }
  const artifact = await buildArtifact({ ...input, transport: "embedded" });

  // The sprout *is* the binary: assets and bindings are compiled into it, and
  // everything else it needs (port, data dir, secrets) arrives at run time.
  const outPath = input.outPath ?? resolve(input.projectDir, "dist", input.config.name);
  await mkdir(resolve(outPath, ".."), { recursive: true });
  await cp(resolve(artifact.artifactDir, "sprout"), outPath);
  await chmod(outPath, 0o755);
  return { outPath, bytes: Bun.file(outPath).size };
}
