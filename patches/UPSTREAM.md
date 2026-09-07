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

Nothing upstream covers this: searched their issues for port, getenv,
process.env, argv and native fetch, all open and closed. Checked against
`main` at `a415d194`, which is the commit we pin.

Porffor's `AI_POLICY` asks that AI use is disclosed and that LLM prose is not
pasted. Rewrite the below in your own words before filing, and file it as an
**issue**, not a PR: the maintainer may prefer a general environment binding
over a `PORT` special case.

---

**Title:** native-fetch: a compiled server cannot be told its port

**Version:** `main` @ `a415d194`, `porf native`, `export default { fetch }`.

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
