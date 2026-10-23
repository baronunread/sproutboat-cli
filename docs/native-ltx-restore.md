# Native offline LTX restore

Build an optional restore startup mode into a standalone executable:

```sh
sproutboat build --standalone --with-restore --target host
./dist/my-app ltx-restore --generation /backups/DB.sqlite.ltx/epoch-xxxxxx \
  --output /private/restore/new.sqlite
```

Use `--txid 42` to stop at a known decimal transaction ID. Omit `--target host`
to cross-compile the static Linux x86-64 executable. The deployed executable
needs no Node, Bun, SQLite CLI or other service. `ltx-restore --help` prints the
native command's usage. Exit status 0 means verified publication; 1 means an
operational failure, and 2 means invalid arguments. Success prints JSON with
TXID, checksum and byte count to stdout; diagnostics go to stderr.

The option works only with `--standalone`, not `--emit-only`. Ordinary builds
include no restore object or dispatch. For those builds `ltx-restore` remains
an ordinary unused server argument. Runtime environment variables never enable
the mode: only the exact native subcommand dispatches it.

## Input and destination

Stop the source writer, or supply a complete immutable copy of one generation.
An existing capture ownership lock is acquired without waiting and held through
restore. An active owner is refused. An archive copy without a lock is accepted
only on the caller's promise that it remains immutable. No live restore or
in-place replacement is supported.

Use an explicit epoch directory. Only the one-TXID-per-file format emitted by
native capture is accepted. A complete contiguous filename range must start at
TXID 1; invalid names and gaps are refused even beyond a selected target. Input
files must be regular files and must not be symlinks. Compacted ranges, spool
root selection, remote inputs and automatic epoch selection are unsupported.
A missing tail beyond the highest present file cannot be detected without an
external expected position; use `--txid` when checking a known recovery point.

Choose a new path inside a private output directory. Existing output, symlinks
or SQLite `-wal`, `-shm` and `-journal` sidecars are refused. No other process
may open or modify the destination or its directory during restore.

## Validation and publication

Reads and writes are bounded, without retaining whole bodies or page indexes.
The restore checks file checksums, TXID and checksum continuity, page sizes,
page order/flags, complete database growth, truncation and incremental database
checksums. A final physical page checksum verifies the output, then SQLite
`integrity_check(1)` verifies the private immutable temporary database, with a
1 MiB page cache and mmap disabled.

The output is a mode-0600 temporary file beside the destination. It is fsynced,
validated, hard-linked without replacing any destination, and the parent
directory is fsynced before and after removing the temporary name. A publication
fsync failure is reported as ambiguous because the complete destination may
already exist. Inspect it before retrying.

Detected failures remove the owned temporary name and release the source lock.
SIGKILL can leave a `.restore-*` name, but does not publish partially decoded
bytes. Retry with a fresh process; remove abandoned names only after checking
that no restore owns them. Power-loss and storage-fault durability are unverified.

## Trusted build boundary

The CLI separately compiles fixed trusted restore source using toolchain 0.15.0
and `--sb-native-bytes-v1`, namespaces that C unit's defined global symbols,
and links it with a small native startup wrapper. The app's JS compile never
receives that option. Restore dispatch precedes the original server main, so
no tenant module, tenant prelude storage initialization or HTTP listener runs
in restore mode. The restore unit has its own compiler arena and globals and
exits without initializing the tenant. This integration is for standalone
binaries only; it does not link a restore unit into sproutd workers or platform
artifacts.

Host builds use the existing native compiler; cross builds use Zig. The build
also needs `nm` from the native compiler tools to inventory defined symbols.
Only defined symbols are prefixed, leaving libc/SQLite/server imports external.
A guarded inventory check fails on unexpected compiler output. The CRC kernel
comes from the actual released embedded transport; there is no copied CRC
algorithm or typed-array pointer arithmetic in the restore application.

The builtin gate is defense in depth, not tenant isolation: existing source
admission can allow inline `Porffor.c`. OS sandboxing and rejecting tenant
compiler intrinsics are separate platform work. The trusted restore command
must run as the data owner in an offline administrative context.

Code adapted from the Apache-2.0 sqlite-js-stream LTX codec is retained under
`vendor/ltx-restore/` with its notices; LZ4JS 0.2.0 declares ISC in its retained package metadata. Sources are
text assets so the packaged CLI embeds the same trusted program as source
builds. AI assistance: OpenAI Codex (GPT-6.1).

S3/R2 upload, retention and compaction remain separate work. This command reads
no backup credentials, uploads nothing and never changes capture position.
