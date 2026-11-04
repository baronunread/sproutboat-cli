import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearsslVendorArchive, fetchBearsslTarball } from "./bearssl";
import { fetchPinned } from "./fetch-pinned";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sb-pinned-"));
  temporary.push(dir);
  return dir;
};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const noSleep = async (): Promise<void> => {};
const unreachable = async (): Promise<Response> => {
  throw new Error("network must not be used");
};

test("vendored copy that matches the pin is used with no network", async () => {
  const path = join(await scratch(), "dep.bin");
  await writeFile(path, "payload");
  const bytes = await fetchPinned({
    localPath: path,
    urls: ["https://x.test/a"],
    sha256: sha("payload"),
    fetcher: unreachable,
  });
  expect(bytes.toString()).toBe("payload");
});

test("tampered vendored copy is rejected and the download is used", async () => {
  const path = join(await scratch(), "dep.bin");
  await writeFile(path, "tampered");
  const warn = console.warn;
  console.warn = () => {};
  try {
    const bytes = await fetchPinned({
      localPath: path,
      urls: ["https://x.test/a"],
      sha256: sha("payload"),
      fetcher: async () => new Response("payload"),
    });
    expect(bytes.toString()).toBe("payload");
  } finally {
    console.warn = warn;
  }
});

test("tampered vendored copy and a tampered download fail", async () => {
  const path = join(await scratch(), "dep.bin");
  await writeFile(path, "tampered");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await expect(
      fetchPinned({
        localPath: path,
        urls: ["https://x.test/a"],
        sha256: sha("payload"),
        fetcher: async () => new Response("evil"),
      }),
    ).rejects.toThrow(/sha256 mismatch/);
  } finally {
    console.warn = warn;
  }
});

test("missing vendored copy falls back to the download, retrying 5xx a bounded number of times", async () => {
  const dir = await scratch();
  let calls = 0;
  const bytes = await fetchPinned({
    localPath: join(dir, "absent.bin"),
    urls: ["https://x.test/a"],
    sha256: sha("payload"),
    sleep: noSleep,
    fetcher: async () => (++calls < 3 ? new Response("bad gateway", { status: 502 }) : new Response("payload")),
  });
  expect(bytes.toString()).toBe("payload");
  expect(calls).toBe(3);

  calls = 0;
  await expect(
    fetchPinned({
      localPath: join(dir, "absent.bin"),
      urls: ["https://x.test/a"],
      sha256: sha("payload"),
      sleep: noSleep,
      attempts: 3,
      fetcher: async () => (calls++, new Response("down", { status: 502 })),
    }),
  ).rejects.toThrow(/HTTP 502/);
  expect(calls).toBe(3);
});

test("the vendored BearSSL tarball satisfies the pin with bearssl.org unreachable", async () => {
  const bytes = await fetchBearsslTarball({ fetcher: unreachable });
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "ed397832b1613582737d9c1ce01c1af74ad6a9e9c52a341e24433987cda0f372",
  );
});

test("a missing or tampered vendored BearSSL tarball with bearssl.org down names the failure", async () => {
  const dir = await scratch();
  const down = async (): Promise<Response> => new Response("", { status: 502 });
  expect(bearsslVendorArchive()).toContain("bearssl-7bea48e.tar.gz");
  await expect(fetchBearsslTarball({ localPath: join(dir, "absent"), fetcher: down, sleep: noSleep })).rejects.toThrow(
    /bearssl\.org.*HTTP 502/s,
  );
  const bad = join(dir, "bad.tar.gz");
  await writeFile(bad, "x");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await expect(fetchBearsslTarball({ localPath: bad, fetcher: down, sleep: noSleep })).rejects.toThrow(/HTTP 502/);
  } finally {
    console.warn = warn;
  }
});
