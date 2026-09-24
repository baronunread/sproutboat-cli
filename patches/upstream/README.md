# Porffor upstream notes

These files record Sproutboat's Porffor patches, upstream gaps, and drafts.
Some findings were written against older Porffor pins; check the version in
each note and reproduce on current `main` before filing. Porffor's
[`AI_POLICY`](https://github.com/CanadaHonk/porffor/blob/main/AI_POLICY.md)
requires AI use to be disclosed and PR descriptions and comments to be written
by the contributor. The drafts here are investigation notes for review, not
ready-to-post text.

| Note | Contents |
| --- | --- |
| [Local patches](local-patches.md) | Historical patch inventory and source-pin rationale |
| [Runtime port](runtime-port.md) | Native fetch listener port draft |
| [Status lines](status-lines.md) | Unlisted HTTP status codes (#156) |
| [Console output](console-output.md) | Buffered handler output (#165) |
| [Remote address](remote-address.md) | Client address exposure (#163) |
| [UTF-8 wire encoding](utf8-wire-encoding.md) | Response bytestring encoding (#172) |
| [TypedArray.from](typedarray-from-arraylike.md) | Array-like input draft |
| [Tracked issues](tracked-issues.md) | Proxy and Web Crypto gaps |
| [Zod module init](zod-module-init.md) | Reduced startup failure and related finding |
| [Promise resolution](promise-resolution-livelock.md) | Resumed async turn investigation and local fix |
