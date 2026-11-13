import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudIo } from "./cloud";
import {
  buildAndDeploy,
  buildFailureHeadline,
  cancelCloudBuild,
  deployToCloud,
  formatBuildState,
  formatBuildSummary,
  formatLogLines,
  hostFor,
  Interrupted,
  parseBuildView,
  parseSseFrames,
  type BuildPlan,
} from "./cloud-deploy";
import type { JsonObject } from "./json";
import { FAKE_KEY, startFakeCloud, type FakeOptions } from "./cloud-fake";

const MiB = 1048576;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeIo(overrides: Partial<CloudIo> = {}) {
  const lines: string[] = [];
  const io: CloudIo = {
    log: (l) => lines.push(l),
    warn: (l) => lines.push(l),
    interactive: false,
    openUrl: () => true,
    sleep: async () => {},
    choose: async (_q, choices) => choices[0]!,
    ...overrides,
  };
  return { io, lines };
}

const view = (extra: JsonObject = {}) =>
  parseBuildView({
    id: "bld_1",
    state: "ready",
    cached: false,
    position: null,
    error: null,
    record_generation: 7,
    stats: { wall_ms: 4100, peak_memory_bytes: 742 * MiB, memory_cap_bytes: 1200 * MiB },
    ...extra,
  });

describe("build formatting", () => {
  test("the summary shows time and peak memory against the cap", () => {
    expect(formatBuildSummary(view())).toBe("Built in 4.1 s · peak memory 742 MB (cap 1200 MB)");
  });
  test("a null peak omits the memory part", () => {
    expect(
      formatBuildSummary(view({ stats: { wall_ms: 900, peak_memory_bytes: null, memory_cap_bytes: 1200 * MiB } })),
    ).toBe("Built in 0.9 s");
    expect(formatBuildSummary(view({ stats: null }))).toBe("Built");
  });
  test("a cached build says so", () => {
    expect(formatBuildSummary(view({ cached: true, stats: null }))).toBe(
      "Built (cached, identical to an earlier build)",
    );
  });
  test("queue state and log gutter", () => {
    expect(formatBuildState("queued", 1)).toBe("queued (position 1)");
    expect(formatBuildState("queued", null)).toBe("queued");
    expect(formatBuildState("queued", 1, "waiting for memory")).toBe("queued (position 1), waiting for memory");
    expect(formatLogLines("a\nb\n\n")).toEqual(["  | a", "  | b"]);
  });
  test("parseBuildView rejects a reply that is not a build", () => {
    expect(() => parseBuildView({ error: "x" })).toThrow("not a build");
  });
});

describe("parseSseFrames", () => {
  test("splits on blank lines, keeps the tail, drops comments", () => {
    const text =
      ': keepalive\n\nevent: state\ndata: {"state":"queued"}\n\nid: 3\nevent: log\ndata: {"text":"hi\\n"}\n\nevent: do';
    const { frames, rest } = parseSseFrames(text);
    expect(frames).toEqual([
      { event: "state", id: undefined, data: '{"state":"queued"}' },
      { event: "log", id: "3", data: '{"text":"hi\\n"}' },
    ]);
    expect(rest).toBe("event: do");
  });
  test("a frame split across chunks is completed by the next one", () => {
    const first = parseSseFrames("event: log\nid: 1\nda");
    expect(first.frames).toEqual([]);
    const second = parseSseFrames(`${first.rest}ta: {"text":"x"}\n\n`);
    expect(second.frames).toEqual([{ event: "log", id: "1", data: '{"text":"x"}' }]);
    expect(second.rest).toBe("");
  });
  test("accepts CRLF and joins multi-line data", () => {
    const { frames } = parseSseFrames("event: done\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(frames).toEqual([{ event: "done", id: undefined, data: "a\nb" }]);
  });
});

describe("buildAndDeploy", () => {
  let work: string;
  let sourcePath: string;
  const source = "export default { fetch() { return new Response('hi'); } };\n";
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "sb-build-"));
    sourcePath = join(work, "sprout.generated.js");
    await writeFile(sourcePath, source);
  });
  afterEach(() => rm(work, { recursive: true, force: true }));

  const plan = (url: string, extra: Partial<BuildPlan> = {}): BuildPlan => ({
    apiUrl: url,
    token: FAKE_KEY,
    tokenFromEnv: false,
    project: "hello",
    hosts: [hostFor("hello", "acme")],
    sourcePath,
    cli: { version: "9.9.9" },
    noWait: false,
    pollMs: 1,
    retryMs: 1,
    ...extra,
  });
  const withCloud = async (options: FakeOptions, run: (cloud: ReturnType<typeof startFakeCloud>) => Promise<void>) => {
    const cloud = startFakeCloud({ teamKey: true, ...options });
    try {
      await run(cloud);
    } finally {
      cloud.stop();
    }
  };

  test("uploads the source, streams the log, writes the app and waits for the host", async () => {
    await withCloud({ applyStates: ["pending", "applied"] }, async (cloud) => {
      const { io, lines } = fakeIo();
      const result = await buildAndDeploy(plan(cloud.url), io);
      expect(result).toMatchObject({
        created: true,
        generation: 1,
        url: "https://hello.acme.sproutboat.app",
        applied: true,
        buildId: "bld_1",
      });
      expect(lines).toEqual([
        `  Uploading  source ${sha256(source).slice(0, 12)} (1 KiB)`,
        "  Building   queued (position 1)",
        "  Building   building",
        "  | porffor: compiled in 1.0 s",
        "  | built in 4.1 s, peak memory 742 MB (cap 1200 MB)",
        "✓ Built in 4.1 s · peak memory 742 MB (cap 1200 MB)",
        "  record generation 1 written; waiting for a host to apply it",
      ]);
      expect(cloud.sources.get(sha256(source))).toBeDefined();
      expect(cloud.buildRequests).toEqual([
        {
          source_sha256: sha256(source),
          kind: "generated",
          build: { v: 1, name: "hello", cli: { version: "9.9.9" } },
          spec: { hosts_patch: { add: ["hello.acme.sproutboat.app"] } },
        },
      ]);
      expect(cloud.spec).toMatchObject({ hosts: ["hello.acme.sproutboat.app"] });
      expect(cloud.calls.every((c) => c.auth === `Bearer ${FAKE_KEY}`)).toBe(true);
      expect(cloud.calls.some((c) => c.path.startsWith("/v1/modules/"))).toBe(false);
    });
  });

  test("a deploy from source keeps the routes an operator added", async () => {
    const live = ["hello.acme.sproutboat.app", "risulta.dev"];
    await withCloud({ existingHosts: live }, async (cloud) => {
      await buildAndDeploy(plan(cloud.url), fakeIo().io);
      expect(cloud.buildRequests[0]).toMatchObject({ spec: { hosts_patch: { add: ["hello.acme.sproutboat.app"] } } });
      expect(cloud.spec.hosts).toEqual(live);
    });
  });

  test("a Cloud without hosts_patch gets the live routes sent back with the build", async () => {
    await withCloud({ existingHosts: ["risulta.dev"], legacyHosts: true }, async (cloud) => {
      const { io, lines } = fakeIo();
      await buildAndDeploy(plan(cloud.url), io);
      expect(cloud.buildRequests).toHaveLength(1);
      expect(cloud.buildRequests[0]).toMatchObject({ spec: { hosts: ["risulta.dev", "hello.acme.sproutboat.app"] } });
      expect(cloud.spec.hosts).toEqual(["risulta.dev", "hello.acme.sproutboat.app"]);
      expect(lines.some((line) => line.includes("no hosts_patch yet"))).toBe(true);
    });
  });

  test("an unchanged source is not uploaded again", async () => {
    await withCloud({}, async (cloud) => {
      cloud.sources.set(sha256(source), new TextEncoder().encode(source));
      const { io, lines } = fakeIo();
      await buildAndDeploy(plan(cloud.url, { noWait: true }), io);
      expect(lines[0]).toBe(`  Uploading  source ${sha256(source).slice(0, 12)} (1 KiB)  unchanged`);
      expect(cloud.calls.filter((c) => c.method === "PUT" && c.path.startsWith("/v1/sources/"))).toEqual([]);
    });
  });

  test("a cache hit needs no stream", async () => {
    await withCloud({ build: { mode: "cached" } }, async (cloud) => {
      const { io, lines } = fakeIo();
      const result = await buildAndDeploy(plan(cloud.url), io);
      expect(result).toMatchObject({ generation: 1, applied: true });
      expect(lines).toContain("✓ Built (cached, identical to an earlier build)");
      expect(cloud.eventRequests).toEqual([]);
    });
  });

  test("a failed build is an error carrying the sanitised message", async () => {
    await withCloud({ build: { mode: "failed" } }, async (cloud) => {
      const { io, lines } = fakeIo();
      await expect(buildAndDeploy(plan(cloud.url), io)).rejects.toThrow(
        "build failed: porffor: unsupported syntax at index.js:3",
      );
      expect(lines.some((l) => l.startsWith("  | porffor: compiled"))).toBe(true);
      expect(cloud.spec).toEqual({});
    });
  });

  test("the memory-cap message is shown verbatim", async () => {
    await withCloud({ build: { mode: "memory-cap" } }, async (cloud) => {
      await expect(buildAndDeploy(plan(cloud.url), fakeIo().io)).rejects.toThrow(
        "porffor stopped: hit the 1200 MB memory cap",
      );
    });
  });

  test("a queued build held back for memory shows why, once, and keeps waiting", async () => {
    const waiting = "waiting for memory (1172 MB available, a build needs 1600 MB)";
    await withCloud({ build: { waiting } }, async (cloud) => {
      const { io, lines } = fakeIo();
      const result = await buildAndDeploy(plan(cloud.url), io);
      expect(result.applied).toBe(true);
      const building = lines.filter((l) => l.startsWith("  Building"));
      expect(building).toEqual([`  Building   queued (position 1), ${waiting}`, "  Building   building"]);
    });
  });

  test("a failed build prints its peak memory", async () => {
    await withCloud({ build: { mode: "memory-cap" } }, async (cloud) => {
      const { io, lines } = fakeIo();
      await expect(buildAndDeploy(plan(cloud.url), io)).rejects.toThrow("hit the 1200 MB memory cap");
      expect(lines.at(-1)).toBe("  peak memory 1200 MB (cap 1200 MB)");
    });
  });

  test("builds-disabled and no-builder say the Cloud cannot build", async () => {
    await withCloud({ build: { mode: "disabled" } }, async (cloud) => {
      await expect(buildAndDeploy(plan(cloud.url), fakeIo().io)).rejects.toThrow(
        "this Cloud cannot build right now: builds are not enabled on it",
      );
    });
    await withCloud({ build: { mode: "no-builder" } }, async (cloud) => {
      await expect(buildAndDeploy(plan(cloud.url), fakeIo().io)).rejects.toThrow("no builder is available");
    });
  });

  test("a 429 shows the Cloud's message", async () => {
    await withCloud({ build: { mode: "queue-full" } }, async (cloud) => {
      await expect(buildAndDeploy(plan(cloud.url), fakeIo().io)).rejects.toThrow(
        "at most 2 builds at once per team; wait for one to finish",
      );
    });
  });

  test("--no-wait returns once the build is accepted", async () => {
    await withCloud({}, async (cloud) => {
      const { io, lines } = fakeIo();
      const result = await buildAndDeploy(plan(cloud.url, { noWait: true }), io);
      expect(result).toMatchObject({ generation: undefined, applied: "skipped", buildId: "bld_1" });
      expect(lines.at(-1)).toBe("  Build      bld_1 accepted; status at /v1/builds/bld_1");
      expect(cloud.eventRequests).toEqual([]);
      expect(cloud.spec).toEqual({});
    });
  });

  test("an interrupt cancels the build and throws Interrupted", async () => {
    await withCloud({ build: { mode: "hang" } }, async (cloud) => {
      const controller = new AbortController();
      const { io } = fakeIo({ log: (line) => line.includes("compiled") && controller.abort() });
      await expect(buildAndDeploy(plan(cloud.url), io, controller.signal)).rejects.toBeInstanceOf(Interrupted);
      expect(cloud.cancels).toEqual(["bld_1"]);
    });
  });

  test("cancelCloudBuild sends DELETE and returns the view", async () => {
    await withCloud({ build: { mode: "hang" } }, async (cloud) => {
      await buildAndDeploy(plan(cloud.url, { noWait: true }), fakeIo().io);
      const canceled = await cancelCloudBuild(plan(cloud.url), "bld_1");
      expect(canceled.state).toBe("canceled");
      expect(cloud.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/builds/bld_1" });
    });
  });

  test("a dropped connection resumes from the last log line without repeating it", async () => {
    await withCloud({ build: { dropAfterLogs: 1 } }, async (cloud) => {
      const { io, lines } = fakeIo();
      const result = await buildAndDeploy(plan(cloud.url), io);
      expect(result.applied).toBe(true);
      expect(cloud.eventRequests).toEqual(["?after=0", "?after=1"]);
      expect(lines.filter((l) => l.startsWith("  | "))).toEqual([
        "  | porffor: compiled in 1.0 s",
        "  | built in 4.1 s, peak memory 742 MB (cap 1200 MB)",
      ]);
    });
  });

  test("with no event stream it falls back to polling the build", async () => {
    await withCloud({ build: { noEvents: true } }, async (cloud) => {
      const result = await buildAndDeploy(plan(cloud.url), fakeIo().io);
      expect(result).toMatchObject({ generation: 1, applied: true });
      expect(cloud.calls.filter((c) => c.method === "GET" && c.path === "/v1/builds/bld_1").length).toBeGreaterThan(1);
    });
  });

  test("assets are pushed before the build names them, and the current ref is kept without assets", async () => {
    const site = join(work, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "<h1>hi</h1>");
    const { buildAssetBundle } = await import("./cloud-deploy");
    const bundle = buildAssetBundle(work, { directory: "site" });
    await withCloud({}, async (cloud) => {
      await buildAndDeploy(plan(cloud.url, { assets: bundle, noWait: true }), fakeIo().io);
      const order = cloud.calls.map((c) => c.path.replace(/[0-9a-f]{64}/, "<sha>"));
      expect(order.indexOf("/v1/assets/manifests/<sha>")).toBeLessThan(order.indexOf("/v1/apps/hello/builds"));
      expect(cloud.buildRequests[0]).toMatchObject({ spec: { assets_manifest_ref: `assets/${bundle.manifestSha}` } });
    });
    const ref = `assets/${"a".repeat(64)}`;
    await withCloud({ appExists: true, existingAssetsRef: ref }, async (cloud) => {
      await buildAndDeploy(plan(cloud.url, { noWait: true }), fakeIo().io);
      expect(cloud.buildRequests[0]).toMatchObject({ spec: { assets_manifest_ref: ref } });
    });
  });

  test("a source over 8 MiB or not UTF-8 is refused before any upload", async () => {
    await withCloud({}, async (cloud) => {
      await writeFile(sourcePath, new Uint8Array(8 * MiB + 1).fill(97));
      await expect(buildAndDeploy(plan(cloud.url), fakeIo().io)).rejects.toThrow("at most 8 MiB");
      await writeFile(sourcePath, new Uint8Array([0xff, 0xfe, 0x41]));
      await expect(buildAndDeploy(plan(cloud.url), fakeIo().io)).rejects.toThrow("not valid UTF-8");
      expect(cloud.calls).toEqual([]);
    });
  });

  test("--module against a team key says modules are built by the Cloud", async () => {
    await withCloud({}, async (cloud) => {
      const module = join(work, "app.so");
      await writeFile(module, "module-bytes");
      await expect(
        deployToCloud(
          {
            apiUrl: cloud.url,
            token: FAKE_KEY,
            tokenFromEnv: false,
            project: "hello",
            hosts: ["hello.acme.sproutboat.app"],
            modulePath: module,
            noWait: false,
          },
          fakeIo().io,
        ),
      ).rejects.toThrow("modules are built by the Cloud; run `sproutboat deploy` without --module");
    });
  });
});

describe("the CLI end to end, building from source", () => {
  const main = join(import.meta.dir, "main.ts");
  let config: string;
  let project: string;
  const run = async (args: string[], env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, main, ...args], {
      env: {
        ...process.env,
        SPROUTBOAT_CONFIG_DIR: config,
        SPROUTBOAT_NO_UPDATE_CHECK: "1",
        SPROUTBOAT_API_TOKEN: "",
        SPROUTBOAT_TOKEN: "",
        ...env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), "sb-cfg-"));
    project = await mkdtemp(join(tmpdir(), "sb-proj-"));
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "index.js"), "export default { fetch() { return new Response('hi'); } };\n");
    await writeFile(
      join(project, "sproutboat.jsonc"),
      `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07", "account": "acme" }`,
    );
    await writeFile(join(project, "app.so"), "module-bytes");
  });
  afterEach(async () => {
    await rm(config, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test("deploy with no --module bundles, builds in the Cloud and prints the result", async () => {
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await run(["deploy", project], { SPROUTBOAT_API_URL: cloud.url, SPROUTBOAT_API_TOKEN: FAKE_KEY });
      expect(out.stderr).toBe("");
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/Bundling {3}src\/index\.js \(\d+ KiB\)/);
      expect(out.stdout).toMatch(/Uploading {2}source [0-9a-f]{12} \(\d+ KiB\)/);
      expect(out.stdout).toContain("  | porffor: compiled in 1.0 s");
      expect(out.stdout).toContain("✓ Built in 4.1 s · peak memory 742 MB (cap 1200 MB)");
      expect(out.stdout).toContain("Created hello");
      expect(out.stdout).toContain("https://hello.acme.sproutboat.app");
      expect(out.stdout).toContain("generation 1  ·  team acme");
      expect(cloud.modules.size).toBe(0);
    } finally {
      cloud.stop();
    }
  });

  test("a failed build exits 1 with the message", async () => {
    const cloud = startFakeCloud({ teamKey: true, build: { mode: "memory-cap" } });
    try {
      const out = await run(["deploy", project], { SPROUTBOAT_API_URL: cloud.url, SPROUTBOAT_API_TOKEN: FAKE_KEY });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("porffor stopped: hit the 1200 MB memory cap");
    } finally {
      cloud.stop();
    }
  });

  test("--no-wait prints the build id and its status path", async () => {
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await run(["deploy", project, "--no-wait"], {
        SPROUTBOAT_API_URL: cloud.url,
        SPROUTBOAT_API_TOKEN: FAKE_KEY,
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("/v1/builds/bld_1");
      expect(out.stdout).toContain("Build queued for hello");
    } finally {
      cloud.stop();
    }
  });

  test("--dry-run says it would build in the Cloud and uploads nothing", async () => {
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await run(["deploy", project, "--dry-run"], { SPROUTBOAT_API_URL: cloud.url });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("build     in the Cloud, from your bundled source");
      expect(out.stdout).toContain("--dry-run: not uploading.");
      expect(out.stdout).toContain("has the Cloud build it");
      expect(cloud.calls.filter((c) => c.method !== "GET")).toEqual([]);
    } finally {
      cloud.stop();
    }
  });

  test("--module with a team key explains that modules are built by the Cloud", async () => {
    const cloud = startFakeCloud({ teamKey: true });
    try {
      const out = await run(["deploy", project, "--module", join(project, "app.so")], {
        SPROUTBOAT_API_URL: cloud.url,
        SPROUTBOAT_API_TOKEN: FAKE_KEY,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("modules are built by the Cloud; run `sproutboat deploy` without --module");
    } finally {
      cloud.stop();
    }
  });
});

describe("failure headline and host note", () => {
  test("progress lines never headline a failure", () => {
    expect(buildFailureHeadline("hello.js parsed\nhello.js generated IR\nthe compile did not finish")).toBe(
      "the compile did not finish",
    );
  });
  test("the compiler's reason wins over progress lines", () => {
    expect(buildFailureHeadline("parsed\ngenerated IR\nError: unsupported syntax at index.js:3")).toBe(
      "Error: unsupported syntax at index.js:3",
    );
    expect(buildFailureHeadline("[12ms] parsed\nthe compile timed out after 55 s")).toBe(
      "the compile timed out after 55 s",
    );
  });
  test("an empty message has a placeholder", () => {
    expect(buildFailureHeadline(undefined)).toBe("no reason given");
  });
});
