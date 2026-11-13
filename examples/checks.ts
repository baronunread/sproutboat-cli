/**
 * What each public example is expected to do, as HTTP requests. One definition, two runtimes:
 *
 * - `smoke.ts` builds every example as a standalone binary and drives it;
 * - `workerd.ts` runs the same example, unchanged, under workerd (`wrangler dev`) and sends the same requests.
 *
 * An example that only works on Sproutboat fails the second run, which is the point: an example is a standard
 * Cloudflare Worker (see "Rules for examples" in README.md). The few places where Sproutboat deliberately does
 * more than Workers are named in `WORKERD_PARTIAL_SKIPS`; an example workerd cannot run at all is in
 * `WORKERD_SKIPS`. Each has its reason, and `src/examples-rules.test.ts` fails when an entry names no example.
 */
import type { JsonValue } from "../src/json";

export type Runtime = "standalone" | "workerd";
export type Ok = (name: string, cond: boolean, detail?: JsonValue) => void;
/** The runner's request functions (they carry its deadlines) and which runtime is under test. */
export type Context = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  text: (url: string, init?: RequestInit) => Promise<string>;
  runtime: Runtime;
};
export type Check = (base: string, ok: Ok, context: Context) => Promise<void>;

/** Every public example, by its directory under examples/. */
export const CHECKS = {
  hello: async (base, ok, { text }) => {
    ok("greets the world", (await text(base + "/")) === "Hello, world!\n");
    ok("reads the query string", (await text(base + "/?name=sprout")) === "Hello, sprout!\n");
  },

  "cf-json": async (base, ok, { fetch }) => {
    const response = await fetch(base + "/");
    ok("returns a JSON content type", response.headers.get("content-type")?.includes("application/json") === true);
    ok("returns the JSON object", JSON.stringify(await response.json()) === '{"hello":"world"}');
  },

  "cf-cookies": async (base, ok, { text }) => {
    ok(
      "reads a named cookie",
      (await text(base + "/", { headers: { cookie: "other=1; __uid=abc=123" } })) === "abc=123",
    );
    ok(
      "does not match a prefix",
      (await text(base + "/", { headers: { cookie: "__uid_extra=no" } })) === "No cookie with name: __uid",
    );
  },

  "cf-redirects": async (base, ok, { fetch }) => {
    const redirect = await fetch(base + "/old-guide?from=search", { redirect: "manual" });
    ok("redirects a mapped path", redirect.status === 301 && redirect.headers.get("location") === base + "/guide", {
      status: redirect.status,
      location: redirect.headers.get("location"),
    });
    ok("does not redirect an unmapped path", (await fetch(base + "/unknown", { redirect: "manual" })).status === 404);
  },

  "cf-headers": async (base, ok, { fetch }) => {
    const response = await fetch(base + "/");
    ok("returns the page", (await response.text()) === "Protected page");
    ok(
      "sets security headers",
      response.headers.get("x-content-type-options") === "nosniff" &&
        response.headers.get("x-frame-options") === "DENY" &&
        response.headers.get("content-security-policy") === "default-src 'none'",
    );
  },

  "cf-post": async (base, ok, { fetch, text }) => {
    const json = await fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"message":"hello"}',
    });
    ok(
      "reads JSON bodies",
      json.status === 200 && JSON.stringify(await json.json()) === '{"received":{"message":"hello"}}',
    );
    const invalid = await fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    ok("rejects malformed JSON", invalid.status === 400);
    ok(
      "reads text bodies",
      (await text(base + "/", { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" })) ===
        "hello",
    );
    ok(
      "rejects unsupported media",
      (
        await fetch(base + "/", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: "a",
        })
      ).status === 415,
    );
  },

  kv: async (base, ok, { fetch, text }) => {
    await fetch(base + "/greeting", { method: "PUT", body: "hello" });
    ok("get returns what put stored", (await text(base + "/greeting")) === "hello\n");
    ok("list includes the key", (await text(base + "/")).includes("greeting"));
    ok("a missing key is a 404", (await fetch(base + "/nope")).status === 404);
    await fetch(base + "/greeting", { method: "DELETE" });
    ok("delete removes it", (await fetch(base + "/greeting")).status === 404);
  },

  d1: async (base, ok, { fetch }) => {
    const created = await (await fetch(base + "/", { method: "POST", body: '{"title":"read the docs"}' })).json();
    ok("insert returns a row id", Number(created.id) > 0, created);
    const rows = await (await fetch(base + "/")).json();
    ok(
      "select returns the row",
      rows.some((r: { title: string }) => r.title === "read the docs"),
      rows,
    );
  },

  r2: async (base, ok, { fetch, text }) => {
    await fetch(base + "/notes.txt", { method: "PUT", body: "the file contents" });
    const got = await fetch(base + "/notes.txt");
    ok("get returns the body", (await got.text()) === "the file contents");
    ok("get returns an etag", !!got.headers.get("etag"));
    ok("list includes the key", (await text(base + "/")).includes("notes.txt"));
  },

  queue: async (base, ok, { fetch, text }) => {
    const sent = await fetch(base + "/", { method: "POST", body: '{"email":"someone@example.com"}' });
    ok("send accepts without waiting", sent.status === 202);
    // The consumer runs out of band — poll rather than assume it already has.
    let delivered = false;
    for (let i = 0; i < 40 && !delivered; i++) {
      delivered = (await text(base + "/")).includes("someone@example.com");
      if (!delivered) await Bun.sleep(250);
    }
    ok("the consumer received the message", delivered);
  },

  cron: async (base, ok, { text }) => {
    // Only that the handler and binding work: waiting for a */1 tick would put
    // a minute into every run. The cron firing itself is covered by the
    // kitchen-sink conformance suite.
    ok("reports a tick count before any tick", (await text(base + "/")).startsWith("0 ticks"));
  },

  "durable-object": async (base, ok, { text }) => {
    ok("first call to a name is 1", (await text(base + "/downloads")) === "downloads: 1\n");
    ok("the same name keeps counting", (await text(base + "/downloads")) === "downloads: 2\n");
    ok("a different name is its own object", (await text(base + "/signups")) === "signups: 1\n");
  },

  assets: async (base, ok, { fetch }) => {
    const home = await fetch(base + "/");
    ok("serves index.html from public/", (await home.text()).includes("Served from public/"));
    ok("with an html content-type", (home.headers.get("content-type") || "").includes("text/html"));
    const api = await (await fetch(base + "/api/time")).json();
    ok("run_sprout_first gives /api to the handler", !Number.isNaN(Date.parse(String(api.now))), api);
  },

  analytics: async (base, ok, { fetch, runtime }) => {
    const sent = await fetch(base + "/", { method: "POST", body: '{"path":"/pricing"}' });
    ok("writeDataPoint accepts a point", sent.status === 202);
    if (runtime === "workerd") return; // query() is a Sproutboat extension: see WORKERD_PARTIAL_SKIPS
    const rows = await (await fetch(base + "/")).json();
    ok(
      "query returns the recorded point",
      rows.some((r: { blobs: string[] }) => r.blobs[0] === "/pricing"),
      rows,
    );
  },

  upload: async (base, ok, { fetch, runtime }) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode("first "));
        await Bun.sleep(400);
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.close();
      },
    });
    const init: RequestInit & { duplex: string } = { method: "POST", body, duplex: "half" };
    const counted = await (await fetch(base + "/", init)).json();
    ok(
      "the handler reads the body as it arrives",
      // How far apart the chunks arrive is how this server paces a connection; workerd may coalesce them.
      counted.bytes === 6 + 8 * 1024 * 1024 && (runtime === "workerd" || counted.spreadMs > 200),
      counted,
    );
  },

  request: async (base, ok, { fetch }) => {
    const forwarded = await (
      await fetch(base + "/forward", { method: "POST", headers: { "x-from": "client" }, body: "hi é" })
    ).json();
    ok(
      "a copy of the incoming request keeps its method, headers and body",
      JSON.stringify(forwarded) ===
        JSON.stringify({
          url: "https://upstream.example/echo",
          method: "POST",
          from: "client",
          body: "hi é",
          incomingUsed: true,
        }),
      forwarded,
    );
    const rules = await (await fetch(base + "/rules")).json();
    ok(
      "init merges, clone() tees, a used body cannot be copied, GET refuses a body, incoming headers are immutable",
      JSON.stringify(rules) ===
        JSON.stringify({
          merged: ["PUT", [["x-b", "2"]], "abc", "abc"],
          originalUsed: true,
          copyUsed: "TypeError: Cannot reconstruct a Request with a used body.",
          getWithBody: "TypeError: Request with a GET or HEAD method cannot have a body.",
          immutable: "TypeError: Can't modify immutable headers.",
        }),
      rules,
    );
  },

  "outbound-fetch": async (base, ok, { fetch, text, runtime }) => {
    ok("fetches a public host", (await text(base + "/")).startsWith("example.com answered with 200"));
    if (runtime === "workerd") return; // the private-address refusal is Sproutboat policy: see WORKERD_PARTIAL_SKIPS
    ok("refuses a private address", (await fetch(base + "/blocked")).status === 403);
  },

  ratelimit: async (base, ok, { fetch }) => {
    let last = 200;
    for (let i = 0; i < 4; i++) last = (await fetch(base + "/limited")).status;
    ok("the 4th request over the limit is a 429", last === 429);
  },

  "vars-secrets": async (base, ok, { text }) => {
    ok(
      "reads the baked-in var and the injected secret",
      (await text(base + "/")) === "hej, your key ends in ...-key\n",
    );
  },

  waituntil: async (base, ok, { text }) => {
    ok("answers before the background write", (await text(base + "/")) === "ok\n");
    // The write runs after the response: poll rather than assume it already has.
    let stored = "";
    for (let i = 0; i < 40 && !/^\d+$/.test(stored); i++) {
      stored = await text(base + "/check");
      if (!/^\d+$/.test(stored)) await Bun.sleep(100);
    }
    ok("the background write landed", /^\d+$/.test(stored), stored);
  },

  "quote-service": async (base, ok, { fetch }) => {
    const quote = await (await fetch(base + "/random")).json();
    ok("/random is a quote", Boolean(quote.content) && Boolean(quote.author), quote);
    const index = await (await fetch(base + "/")).json();
    ok("/ says what the service is", index.service === "quote-service", index);
    ok("an unknown path is a 404", (await fetch(base + "/nope")).status === 404);
  },

  "service-bindings/callee": async (base, ok, { text }) => {
    ok("greets by name", (await text(base + "/?name=sprout")) === "hello, sprout, from the callee\n");
  },

  // The caller reaches the callee through a service binding, so this one needs an edge (workerd runs both).
  "service-bindings/caller": async (base, ok, { text }) => {
    ok(
      "the callee answers through the binding",
      (await text(base + "/?name=sprout")) === "hello, sprout, from the callee\n",
    );
    ok("the default name", (await text(base + "/")) === "hello, there, from the callee\n");
  },
} satisfies Record<string, Check>;

/** Examples with no standalone binary: the standalone runner (smoke.ts) leaves them out. */
export const STANDALONE_SKIPS = new Map([
  ["service-bindings/caller", "a standalone binary has no edge to route a service binding through"],
]);

/** Secret values for the examples that declare any: workerd reads them from .dev.vars, a binary from its environment. */
export const SECRETS = new Map([["vars-secrets", { API_KEY: "demo-key" }]]);

/**
 * Examples workerd does not run, with why. Empty means every public example runs there; an entry is a promise to
 * say why, and the README's rules name the same list.
 */
export const WORKERD_SKIPS = new Map([
  [
    "kitchen-sink",
    "its entry points still read env as a global and it carries conformance routes; the kitchen-sink split moves both and removes this entry",
  ],
]);

/**
 * Examples whose requests are only partly sent to workerd, where Sproutboat does something on purpose that Workers
 * does not. The first comment of the example and its README say so too.
 */
export const WORKERD_PARTIAL_SKIPS = new Map([
  [
    "analytics",
    "query() reads data points back, which is a Sproutboat extension: Workers' Analytics Engine is write-only",
  ],
  [
    "outbound-fetch",
    "refusing a private address (169.254.169.254) is Sproutboat's egress policy; workerd would try to connect",
  ],
  [
    "upload",
    "the 200 ms spread between the first and last chunk is how this runtime paces a connection; workerd may coalesce them",
  ],
]);

/**
 * Examples checked against Cloudflare's own runtime types, which an API only Sproutboat has fails. Same rule as
 * above: an entry says why the example cannot pass.
 */
export const CLOUDFLARE_TYPES_SKIPS = new Map([
  ["analytics", "env.EVENTS.query() is a Sproutboat extension and is not in Cloudflare's AnalyticsEngineDataset"],
]);
