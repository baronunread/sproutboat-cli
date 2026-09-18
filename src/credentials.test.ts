import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeApiUrl, forgetToken, saveToken } from "./credentials";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sb-credentials-"));
  process.env.SPROUTBOAT_CONFIG_DIR = directory;
});
afterEach(async () => {
  delete process.env.SPROUTBOAT_CONFIG_DIR;
  await rm(directory, { recursive: true, force: true });
});

// baronunread/sproutboat#204 — saveToken() used to unconditionally repoint
// the machine-wide active endpoint, so logging into a second endpoint for one
// project silently became the deploy target for every other project.
test("logging into a second endpoint does not repoint the active endpoint", async () => {
  const first = await saveToken("https://dashboard.sproutboat.com", "prod-token");
  expect(first.activeApiUrl).toBe("https://dashboard.sproutboat.com");
  const second = await saveToken("https://control.sproutboat.localhost", "dev-token");
  expect(second.activeApiUrl).toBe("https://dashboard.sproutboat.com");
  expect(await activeApiUrl()).toBe("https://dashboard.sproutboat.com");
});

// baronunread/sproutboat#204 — forgetToken() used to repoint activeApiUrl to
// an arbitrary surviving profile chosen by object key order.
test("forgetting the active endpoint clears it instead of picking another one", async () => {
  await saveToken("https://dashboard.sproutboat.com", "prod-token");
  await saveToken("https://control.sproutboat.localhost", "dev-token");
  const result = await forgetToken("https://dashboard.sproutboat.com");
  expect(result).toEqual({ removed: true, activeApiUrl: undefined });
  expect(await activeApiUrl()).toBeUndefined();
});

test("forgetting a non-active endpoint leaves the active endpoint alone", async () => {
  await saveToken("https://dashboard.sproutboat.com", "prod-token");
  await saveToken("https://control.sproutboat.localhost", "dev-token");
  const result = await forgetToken("https://control.sproutboat.localhost");
  expect(result).toEqual({ removed: true, activeApiUrl: "https://dashboard.sproutboat.com" });
  expect(await activeApiUrl()).toBe("https://dashboard.sproutboat.com");
});
