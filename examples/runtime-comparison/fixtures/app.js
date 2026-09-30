// Identical business logic for every adapter. All secrets here are test values.
export const TEST_KEY = "benchmark-test-key";
const buffers = ["x".repeat(4096), "x".repeat(65536), "x".repeat(524288)];
function reply(body, status = 200, type = "application/json") {
  return new Response(body, { status, headers: { "content-type": type } });
}
function order(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return reply('{"error":"json"}', 400);
  }
  if (
    !value ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate untrusted parsed JSON at the HTTP boundary.
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > 100
  ) {
    return reply('{"error":"order"}', 422);
  }
  let total = 0;
  for (let i = 0; i < value.items.length; i++) {
    const item = value.items[i];
    if (
      !item ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 100 ||
      !Number.isInteger(item.price) ||
      item.price < 0 ||
      item.price > 1000000
    ) {
      return reply('{"error":"item"}', 422);
    }
    total += item.quantity * item.price;
  }
  return reply(JSON.stringify({ id: value.id, count: value.items.length, total }));
}
async function signedOrder(body, signature) {
  if (signature.length !== 64 || !/^[0-9a-f]+$/.test(signature)) return reply('{"error":"signature"}', 401);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
  if (!valid) return reply('{"error":"signature"}', 401);
  return order(body);
}
function escape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function upstreamResponse(base, url) {
  const delay = url.searchParams.get("delay") || "0";
  if (!["0", "10", "50", "200"].includes(delay)) return reply('{"error":"delay"}', 400);
  try {
    const response = await fetch(
      base + "/data?delay=" + delay + "&fail=" + (url.searchParams.get("fail") === "1" ? "1" : "0"),
    );
    if (!response.ok) return reply('{"error":"upstream"}', 502);
    const text = await response.text();
    return reply(JSON.stringify({ bytes: text.length, first: text.slice(0, 1) }));
  } catch {
    return reply('{"error":"upstream"}', 502);
  }
}
export function dispatch(request, body, upstream) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/upstream") return upstreamResponse(upstream, url);
  if (path === "/health") return reply("ok", 200, "text/plain");
  if (path === "/order" || path === "/signed-order") {
    if (request.method !== "POST") return reply('{"error":"method"}', 405);
    if (path === "/signed-order") return signedOrder(body, request.headers.get("x-signature") || "");
    return order(body);
  }
  if (path === "/page") {
    const name = escape(url.searchParams.get("name") || "visitor");
    return reply(
      "<!doctype html><title>Hello</title><h1>Hello, " + name + "</h1><p>" + "small page ".repeat(800) + "</p>",
      200,
      "text/html; charset=utf-8",
    );
  }
  if (path === "/bytes") {
    const size = Number(url.searchParams.get("size") || 4096);
    if (size === 4096) return reply(buffers[0], 200, "application/octet-stream");
    if (size === 65536) return reply(buffers[1], 200, "application/octet-stream");
    if (size === 524288) return reply(buffers[2], 200, "application/octet-stream");
    return reply('{"error":"size"}', 400);
  }
  return reply('{"error":"route"}', 404);
}
