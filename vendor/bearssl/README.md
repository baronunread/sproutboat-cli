# Vendored BearSSL source

`bearssl-7bea48e.tar.gz` is the BearSSL source snapshot the CLI builds embedded sprouts against. It ships in the
npm package (and is embedded in standalone binaries), so a build needs no network access to bearssl.org, which
returned HTTP 502 for hours on 2026-11-04.

- Origin: https://bearssl.org/gitweb/?p=BearSSL;a=snapshot;h=7bea48e5e850ab4cafbe68d3765cdaba13a86d6f;sf=tgz
- Commit: `7bea48e5e850ab4cafbe68d3765cdaba13a86d6f` (`7bea48e5`; `git get-tar-commit-id` agrees)
- sha256: `ed397832b1613582737d9c1ce01c1af74ad6a9e9c52a341e24433987cda0f372`
- License: MIT, see `LICENSE.txt` (copied from the tarball)

`src/bearssl.ts` pins the sha256 and `fetchPinned` (`src/fetch-pinned.ts`) rejects this file if it does not match,
then falls back to bearssl.org. To update: replace the tarball, then change `BEARSSL_COMMIT`, `BEARSSL_SHA256` and
the import path in `src/bearssl.ts`.
