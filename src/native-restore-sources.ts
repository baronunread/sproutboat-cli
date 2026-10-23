// Text assets are embedded in the packaged CLI and compiled only as trusted restore source.
import source0 from "../vendor/ltx-restore/crc64-native.ts.txt" with { type: "text" };
import source1 from "../vendor/ltx-restore/errors.ts.txt" with { type: "text" };
import source2 from "../vendor/ltx-restore/file-io.ts.txt" with { type: "text" };
import source3 from "../vendor/ltx-restore/ltx/byte-reader.ts.txt" with { type: "text" };
import source4 from "../vendor/ltx-restore/ltx/bytes.ts.txt" with { type: "text" };
import source5 from "../vendor/ltx-restore/ltx/checksum.ts.txt" with { type: "text" };
import source6 from "../vendor/ltx-restore/ltx/constants.ts.txt" with { type: "text" };
import source7 from "../vendor/ltx-restore/ltx/crc64.ts.txt" with { type: "text" };
import source8 from "../vendor/ltx-restore/ltx/decoder.ts.txt" with { type: "text" };
import source9 from "../vendor/ltx-restore/ltx/header.ts.txt" with { type: "text" };
import source10 from "../vendor/ltx-restore/ltx/lz4.ts.txt" with { type: "text" };
import source11 from "../vendor/ltx-restore/ltx/page-index.ts.txt" with { type: "text" };
import source12 from "../vendor/ltx-restore/ltx/page.ts.txt" with { type: "text" };
import source13 from "../vendor/ltx-restore/ltx/sink.ts.txt" with { type: "text" };
import source14 from "../vendor/ltx-restore/ltx/trailer.ts.txt" with { type: "text" };
import source15 from "../vendor/ltx-restore/ltx/types.ts.txt" with { type: "text" };
import source16 from "../vendor/ltx-restore/lz4js/lz4.js.txt" with { type: "text" };
import source17 from "../vendor/ltx-restore/lz4js/util.js.txt" with { type: "text" };
import source18 from "../vendor/ltx-restore/lz4js/xxh32.js.txt" with { type: "text" };
import source19 from "../vendor/ltx-restore/program.ts.txt" with { type: "text" };
import source20 from "../vendor/ltx-restore/restore-native.ts.txt" with { type: "text" };
import source21 from "../vendor/ltx-restore/restore.ts.txt" with { type: "text" };

export const NATIVE_RESTORE_SOURCES = {
  "crc64-native.ts": source0,
  "errors.ts": source1,
  "file-io.ts": source2,
  "ltx/byte-reader.ts": source3,
  "ltx/bytes.ts": source4,
  "ltx/checksum.ts": source5,
  "ltx/constants.ts": source6,
  "ltx/crc64.ts": source7,
  "ltx/decoder.ts": source8,
  "ltx/header.ts": source9,
  "ltx/lz4.ts": source10,
  "ltx/page-index.ts": source11,
  "ltx/page.ts": source12,
  "ltx/sink.ts": source13,
  "ltx/trailer.ts": source14,
  "ltx/types.ts": source15,
  "lz4js/lz4.js": source16,
  "lz4js/util.js": source17,
  "lz4js/xxh32.js": source18,
  "program.ts": source19,
  "restore-native.ts": source20,
  "restore.ts": source21,
} satisfies Record<string, string>;
