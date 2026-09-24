# Third-party notices and provenance

This release contains or acquires the components below. Pins and checksums are
recorded so a released executable and every first-build download can be traced
to its upstream source.

| Component | Version or revision | Distribution role | License | Source |
| --- | --- | --- | --- | --- |
| Porffor | `de4eb588264885b3a1596f75010e371a2052033f` | Acquired on first application build | MIT | https://github.com/CanadaHonk/porffor |
| Zig | `0.16.0` | Acquired cross-compiler | MIT | https://ziglang.org |
| uWebSockets and uSockets | `360c276d609d59af56ae6932adb95154ace9f15f` | Embedded source and static archive | Apache-2.0 | https://github.com/uNetworking/uWebSockets |
| SQLite | `3.50.4` | Acquired for standalone builds | Public domain | https://sqlite.org |
| BearSSL | `0.6` | Acquired for standalone builds | MIT | https://bearssl.org |

## Integrity pins

| Component | SHA-256 |
| --- | --- |
| Porffor source archive | `1a62187a93356b36cb6ac703ce9770c8917e4fa65545fd7c33ee8a180ae5a4c9` |
| Embedded uWebSockets archive | `e83736f3f8cf9d56a1ebe6ea61625a7af12386763374d47c14cff472ada7484a` |
| SQLite amalgamation archive | `1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032` |
| BearSSL source archive | `6705bba1714961b41a728dfc5debbe348d2966c117649392f8c8139efc83ff14` |
| Mozilla CA bundle | `f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9` |

The complete Apache-2.0 notice for uWebSockets and uSockets is retained in the
embedded source archive. Porffor and BearSSL retain their MIT notices in the
source archives acquired at the revisions above.
