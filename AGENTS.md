# Agent instructions

## Writing: no em dashes

Do not use em dashes (`—`) in docs, READMEs, code comments, commit messages, or
issues. Use a colon when what follows explains what came before, a semicolon
when two clauses are balanced, a full stop when the second half can stand
alone, or commas for an aside.

An em dash is almost always one of those three doing a worse job, and a page of
them reads as machine-written.

## Before claiming something works

`bun test`, then both conformance harnesses:

    bun examples/kitchen-sink/harness.ts             # broker backend
    bun examples/kitchen-sink/harness-standalone.ts  # one binary

They exist because there are two implementations of the binding ops. A change
that passes one and not the other is drift, not a flake.

`bun run examples` builds all eight small examples and drives them. The
website's support table links to these, so a broken one makes the table lie.

## Compiler gaps

`patches/UPSTREAM.md` lists what Porffor cannot do yet and what was already
ruled out. Read it before working around something: Proxy, Web Crypto, streams
and the zod init crash are all recorded there with issue numbers.

When reducing a compiler bug, delete the binary before every compile and bind
port 0 for a free port. A stale binary answering for a failed build, or a port
collision with a leftover server, has produced false conclusions here twice.
