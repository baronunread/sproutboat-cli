# Native fetch runtime port draft

Nothing upstream covers this: searched their issues for port, getenv,
process.env, argv and native fetch, all open and closed. Checked against
`alpha-5` @ `1f4ae4ae`, which was the pin at the time.

Porffor's `AI_POLICY` asks that AI use is disclosed and that LLM prose is not
pasted. Rewrite the below in your own words before filing, and file it as an
**issue**, not a PR: the maintainer may prefer a general environment binding
over a `PORT` special case.

---

**Title:** native-fetch: a compiled server cannot be told its port

**Version:** `alpha-5` @ `1f4ae4ae`, `porf native`, `export default { fetch }`.

## Problem

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

## Why it matters

Running more than one compiled handler on a host means assigning each a port at
spawn time. Today that is impossible, so every handler has to be recompiled per
port, and "compile once, run anywhere" becomes "compile once per port". Any
supervisor, container platform or PaaS hits this immediately, since $PORT is
the near-universal convention.

## Repro

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

## Two possible fixes

1. Smallest: have `porf_native_fetch_get_port()` read `getenv("PORT")` first
   and fall back to the compiled `port:`. Matches workerd, `wrangler dev` and
   most PaaS runtimes.
2. More general, and fixes both halves: pass the real `argc` / `argv` into
   `porf_init` from the native-fetch entry point, so a compiled server can take
   arguments like any other program. That covers config paths too, not just the
   port.

Happy to send either as a PR if one of the shapes is acceptable.
