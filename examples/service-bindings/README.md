# Service bindings

Two deployments, on the same self-hosted node: `caller` reaches `callee`
through `env.GREETER.fetch()`, routed via the node's edge rather than going
back out to the internet. This is `platform`-only - a standalone binary has
no edge to route through, so it can't do this at all (`standalone: "no"` in
the support table).

That also means it's the one example not exercised by `bun run examples`,
which only builds standalone binaries. Verify it against a real self-hosted
node instead:

```sh
cd callee && sproutboat deploy   # deploys as "service-bindings-callee"
cd ../caller && sproutboat deploy   # deploys as "service-bindings-caller",
                                     # with the GREETER binding wired to it

curl "https://<caller's URL>/?name=sprout"
# -> hello, sprout, from the callee
```

Both `sproutboat.jsonc` files hard-code their project names
(`service-bindings-callee`/`-caller`) so the binding resolves without extra
setup - rename either before deploying if the names collide with something
you already run on your node.
