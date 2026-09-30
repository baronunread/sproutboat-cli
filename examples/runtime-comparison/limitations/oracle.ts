import assert from "node:assert/strict";
import { cases } from "./cases";
let checked = 0;
for (const c of cases) {
  if (c.async || c.name === "host-capabilities" || c.name === "body-shape") continue;
  const request = {
    url: "http://localhost/" + c.name + "?q=caff%C3%A8%20%F0%9F%9A%A4",
    text: () => c.body,
    json: () => JSON.parse(c.body || "{}"),
  };
  const result = new Function("request", c.code)(request);
  const actual =
    result instanceof Response
      ? result.headers.get("content-type")?.startsWith("application/json")
        ? await result.json()
        : await result.text()
      : result;
  assert.deepEqual(actual, c.expected, c.name);
  if (result instanceof Response) assert.equal(result.status, c.status || 200, c.name);
  checked++;
}
console.log(
  `Independent host reference passed ${checked} semantic cases. The request facade only supplies decoded body values; it does not verify native body method promise shapes.`,
);
