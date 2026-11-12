#!/usr/bin/env bun
/**
 * Do the bytes of an upload survive the R2 binding, at 5 MB and at the 25 MB cap? Upload files
 * through the dashboard's own chunked route, read them back, compare sha256, try Range requests,
 * and check how each one is served.
 *
 *   bun r2-roundtrip.ts https://kitchen-sink.<account>.sproutboat.app [--sizes 5,25]
 *
 * conformance.ts runs the same function against the broker and the standalone binary, so a
 * deployed app can be held to what the two local backends already pass. Run against a deployed
 * app it makes six uploads of up to 25 MB from one address: that is 90 MB of the 100 MB a day
 * one address may upload, so run it once a day (--sizes 5 is 15 MB). Its files are deleted again at
 * the end, and anyway an hour after they were uploaded.
 */
import { createHash, randomBytes } from "node:crypto";
import { jsonObject, parseJsonValue, type JsonValue } from "../../src/json";

type Check = (name: string, cond: boolean, detail?: JsonValue) => void;
type Send = (url: string, init?: RequestInit) => Promise<Response>;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const MIB = 1024 * 1024;

/** n pseudo-random bytes, every value in them, the same each run. */
function noise(n: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = (x >>> 8) & 255;
  }
  return out;
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A 1x1 PNG and a 1x1 JPEG: real files, the smallest that decoders accept. */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  ),
  (c) => c.charCodeAt(0),
);

/** The 1x1 PNG with one private ancillary chunk of noise before its pixels: still a valid PNG, `target` bytes long. */
function paddedPng(target: number): Uint8Array {
  const payload = noise(target - PNG.length - 12, 0x1234567);
  const named = new Uint8Array(4 + payload.length);
  named.set(new TextEncoder().encode("ruSt"), 0);
  named.set(payload, 4);
  const chunk = new Uint8Array(12 + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  chunk.set(named, 4);
  view.setUint32(8 + payload.length, crc32(named));
  return concat([PNG.subarray(0, 33), chunk, PNG.subarray(33)]);
}

/** The 1x1 JPEG with comment segments of noise after its start marker: still a valid JPEG, `target` bytes long. */
function paddedJpeg(target: number): Uint8Array {
  const parts: Uint8Array[] = [JPEG.subarray(0, 2)];
  let left = target - JPEG.length;
  let seed = 0x7654321;
  while (left > 0) {
    const data = Math.min(65533, Math.max(0, left - 4));
    const segment = new Uint8Array(4 + data);
    segment[0] = 0xff;
    segment[1] = 0xfe;
    segment[2] = (data + 2) >> 8;
    segment[3] = (data + 2) & 255;
    segment.set(noise(data, seed++), 4);
    parts.push(segment);
    left -= segment.length;
  }
  parts.push(JPEG.subarray(2));
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Upload `bytes` the way the page does: one chunk per request. Waits out a per-minute 429 and carries on. */
export async function uploadFile(
  base: string,
  send: Send,
  chunkBytes: number,
  name: string,
  type: string,
  bytes: Uint8Array,
): Promise<{ status: number; body: JsonValue }> {
  const id = randomBytes(8).toString("hex");
  const count = Math.max(1, Math.ceil(bytes.length / chunkBytes));
  const none: JsonValue = null;
  let last = { status: 0, body: none };
  for (let n = 0; n < count; n++) {
    const part = bytes.subarray(n * chunkBytes, Math.min(bytes.length, (n + 1) * chunkBytes));
    const url = `${base}/api/r2/chunk?name=${encodeURIComponent(name)}&id=${id}&n=${n}&count=${count}&total=${bytes.length}&type=${encodeURIComponent(type)}`;
    for (let attempt = 0; ; attempt++) {
      const res = await send(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: part,
      });
      const text = await res.text();
      let body: JsonValue = text;
      try {
        body = parseJsonValue(text);
      } catch {}
      last = { status: res.status, body };
      const wait = Number(res.headers.get("retry-after"));
      if (res.status === 429 && jsonObject(body)?.code === "rate_limited" && attempt < 3) {
        await Bun.sleep(Math.min(65, Math.max(1, wait)) * 1000);
        continue;
      }
      break;
    }
    if (last.status >= 300) return last;
  }
  return last;
}

export async function runR2RoundTrip(
  base: string,
  check: Check,
  send: Send = fetch,
  options: { sizes?: number[] } = {},
): Promise<void> {
  const sizesMb = options.sizes ?? [5, 25];
  const info = jsonObject(parseJsonValue(await (await send(base + "/api/info")).text()));
  const chunk = Number(info?.chunk_bytes) || MIB;
  const cap = Number(info?.max_upload_bytes) || 25 * MIB;
  // One response sends at most this much of a file; a bigger file is read in Range windows.
  const most = Number(info?.max_response_bytes) || 2 * MIB;
  const fixture = new Uint8Array(await (await send(base + "/binary-fixture.bin")).arrayBuffer());
  check(
    "round trip: the fixture holds all 256 byte values",
    fixture.length === 256 && fixture.every((b, i) => b === i),
  );

  type Case = { name: string; type: string; bytes: Uint8Array; inline: boolean; ranges?: boolean };
  const cases: Case[] = [
    { name: "rt-fixture.bin", type: "application/octet-stream", bytes: fixture, inline: false },
    { name: "rt-pixel.png", type: "image/png", bytes: PNG, inline: true },
    { name: "rt-pixel.jpg", type: "image/jpeg", bytes: JPEG, inline: true },
    {
      name: "rt-script.svg",
      type: "image/svg+xml",
      bytes: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
      ),
      inline: false,
    },
    { name: "rt-zero.bin", type: "application/octet-stream", bytes: new Uint8Array(0), inline: false },
    // Only pictures, audio and video are shown in the browser: a document, a text file or a page is a download.
    {
      name: "rt-doc.pdf",
      type: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
      inline: false,
    },
    { name: "rt-note.txt", type: "text/plain", bytes: new TextEncoder().encode("a plain text note\n"), inline: false },
    {
      name: "rt-page.html",
      type: "text/html",
      bytes: new TextEncoder().encode("<!doctype html><script>alert(1)</script>"),
      inline: false,
    },
  ];
  for (const mb of sizesMb) {
    const size = Math.min(cap, mb * MIB);
    cases.push(
      {
        name: `rt-${mb}mb.bin`,
        type: "application/octet-stream",
        bytes: noise(size, mb),
        inline: false,
        ranges: mb === sizesMb[sizesMb.length - 1],
      },
      { name: `rt-${mb}mb.png`, type: "image/png", bytes: paddedPng(size), inline: true },
      { name: `rt-${mb}mb.jpg`, type: "image/jpeg", bytes: paddedJpeg(size), inline: true },
    );
  }

  for (const file of cases) {
    const put = await uploadFile(base, send, chunk, file.name, file.type, file.bytes);
    // The list says when the file is deleted: file_ttl_seconds after its upload.
    const listed = jsonObject(parseJsonValue(await (await send(base + "/api/r2")).text()));
    const entry = Array.isArray(listed?.objects)
      ? listed.objects.map((o) => jsonObject(o)).find((o) => o?.name === file.name)
      : undefined;
    const ttl = (Number(info?.file_ttl_seconds) || 3600) * 1000;
    const expires = Number(entry?.expires);
    check(
      `round trip: ${file.name} is listed with its expiry, ${ttl / 1000} s after the upload`,
      put.status === 201 && expires > Date.now() && expires <= Date.now() + ttl + 5000,
      { expires, now: Date.now(), ttl },
    );
    const stored = await send(base + "/api/r2/file?name=" + file.name);
    let back: Uint8Array;
    let reading = stored;
    if (file.bytes.length <= most) back = new Uint8Array(await stored.arrayBuffer());
    else {
      // Bigger than one response: a plain GET says to use Range, and the windows add up to the file.
      const refusal = jsonObject(parseJsonValue(await stored.text()));
      check(
        `round trip: a plain GET of ${file.name} (${file.bytes.length.toLocaleString("en-US")} bytes, over the ${most.toLocaleString("en-US")} one response sends) is refused with 413 and range_required`,
        stored.status === 413 && refusal?.code === "range_required" && stored.headers.get("accept-ranges") === "bytes",
        { status: stored.status, body: refusal },
      );
      const pieces: Uint8Array[] = [];
      let at = 0;
      while (at < file.bytes.length) {
        const res = await send(base + "/api/r2/file?name=" + file.name, {
          headers: { range: `bytes=${at}-${Math.min(file.bytes.length, at + most) - 1}` },
        });
        if (at === 0) reading = res;
        const piece = new Uint8Array(await res.arrayBuffer());
        if (res.status !== 206 || piece.length === 0) break;
        pieces.push(piece);
        at += piece.length;
      }
      back = concat(pieces);
    }
    const label = `${file.name} (${file.bytes.length.toLocaleString("en-US")} bytes)`;
    check(
      `round trip: ${label} comes back with the same sha256`,
      put.status === 201 &&
        (file.bytes.length <= most ? stored.status === 200 : reading.status === 206) &&
        back.length === file.bytes.length &&
        sha256(back) === sha256(file.bytes),
      {
        put: put.status,
        got: stored.status,
        sent: sha256(file.bytes),
        back: sha256(back),
        length: back.length,
        error: jsonObject(put.body)?.error ?? null,
      },
    );
    const disposition = reading.headers.get("content-disposition") ?? "";
    check(
      `round trip: ${file.name} is served as ${file.type}, ${file.inline ? "shown in the browser" : "as an attachment"}, never sniffed`,
      (reading.headers.get("content-type") ?? "").split(";")[0] === file.type &&
        disposition.startsWith(file.inline ? "inline" : "attachment") &&
        reading.headers.get("x-content-type-options") === "nosniff",
      { type: reading.headers.get("content-type"), disposition },
    );
    if (file.type === "image/svg+xml") {
      const policy = reading.headers.get("content-security-policy") ?? "";
      check(
        "round trip: an SVG is sandboxed with a CSP as well as sent as an attachment",
        policy.includes("sandbox") && policy.includes("default-src 'none'"),
        policy,
      );
    }
    if (file.ranges) {
      // A range inside a chunk, across the first boundary, the last bytes, from an offset to the end, and one outside the file.
      const want: Array<[string, number, number]> = [
        ["bytes=1000-2999", 1000, 2999],
        [`bytes=${chunk - 10}-${chunk + 9}`, chunk - 10, chunk + 9],
        ["bytes=-500", file.bytes.length - 500, file.bytes.length - 1],
        [`bytes=${file.bytes.length - 3000}-`, file.bytes.length - 3000, file.bytes.length - 1],
        // A range longer than one response is cut to it.
        ["bytes=0-", 0, Math.min(file.bytes.length, most) - 1],
      ];
      const results: JsonValue[] = [];
      let ok = true;
      for (const [header, start, end] of want) {
        const res = await send(base + "/api/r2/file?name=" + file.name, { headers: { range: header } });
        const part = new Uint8Array(await res.arrayBuffer());
        const same =
          res.status === 206 &&
          res.headers.get("content-range") === `bytes ${start}-${end}/${file.bytes.length}` &&
          sha256(part) === sha256(file.bytes.subarray(start, end + 1));
        ok &&= same;
        results.push({ header, status: res.status, range: res.headers.get("content-range"), length: part.length });
      }
      const outside = await send(base + "/api/r2/file?name=" + file.name, {
        headers: { range: `bytes=${file.bytes.length + 5}-` },
      });
      await outside.arrayBuffer();
      const head = await send(base + "/api/r2/file?name=" + file.name, { method: "HEAD" });
      check(
        `round trip: ${file.name} answers Range requests with 206 and the right bytes, 416 outside the file, HEAD without a body`,
        ok && outside.status === 416 && head.status === 200 && head.headers.get("accept-ranges") === "bytes",
        results,
      );
    }
    await send(base + "/api/r2?name=" + file.name, { method: "DELETE" });
  }
  const list = jsonObject(parseJsonValue(await (await send(base + "/api/r2")).text()));
  check(
    "round trip: every test file is deleted again",
    Array.isArray(list?.objects) && !list.objects.some((o) => String(jsonObject(o)?.name).startsWith("rt-")),
    list?.objects ?? null,
  );
}

if (import.meta.main) {
  const base = (process.argv[2] ?? "").replace(/\/$/, "");
  if (!base.startsWith("http")) {
    console.error("usage: bun r2-roundtrip.ts <base url of a deployed kitchen-sink> [--sizes 5,25]");
    process.exit(2);
  }
  const at = process.argv.indexOf("--sizes");
  const sizes =
    at > 0
      ? String(process.argv[at + 1])
          .split(",")
          .map(Number)
      : undefined;
  let failed = 0;
  await runR2RoundTrip(
    base,
    (name, cond, detail) => {
      console.log(
        (cond ? "  ok    " : "  FAIL  ") + name + (cond || detail === undefined ? "" : " " + JSON.stringify(detail)),
      );
      if (!cond) failed++;
    },
    fetch,
    { sizes },
  );
  process.exit(failed ? 1 : 0);
}
