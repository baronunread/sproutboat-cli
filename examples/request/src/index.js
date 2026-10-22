// Request as in Workers, from compatibility date 2026-10-23: new Request(request, init)
// and fetch(request, init) keep the request's method, headers, body, redirect mode and
// signal unless init replaces them, and a body can be used only once.
//
//   curl -X POST --data 'hi' localhost:8080/forward   # copies the incoming request
//   curl localhost:8080/rules                          # what Workers enforces

const attempt = (step) => {
  try {
    return step();
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/forward") {
      // The proxy idiom: a new URL, everything else from the incoming request.
      const upstream = new Request("https://upstream.example/echo", request);
      return Response.json({
        url: upstream.url,
        method: upstream.method,
        from: upstream.headers.get("x-from"),
        body: await upstream.text(),
        incomingUsed: request.bodyUsed,
      });
    }
    if (url.pathname === "/rules") {
      const original = new Request("https://example.com/", { method: "POST", headers: { "x-a": "1" }, body: "abc" });
      const merged = new Request(original, { method: "PUT", headers: { "x-b": "2" } });
      const branch = merged.clone();
      return Response.json({
        merged: [merged.method, [...merged.headers], await merged.text(), await branch.text()],
        originalUsed: original.bodyUsed,
        copyUsed: attempt(() => new Request(original).url),
        // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- the point: Workers throws here.
        getWithBody: attempt(() => new Request("https://example.com/", { body: "x" }).url),
        immutable: attempt(() => request.headers.set("x-c", "3")),
      });
    }
    return new Response("try /forward or /rules\n", { status: 404 });
  },
};
