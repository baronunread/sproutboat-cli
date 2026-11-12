#!/usr/bin/env bun
/**
 * Every public example: its worker-configuration.d.ts is what `sproutboat types` would write now, and it typechecks.
 *
 *   bun examples/typecheck.ts           # all of them
 *   bun examples/typecheck.ts kv d1     # just these
 *
 * The examples refer to the CLI's types as "sproutboat/types", which a project finds in node_modules; here the
 * package is this repository, so the script links it as examples/node_modules/sproutboat (git ignores it).
 */
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig } from "../src/config";
import { checkTypes, parseTypesArgs, planTypes } from "../src/types-cmd";
import { EXAMPLES_DIR, publicExamples } from "./lib/public-examples";
import { TSC } from "./lib/workerd";

const link = join(EXAMPLES_DIR, "node_modules/sproutboat");
if (!existsSync(link)) {
  mkdirSync(join(EXAMPLES_DIR, "node_modules"), { recursive: true });
  symlinkSync(resolve(EXAMPLES_DIR, ".."), link);
}

const all = publicExamples();
const wanted = process.argv.slice(2);
for (const name of wanted) if (!all.includes(name)) throw new Error(`no such example: ${name}`);

let failed = 0;
for (const example of wanted.length ? wanted : all) {
  const dir = join(EXAMPLES_DIR, example);
  if (!existsSync(join(dir, "tsconfig.json"))) {
    console.log(`  skip  ${example}: no tsconfig.json (not a TypeScript example)`);
    continue;
  }
  const parsed = parseConfig(await Bun.file(join(dir, "sproutboat.jsonc")).text());
  if (!parsed.ok) throw new Error(`${example}: ${parsed.errors.join("; ")}`);
  const args = parseTypesArgs([]);
  if ("error" in args) throw new Error(args.error);
  const state = await checkTypes(await planTypes(args, parsed.value, dir, dir));
  if (state !== "current") {
    console.log(`  FAIL  ${example}: worker-configuration.d.ts is ${state}; run \`sproutboat types\` there`);
    failed++;
    continue;
  }
  const tsc = Bun.spawn([TSC, "-p", dir], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(tsc.stdout).text(), new Response(tsc.stderr).text()]);
  if ((await tsc.exited) !== 0) {
    console.log(`  FAIL  ${example}\n${(out + err).trim().replace(/^/gm, "        ")}`);
    failed++;
  } else console.log(`  ok    ${example}`);
}
console.log(failed === 0 ? "\nevery example typechecks." : `\n${failed} example(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
