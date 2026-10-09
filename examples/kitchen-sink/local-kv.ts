import { join } from "node:path";
import type { CheckFn } from "./conformance";

/** Prove the native runtime sees a CLI mutation while its SQLite store is open. */
export async function checkLocalKv(base: string, dataDir: string, check: CheckFn): Promise<void> {
  const key = "cli-seeded-session";
  const value = JSON.stringify({ user: "cli-local", expires: Date.now() + 3600000 });
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../src/main.ts"),
      "kv",
      "key",
      "put",
      "SESSIONS",
      key,
      value,
      "--local",
      "--data-dir",
      dataDir,
      "--project-dir",
      import.meta.dir,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SPROUTBOAT_TOKEN: "", SPROUTBOAT_API_URL: "http://127.0.0.1:9" },
    },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  check("local KV CLI: writes to the running app's store without credentials", code === 0, stderr);
  const response = await fetch(base + "/whoami", { headers: { authorization: "Bearer " + key } });
  check(
    "local KV CLI: native handler reads the seeded session",
    response.status === 200 && (await response.text()).includes("cli-local"),
  );
}
