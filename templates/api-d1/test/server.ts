// The server under test. BASE_URL points at one that is already running (a deployed copy, a standalone build);
// without it, this applies the migrations to the local database, starts `sproutboat dev` for this project on a
// free port and stops it afterwards.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(new URL("../node_modules/.bin/sproutboat", import.meta.url));

export interface Server {
  base: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

export async function startServer(): Promise<Server> {
  const given = process.env.BASE_URL;
  if (given) return { base: given.replace(/\/$/, ""), stop: async () => {} };

  const command = existsSync(bin) ? bin : "sproutboat";
  // The schema is not the Worker's job: it is in migrations/, and a fresh local database has none of it yet.
  const migrated = spawnSync(command, ["d1", "migrations", "apply", "DB", "--local"], {
    cwd: project,
    encoding: "utf8",
  });
  if (migrated.status !== 0) throw new Error(`applying the migrations failed:\n${migrated.stdout}${migrated.stderr}`);

  const port = await freePort();
  const child: ChildProcess = spawn(command, ["dev", "--port", String(port), "--no-watch"], {
    cwd: project,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  let exited = false;
  child.once("exit", () => (exited = true));

  const base = `http://127.0.0.1:${port}`;
  // The first build compiles the app, which takes a while; any answer at all means it is up.
  const deadline = Date.now() + 180_000;
  let up = false;
  while (!up && !exited && Date.now() < deadline) {
    try {
      await fetch(base + "/");
      up = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!up) {
    child.kill("SIGTERM");
    throw new Error(`sproutboat dev did not come up${exited ? " (it exited)" : " in 180 s"}:\n${stderr}`);
  }
  return {
    base,
    stop: async () => {
      if (exited) return;
      const done = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await done;
    },
  };
}
