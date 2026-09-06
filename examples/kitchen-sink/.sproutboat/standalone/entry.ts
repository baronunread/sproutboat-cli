import sproutFile from "./sprout.bin" with { type: "file" };
import manifestFile from "./manifest.json" with { type: "file" };
import {
  runStandalone,
  type StandaloneManifest,
} from "/Users/andreabruno/Code/Products/sproutboat-platform/sproutboat-cli/src/standalone-runtime.ts";

const manifest: StandaloneManifest = await Bun.file(manifestFile).json();
const sprout = new Uint8Array(await Bun.file(sproutFile).arrayBuffer());
const { code } = await runStandalone(manifest, sprout, Bun.argv.slice(2));
process.exit(code);
