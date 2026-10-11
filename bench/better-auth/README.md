# Better Auth native integration probe

Install the isolated dependency with `bun install --cwd bench/better-auth`, then
run `bun bench/better-auth/probe.ts` from the CLI root using the Alpha 17 toolchain
and runtime with Web Streams. The test builds a host-native standalone binary,
allocates a free port and asserts signup, signed-cookie session lookup,
wrong-password rejection, signin, signout and session revocation. Temporary
outputs are removed. Tokens and cookies are not logged.

The adapter stores data in memory for this test only. Password hashing uses
Better Auth's default implementation. Credential operations currently take
about 6 to 8 seconds on the development machine; allow time for compilation.
The fixture secret is public test data and must not be used in production.

Database-free Better Auth selects encrypted JWE sessions and needs AES support
that native crypto does not yet provide. This probe does not establish support
for production database adapters, OAuth, plugins or asymmetric JWT algorithms.
