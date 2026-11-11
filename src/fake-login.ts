/**
 * Test helper: a config directory holding two stored logins, a decoy that is the default and the fake Cloud under a
 * name of its own, so a test can tell `--profile` from "whatever is stored". Nothing listens at the decoy.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY } from "./cloud-fake";

export const DECOY_URL = "http://127.0.0.1:9";

export function fakeLogin(cloudUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-fake-login-"));
  mkdirSync(join(dir, "sproutboat"), { recursive: true });
  writeFileSync(
    join(dir, "sproutboat", "credentials.json"),
    JSON.stringify({
      version: 1,
      activeApiUrl: DECOY_URL,
      profiles: { [DECOY_URL]: { token: "nobody", kind: "community" }, [cloudUrl]: { token: FAKE_KEY, kind: "cloud" } },
    }),
  );
  return {
    dir,
    profile: `127.0.0.1-${new URL(cloudUrl).port}`,
    env: { SPROUTBOAT_CONFIG_DIR: dir, SPROUTBOAT_API_URL: "", SPROUTBOAT_PROFILE: "", SPROUTBOAT_API_TOKEN: "" },
  };
}
