# Porffor patch + upstream note

## Local patch

`src/patch-porffor.ts` — an idempotent 2-line in-place edit of Porffor's
`compiler/render.js`. Makes the generated native-fetch server read its listen
port from `$PORT` at runtime, falling back to the compiled `port:` value.

Run from the build path (`compileWorker`), not a `postinstall` hook: package
managers block dependency lifecycle scripts by default, so a published
`postinstall` would silently not run.

This is the only thing keeping the CLI on the Porffor **source** dep
(`github:CanadaHonk/porffor#alpha-4`) instead of the prebuilt release binary
(`porffor-<host>.tar.gz`, ~2 MB, same commit). The prebuilt binary has no
`render.js` to patch. If the change below lands upstream, switch to the prebuilt
binary and drop both the source dep and the patch step.

Porffor's `AI_POLICY`: disclose AI use, and don't paste LLM prose — rewrite the
draft below in your own words before filing. File as an **issue**, not a PR
(the maintainer may want a general env binding instead of a `PORT` special case).

---

## Draft — rewrite before filing

**Title:** native-fetch: compiled server can't get its listen port at runtime

**Version:** `alpha-4` (`a415d19`), `porf native`, `export default { fetch }`.

### Problem

The port a native-fetch server listens on is fixed at compile time. The `port:`
field on the handler object is read by `runtime/native-fetch.js` while bundling
and rendered into the C as a constant; `porf_native_fetch_get_port()` returns
that constant unconditionally. The compiled binary parses no argv and reads no
environment, so nothing can tell it which port to use when it starts.

This blocks running more than one compiled handler on a host. A supervisor that
spawns many handlers assigns each a distinct port at spawn time — it can't, so
every handler has to be recompiled with its port baked in. "Compile once, run
anywhere" becomes "compile once per port".

### Repro

```js
// handler.js
export default {
  port: 3000,
  fetch() { return new Response("ok"); },
};
```

```
$ porf native handler.js -o handler
$ PORT=8080 ./handler
Porffor native fetch server listening on http://127.0.0.1:3000
```

Expected: some runtime input (env var or argv) selects the port. Actual: always
the compiled value.

### Suggested fix

Have `porf_native_fetch_get_port()` check `getenv("PORT")` first and fall back to
the compiled `port:` value. Smallest possible change, and it matches how
workerd/`wrangler dev` and most PaaS runtimes pick up a port.

A general `getenv` / `Porffor.env()` binding for handler code would also solve
this and cover other env-driven config, but that's a much larger surface — the
`PORT` read is enough to unblock multi-process hosting.

### What we do locally

A 2-line patch to `compiler/render.js` adding exactly that `getenv("PORT")`
branch. Happy to send it as a PR if the env-var shape is acceptable.

> Draft prepared with Claude (Claude Code); to be rewritten before filing.


---

## Second finding: a native-fetch binary cannot see its own argv

`porf_native_fetch_runtime_init()` calls `porf_init(0, NULL)`, so `porf_argc` /
`porf_argv` are empty for every native-fetch build. The regular native entry
point passes the real `argc`/`argv` from `main`, so the two paths disagree.

The effect is that a compiled `export default { fetch }` server can take no
command-line arguments at all — not a port, not a config path. Sproutboat works
around it by reading the environment (`PORT`, `SB_DATA_DIR`), which is fine for
systemd and docker but surprising for a binary someone runs by hand.

Worth raising alongside the `$PORT` ask above: both are the same shape of
problem, a compiled server with no way to be told anything at startup. Passing
the shim's `argc`/`argv` through to `porf_init` would solve both, without a
`PORT` special case.

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
