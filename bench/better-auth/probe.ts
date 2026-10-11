import { buildStandalone } from "../../src/standalone-build";
import { bundleHandler } from "../../src/bundle";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const output = await mkdtemp(join(tmpdir(), "sb-better-auth-"));
const binary = join(output, "worker");
const sourcePath = join(import.meta.dir, "handler.js");
try {
  const bundle = await bundleHandler(sourcePath, import.meta.dir);
  await buildStandalone({
    source: bundle.code,
    sourcePath,
    projectDir: import.meta.dir,
    config: { name: "better-auth-probe", main: "handler.js", compatibility_date: "2026-10-11" },
    outPath: binary,
    target: "host",
  });
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const child = Bun.spawn([binary], {
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  const base = `http://127.0.0.1:${port}/api/auth/`;
  async function call(path: string, body?: Record<string, string>, cookie?: string) {
    const start = performance.now();
    const headers = new Headers({ "content-type": "application/json", origin: "http://localhost:3000" });
    if (cookie) headers.set("cookie", cookie);
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    console.log(path, r.status, Math.round(performance.now() - start) + "ms");
    return { r, data: text ? JSON.parse(text) : null };
  }
  function cookies(r: Response) {
    return r.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
  }
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(base + "ok", { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    const payload = { email: "probe@example.com", password: "test-password-123", name: "Probe" };
    const signup = await call("sign-up/email", payload);
    assert.equal(signup.r.status, 200);
    assert.equal(signup.data.user.email, payload.email);
    const signupCookie = cookies(signup.r);
    assert(signupCookie.includes("session_token="));
    const session = await call("get-session", undefined, signupCookie);
    assert.equal(session.r.status, 200);
    assert.equal(session.data.user.email, payload.email);
    const bad = await call("sign-in/email", { ...payload, password: "wrong-password" });
    assert.equal(bad.r.status, 401);
    const signin = await call("sign-in/email", payload);
    assert.equal(signin.r.status, 200);
    const cookie = cookies(signin.r);
    assert(cookie.includes("session_token="));
    const signedIn = await call("get-session", undefined, cookie);
    assert.equal(signedIn.data.user.email, payload.email);
    const signout = await call("sign-out", {}, cookie);
    assert.equal(signout.r.status, 200);
    const after = await call("get-session", undefined, cookie);
    assert.equal(after.data, null);
    console.log("PASS: native signup, signed cookies, session, wrong password, signin and signout");
  } finally {
    child.kill(9);
    await child.exited;
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
