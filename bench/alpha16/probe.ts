import { buildStandalone } from "../../src/standalone-build";
import { bundleHandler } from "../../src/bundle";
import { mkdir, rm } from "node:fs/promises";
for (const name of ["itty", "itty-simple", "qs", "trpc"]) {
  let child;
  try {
    const bundle = await bundleHandler(`${import.meta.dir}/${name}.js`, import.meta.dir);
    console.log(name, "bundle passed");
    const out = `${import.meta.dir}/${name}-out`;
    await rm(out, { recursive: true, force: true });
    await mkdir(out);
    const result = await buildStandalone({
      source: bundle.code,
      sourcePath: `${import.meta.dir}/${name}.js`,
      config: { name, main: `${name}.js`, compatibility_date: "2026-10-10" },
      projectDir: import.meta.dir,
      outPath: `${out}/worker`,
      target: "host",
    });
    console.log(name, "build", result);
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    child = Bun.spawn([`${out}/worker`], {
      env: { ...process.env, PORT: String(port) },
      stdout: "ignore",
      stderr: "inherit",
    });
    let response;
    for (let i = 0; i < 100; i++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/${name.startsWith("itty") ? "hello/sprout" : ""}`, {
          signal: AbortSignal.timeout(500),
        });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    console.log(name, "HTTP", response?.status, await response?.text());
    if (name.startsWith("itty"))
      for (const path of ["echo", "unknown"]) {
        const r = await fetch(`http://127.0.0.1:${port}/${path}`, {
          method: path === "echo" ? "POST" : "GET",
          body: path === "echo" ? "caffè 🚤" : undefined,
        });
        console.log(name, path, r.status, await r.text());
      }
  } catch (e) {
    console.log(name, "ERROR", String(e));
  } finally {
    child?.kill();
    if (child) await child.exited;
  }
}
