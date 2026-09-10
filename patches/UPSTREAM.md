# Porffor patch + upstream note

## Local patch

`src/patch-porffor.ts` — idempotent, marker-guarded in-place edits of Porffor's
generated C. Each is independent and re-applied on every build:

- `compiler/render.js` — the native-fetch server reads its listen port from
  `$PORT` at runtime (falling back to the compiled `port:`), and routes handler
  `console` output to stderr, unbuffered (#165).
- `compiler/index.js` — `SB_EXTRA_LINK` / `SB_EXTRA_CFLAGS` splice points so a
  standalone build can link SQLite / include `<bearssl.h>` (#15).
- `compiler/uwebsockets.js` — configurable request-body limit (#56), the #156
  status-line fix, and the #163 `x-sb-remote-addr` synthetic header — all below.

The pin lives in `src/porffor-toolchain.ts` (`PORFFOR_CHANNEL` /
`PORFFOR_COMMIT_FULL`), currently **alpha-5** (`1f4ae4ae`). Patches are applied
from the build path, not a `postinstall` hook: package managers block dependency
lifecycle scripts by default, so a published `postinstall` would silently not
run.

This patch step is the only thing keeping the CLI on Porffor **source**
(`github:CanadaHonk/porffor#<channel>`) rather than the prebuilt release binary
(`porffor-<host>.tar.gz`, ~2 MB, same commit) — the prebuilt binary has no
`render.js` to patch. If every edit below lands upstream, switch to the prebuilt
binary and drop the patch step.

Porffor's `AI_POLICY`: disclose AI use, and don't paste LLM prose — rewrite the
draft below in your own words before filing. File as an **issue**, not a PR
(the maintainer may want a general env binding instead of a `PORT` special case).

---

## Draft — rewrite before filing

Nothing upstream covers this: searched their issues for port, getenv,
process.env, argv and native fetch, all open and closed. Checked against
`alpha-5` @ `1f4ae4ae`, which is the commit we pin.

Porffor's `AI_POLICY` asks that AI use is disclosed and that LLM prose is not
pasted. Rewrite the below in your own words before filing, and file it as an
**issue**, not a PR: the maintainer may prefer a general environment binding
over a `PORT` special case.

---

**Title:** native-fetch: a compiled server cannot be told its port

**Version:** `alpha-5` @ `1f4ae4ae`, `porf native`, `export default { fetch }`.

### Problem

The listen port is fixed at compile time. `compiler/render.js:1521`:

```c
f64 porf_native_fetch_get_port(void) {
  return __porffor_native_fetch_port.val;
}
```

That value comes from the `port:` field on the handler object, read while
bundling and rendered into the C as a constant. Nothing at runtime can change
it.

The environment is not a way out either, because there is no argv to fall back
on: `porf_native_fetch_runtime_init()` calls `porf_init(0, NULL)`
(`render.js:1481`), so `porf_argc` / `porf_argv` are empty for every
native-fetch build, while the regular native entry point passes `main`'s
through. The two paths disagree.

So a compiled `export default { fetch }` server can be told nothing at startup:
not a port, not a config path.

### Why it matters

Running more than one compiled handler on a host means assigning each a port at
spawn time. Today that is impossible, so every handler has to be recompiled per
port, and "compile once, run anywhere" becomes "compile once per port". Any
supervisor, container platform or PaaS hits this immediately, since $PORT is
the near-universal convention.

### Repro

```js
// handler.js
export default { port: 3000, fetch() { return new Response("ok"); } };
```

```
$ porf native handler.js -o handler
$ PORT=8080 ./handler
Porffor native fetch server listening on http://127.0.0.1:3000
```

Expected: some runtime input selects the port. Actual: always the compiled
value.

### Two possible fixes

1. Smallest: have `porf_native_fetch_get_port()` read `getenv("PORT")` first
   and fall back to the compiled `port:`. Matches workerd, `wrangler dev` and
   most PaaS runtimes.
2. More general, and fixes both halves: pass the real `argc` / `argv` into
   `porf_init` from the native-fetch entry point, so a compiled server can take
   arguments like any other program. That covers config paths too, not just the
   port.

Happy to send either as a PR if one of the shapes is acceptable.

---

## #156 — `lookup_status_line()` resets the connection for unlisted codes

**Version:** `alpha-5` @ `1f4ae4ae`, `compiler/uwebsockets.js`, native-fetch build.

`lookup_status_line(i32 status)` is a `switch` mapping status codes to reason
strings for `res->writeStatus()`. Its `default` returns an empty
`std::string_view`, so any code not in the switch — 303, 206, 300, 305, 402,
451, … — produces `writeStatus({})`, a malformed status line, and the client
sees a connection reset (`curl` reports `000`). Only the embedded/standalone
response path is affected; a deployed sprout's Response travels as frame JSON
and the broker's own HTTP stack serializes the status line.

**Local patch** (`src/patch-porffor.ts`, `patchUwebsockets`): widen the return
type to `std::string` and make `default` synthesize `"<code> Status"` from the
number, so every code produces a well-formed line. Add `case 303: return "303
See Other";` for the common one's real phrase. The sole caller feeds the result
straight to `writeStatus`, which copies synchronously, so returning by value is
safe.

**Upstream shape** (rewrite before filing, per `AI_POLICY`; file as an issue):
the `default` case should still yield a syntactically valid status line rather
than an empty one — either a synthesized `"<code> \r\n"` or the full IANA table.
A silent connection reset for a valid HTTP status is the worst failure mode.

Repro: `porf native` a handler that returns `new Response("", { status: 303 })`
and `curl` it — connection reset. `302`/`307` are fine.

---

## #165 — native-fetch drops handler `console` output when stdout is not a TTY

**Version:** `alpha-5` @ `1f4ae4ae`, `compiler/render.js`, native-fetch build.

A handler's `console.log` / `console.error` reaches `__Porffor_printString`,
which writes to **stdout** via `printf`. When stdout is a pipe or a file (a
service manager, a container, anything but an interactive terminal) the C
runtime makes it fully buffered, and the native-fetch server loop never
returns, so `fflush` / `exit`-time flush never happens. The output is simply
lost — no error, nothing on stdout or stderr, during the run or after a clean
signal. Porffor's own banner and diagnostics go to stderr, so only the
handler's logs disappear.

**Local patch** (`src/patch-porffor.ts`, `patchRenderJs`): in
`porf_native_fetch_runtime_init`, `dup2(2, 1)` to route stdout at the handler's
`console` to stderr, and `setvbuf(stdout, NULL, _IONBF, 0)` so records appear as
they happen.

**Upstream shape** (rewrite before filing, per `AI_POLICY`; file as an issue):
the native-fetch server should flush stdout (line-buffered at least), or send
`console` to stderr as most server runtimes do. A long-lived server that
silently swallows every log line until it exits is a sharp edge for anyone
running a compiled handler under a supervisor.

Repro: `porf native` a handler with `console.log("x")` in `fetch`, run it with
stdout redirected to a file, hit it — the file stays empty.

---

## #163 — a native-fetch handler cannot see the connection's remote address

**Version:** `alpha-5` @ `1f4ae4ae`, `compiler/uwebsockets.js`, native-fetch build.

`collect_headers()` takes only `uWS::HttpRequest*`, and nothing else about the
connection reaches the handler. `uWS::HttpResponse::getRemoteAddressAsText()`
has the peer address right there, but the handler has no way to it — so every
app behind a proxy hand-rolls `X-Forwarded-For` parsing, and every app in front
of one has no client IP at all. workerd (`request.cf`), `Deno.serve`
(`info.remoteAddr`) and `Bun.serve` (`server.requestIP`) all expose it.

**Local patch** (`src/patch-porffor.ts`, the `HDR_*` entries): `collect_headers`
grows a `res` argument and appends one synthetic request header,
`x-sb-remote-addr: <res->getRemoteAddressAsText()>`, after dropping any inbound
header of that name. The prelude reads it into `request.cf.clientIp`, folds
IPv4-mapped IPv6, and resolves it against `SB_TRUSTED_PROXIES` +
`X-Forwarded-For`.

**Upstream shape** (rewrite before filing, per `AI_POLICY`; file as an issue):
expose the remote address to a native-fetch handler — on `request` (a
documented field, or `request.cf` for workerd parity), or as a second argument
to `fetch`. The IPv4-mapped-IPv6 form uWS returns for v4 clients on a
dual-stack socket is worth normalising there too.

Repro: `porf native` any `export default { fetch }` — there is no property or
argument carrying the client's IP.

---

## Upstream issues we depend on

Filed and tracked at `CanadaHonk/porffor`. None of these are things to fix
locally: each is a language or platform gap that only makes sense in the
compiler. Recorded here so the next person checks the issue before writing a
workaround.

| # | What | Why it matters here |
| --- | --- | --- |
| [#145](https://github.com/CanadaHonk/porffor/issues/145) | `Proxy` support | `new Proxy` compiles and silently ignores every trap |
| [#347](https://github.com/CanadaHonk/porffor/issues/347) | Web Crypto | no `crypto.*` at all; blocks any auth library |
| [#349](https://github.com/CanadaHonk/porffor/issues/349) | Streams | a response body is one whole string |
| [#350](https://github.com/CanadaHonk/porffor/issues/350) | Coroutine stack corruption on native fetch exception | an async handler that throws |

### #145 — `Proxy`, and why we reject it at build time

`compiler/builtins/object.ts` validates the two arguments and returns the
target. No trap ever runs, so a program using a Proxy reads wrong values rather
than failing: `p.a` returns the target's `a`, and `p.b = 5` is discarded. Of
337 Proxy tests in test262, the 14 that pass are argument-validation tests the
stub satisfies by accident.

**We cannot shim this.** A JavaScript-level Proxy shim can only intercept
properties it can enumerate at construction time, using `defineProperty`
getters — which is the one case where the caller did not need a Proxy. Google's
`proxy-polyfill` has the same limitation for the same reason: intercepting a
read of a key nobody knew about needs the engine.

So `src/source.ts` rejects `new Proxy` at build time instead. That is the whole
of the local fix, and it is the right one: it converts a silent wrong answer
into a build error naming the cause. It is why itty-router and other
Proxy-based routers do not work, and why better-auth does not build (its env
shim is a Proxy).

### #347 — Web Crypto, and what we ship meanwhile

Upstream provides `globalThis.crypto = {}` in `runtime/fetch-globals.js` and
nothing on it. The issue is labelled `C-wintercg`, so server-side web APIs are
in scope upstream — this is not a case of us filling in something the compiler
considers out of bounds.

`src/native-fetch-prelude.js` shims `crypto.getRandomValues` and
`crypto.randomUUID` over OS entropy. There is no `crypto.subtle`, which is what
an auth library actually needs: better-auth alone calls `importKey`, `sign`,
`digest`, `encrypt` and `decrypt` across 17 sites.

A `subtle` subset is worth building here rather than waiting, for reasons that
are ours and not upstream's: standalone builds already link BearSSL (SHA-256,
HMAC, AES, EC), a deployed sprout does not link it at all and would need the
broker or a second link line, and that split is a Sproutboat problem that means
nothing in the compiler. Keep the surface standard so it can be dropped when
upstream lands theirs.

---

## Open finding: zod compiles, then dies at module init

Not filed yet — the reproducer below is small and reliable but has not been
reduced to a language construct, and #145's own thread shows the maintainer
would rather have the construct than a library.

**Still reproduces on alpha-5** (`1f4ae4ae`), unchanged: the reduced
`$constructor` snippet below builds and then dies with the same
`Uncaught TypeError: Cannot read property of undefined` at init, server never
binds. alpha-5's slot-based closure-env rewrite and loop-capture fixes did not
touch it. So bumping the pin does not unblock zod / better-auth.

zod matters more than any one library: `better-auth`, and a large slice of
everything else, depends on it. It is the gate in front of most of npm.

### What happens

```sh
# handler.js: import { z } from "zod"; export default { fetch(){ … } }
COMPILED in 21s — 2.1 MB          # 145 KB of bundled zod, compiles fine
$ PORT=8791 ./out.bin
Uncaught TypeError: Cannot read property of undefined
```

The crash is at module initialisation — before the server listens — and is
deterministic (6/6 runs of one binary). Moving the schema construction inside
the handler does not help, so it is zod's own top-level setup.

### Reduced to

```js
import { $constructor } from "zod/v4/core/core.js";
// Importing core.js and never calling this: fine.
// Calling it once, with no Parent and a trivial initializer: crash.
const C = $constructor("C", (inst) => { inst._zod ??= {}; });
```

`$constructor` is ~40 lines (`zod/v4/core/core.js`). Something it runs *when
called* is the trigger.

### Ruled out

Each verified individually as a compiled sprout that serves a request:

- `new WeakSet([Object.prototype, Error.prototype])`
- `class D extends P` where `P` is a runtime value (`Object` and `Error`)
- `Object.defineProperty(fn, "name", …)` and `fn.prototype = obj` before `new`
- `Object.getOwnPropertyDescriptor` over `for…in` keys, including a getter
- optional chaining on an undefined argument or omitted parameter
- `"captureStackTrace" in Error`
- the `node()` helper from `errors.js`, in isolation

### A separate bug found on the way

`Symbol.hasInstance` is ignored. `instanceof` does not consult it:

```js
function f() {}
Object.defineProperty(f, Symbol.hasInstance, { value: () => true });
({}) instanceof f;   // false on Porffor, true everywhere else
```

Same shape as #145: a silent wrong answer rather than an error. Worth filing on
its own once confirmed against `main`; zod uses exactly this to make
`instanceof` work across its class hierarchy.

### Harness note for whoever picks this up

Reduce with a runner that deletes the binary before each compile and binds port
0 to pick a free port. An earlier pass here reported false passes both ways: a
stale `out.bin` answered for a compile that had failed to bundle, and a random
port collided with a server left over from a previous case. Two rounds of
conclusions had to be thrown away.
