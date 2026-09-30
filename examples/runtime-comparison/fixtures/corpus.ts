import { createHmac } from "node:crypto";
export type Probe = {
  name: string;
  path: string;
  method?: string;
  body?: string;
  signature?: string;
  status: number;
  expected: string;
  type: string;
};
const json = "application/json";
const small = JSON.stringify({
  id: "order-1",
  items: [
    { quantity: 2, price: 125 },
    { quantity: 1, price: 99 },
  ],
  note: "x".repeat(850),
});
const large = JSON.stringify({ id: "caffè-🚤", items: [{ quantity: 3, price: 42 }], note: "x".repeat(16000) });
const signed = (body: string) => createHmac("sha256", "benchmark-test-key").update(body).digest("hex");
export const corpus: Probe[] = [
  { name: "health", path: "/health", status: 200, expected: "ok", type: "text/plain" },
  {
    name: "small order",
    path: "/order",
    method: "POST",
    body: small,
    status: 200,
    expected: '{"id":"order-1","count":2,"total":349}',
    type: json,
  },
  {
    name: "UTF-8 large order",
    path: "/order",
    method: "POST",
    body: large,
    status: 200,
    expected: '{"id":"caffè-🚤","count":1,"total":126}',
    type: json,
  },
  {
    name: "malformed JSON",
    path: "/order",
    method: "POST",
    body: "{",
    status: 400,
    expected: '{"error":"json"}',
    type: json,
  },
  {
    name: "missing fields",
    path: "/order",
    method: "POST",
    body: "{}",
    status: 422,
    expected: '{"error":"order"}',
    type: json,
  },
  {
    name: "invalid quantity",
    path: "/order",
    method: "POST",
    body: '{"id":"x","items":[{"quantity":0,"price":1}]}',
    status: 422,
    expected: '{"error":"item"}',
    type: json,
  },
  { name: "wrong method", path: "/order", status: 405, expected: '{"error":"method"}', type: json },
  {
    name: "signed small",
    path: "/signed-order",
    method: "POST",
    body: small,
    signature: signed(small),
    status: 200,
    expected: '{"id":"order-1","count":2,"total":349}',
    type: json,
  },
  {
    name: "signed UTF-8",
    path: "/signed-order",
    method: "POST",
    body: large,
    signature: signed(large),
    status: 200,
    expected: '{"id":"caffè-🚤","count":1,"total":126}',
    type: json,
  },
  {
    name: "wrong signature",
    path: "/signed-order",
    method: "POST",
    body: small,
    signature: "0".repeat(64),
    status: 401,
    expected: '{"error":"signature"}',
    type: json,
  },
  {
    name: "missing signature",
    path: "/signed-order",
    method: "POST",
    body: small,
    status: 401,
    expected: '{"error":"signature"}',
    type: json,
  },
  {
    name: "escaped page",
    path: "/page?name=%3C%26%22",
    status: 200,
    expected:
      "<!doctype html><title>Hello</title><h1>Hello, &lt;&amp;&quot;</h1><p>" + "small page ".repeat(800) + "</p>",
    type: "text/html; charset=utf-8",
  },
  ...[4096, 65536, 524288].map((size) => ({
    name: `bytes ${size}`,
    path: `/bytes?size=${size}`,
    status: 200,
    expected: "x".repeat(size),
    type: "application/octet-stream",
  })),
  { name: "invalid size", path: "/bytes?size=7", status: 400, expected: '{"error":"size"}', type: json },
  { name: "unknown route", path: "/missing", status: 404, expected: '{"error":"route"}', type: json },
  ...[0, 10, 50, 200].map((delay) => ({
    name: `upstream ${delay}ms`,
    path: `/upstream?delay=${delay}`,
    status: 200,
    expected: '{"bytes":4096,"first":"x"}',
    type: json,
  })),
  { name: "upstream failure", path: "/upstream?fail=1", status: 502, expected: '{"error":"upstream"}', type: json },
  { name: "invalid delay", path: "/upstream?delay=7", status: 400, expected: '{"error":"delay"}', type: json },
];
