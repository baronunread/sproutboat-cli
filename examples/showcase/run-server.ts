/** Start a dev server for the checks, wait for /healthz, and always stop exactly the process we started. */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

export async function withServer<T>(
  command: (port: number) => string[],
  cwd: string,
  use: (base: string) => Promise<T>,
  env: (port: number) => Record<string, string> = () => ({}),
): Promise<T> {
  const port = freePort();
  const child = Bun.spawn(command(port), {
    cwd,
    env: { ...process.env, ...env(port) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 600; i++) {
      if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode} before it was ready`);
      try {
        if ((await fetch(base + "/healthz")).ok) return await use(base);
      } catch {}
      await Bun.sleep(500);
    }
    throw new Error("server did not become ready in 5 minutes");
  } finally {
    child.kill("SIGINT");
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
