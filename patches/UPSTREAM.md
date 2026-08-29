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
(the maintainer may want a general env binding rather than a `PORT` special case).

---

## Draft — rewrite before filing

**Title:** native-fetch: compiled server can't get its listen port at runtime

**Version:** `alpha-4` (`a415d19`), `porf native`, `export default { fetch }`.

### Problem

The port a native-fetch server listens on is fixed at compile time. The `port:`
field on the handler object is read by `runtime/native-fetch.js` while bundling
and rendered into the C as a constant; `porf_native_fetch_get_port()` returns
that constant unconditionally. The compiled binary parses no argv and reads no
environment, so there is no way to tell it which port to use when it starts.

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
