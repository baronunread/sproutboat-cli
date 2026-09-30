import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildStandalone } from "../../src/standalone-build";
import { preludePath } from "../../src/wrap";
const here = import.meta.dir;
const out = join(here, "results", "ingress-repro-" + Date.now());
mkdirSync(out, { recursive: true });
const source = `export default {
  async fetch(request) {
    const text = await request.text();
    const raw = request.body || "";
    const codes = [];
    const rawCodes = [];
    for (let i = 0; i < text.length && i < 60; i++) codes.push(text.charCodeAt(i));
    for (let i = 0; i < raw.length && i < 60; i++) rawCodes.push(raw.charCodeAt(i));
    let parsed = null;
    let parseError = false;
    try { parsed = JSON.parse(text); } catch { parseError = true; }
    const encoded = new TextEncoder().encode(text);
    const encodedBytes = [];
    for (let i = 0; i < encoded.length && i < 60; i++) encodedBytes.push(encoded[i]);
    return Response.json({ text, codes, rawCodes, encodedBytes, parsed, parseError, length: text.length });
  }
};`;
writeFileSync(join(out, "handler.js"), source);
console.log("Runtime:", preludePath.href);
const built = await buildStandalone({
  projectDir: out,
  config: { name: "ingress-repro", main: "handler.js", compatibility_date: "2026-09-01" },
  sourcePath: join(out, "handler.js"),
  source,
  target: "host",
  outPath: join(out, "sprout"),
});
const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = socket.port;
socket.stop(true);
const child = Bun.spawn([built.outPath], {
  env: { ...process.env, PORT: String(port), SB_DATA_DIR: join(out, "data") },
  stdout: "ignore",
  stderr: "inherit",
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      ready = true;
      break;
    } catch {}
    await Bun.sleep(50);
  }
  if (!ready) throw new Error("Native repro failed to start");
  const results = [];
  for (const body of ['{"id":"ascii"}', '{"id":"caffè"}', '{"id":"🚤"}', '{"id":"caffè-🚤"}']) {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const response = await res.json();
    const expectedCodes = Array.from({ length: body.length }, (_, index) => body.charCodeAt(index));
    const expectedBytes = Array.from(new TextEncoder().encode(body));
    results.push({
      input: body,
      response,
      textCodeUnitsMatch: JSON.stringify(response.codes) === JSON.stringify(expectedCodes),
      encodedBytesMatch: JSON.stringify(response.encodedBytes) === JSON.stringify(expectedBytes),
      jsonMatch: !response.parseError && response.parsed.id === JSON.parse(body).id,
    });
  }
  writeFileSync(join(out, "repro.json"), JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify(
      results.map((result) => ({
        input: result.input,
        textCodeUnitsMatch: result.textCodeUnitsMatch,
        encodedBytesMatch: result.encodedBytesMatch,
        jsonMatch: result.jsonMatch,
        response: result.response,
      })),
      null,
      2,
    ),
  );
  if (process.env.COMPARISON_LOCAL_RUNTIME) {
    for (const result of results)
      assert(result.textCodeUnitsMatch, "Native ingress must preserve every decoded UTF-16 code unit");
  }
} finally {
  child.kill(9);
  await child.exited;
}
