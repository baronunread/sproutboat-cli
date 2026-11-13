#!/usr/bin/env bun
/**
 * Every example and every plain-Workers fixture: its worker-configuration.d.ts is what `sproutboat types` would write
 * now, and it typechecks.
 *
 *   bun examples/typecheck.ts           # all of them
 *   bun examples/typecheck.ts kv d1     # just these
 *
 * A project refers to the CLI's types as "sproutboat/types", which a real project finds in node_modules; here the
 * package is this repository, so the script links it as node_modules/sproutboat in each directory that holds
 * projects (git ignores those links).
 */
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { checkTypes, parseTypesArgs, planTypes } from "../src/types-cmd";
import { groupRoots, projects, REPO } from "../test/fixtures/lib/projects";
import { TSC } from "../test/fixtures/lib/workerd";

for (const root of groupRoots()) {
  const link = join(root, "node_modules/sproutboat");
  if (existsSync(link)) continue;
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(REPO, link);
}

const all = projects();
const wanted = process.argv.slice(2);
for (const name of wanted)
  if (!all.some((project) => project.name === name)) throw new Error(`no such project: ${name}`);

let failed = 0;
for (const { name, dir } of wanted.length ? all.filter((project) => wanted.includes(project.name)) : all) {
  if (!existsSync(join(dir, "tsconfig.json"))) {
    console.log(`  skip  ${name}: no tsconfig.json (not a TypeScript project)`);
    continue;
  }
  const parsed = parseConfig(await Bun.file(join(dir, "sproutboat.jsonc")).text());
  if (!parsed.ok) throw new Error(`${name}: ${parsed.errors.join("; ")}`);
  const args = parseTypesArgs([]);
  if ("error" in args) throw new Error(args.error);
  const state = await checkTypes(await planTypes(args, parsed.value, dir, dir));
  if (state !== "current") {
    console.log(`  FAIL  ${name}: worker-configuration.d.ts is ${state}; run \`sproutboat types\` there`);
    failed++;
    continue;
  }
  const tsc = Bun.spawn([TSC, "-p", dir], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(tsc.stdout).text(), new Response(tsc.stderr).text()]);
  if ((await tsc.exited) !== 0) {
    console.log(`  FAIL  ${name}\n${(out + err).trim().replace(/^/gm, "        ")}`);
    failed++;
  } else console.log(`  ok    ${name}`);
  // A starter keeps its tests beside the Worker, with their own tsconfig (Node's types, which the Worker must not see).
  if (existsSync(join(dir, "test/tsconfig.json"))) {
    const tests = Bun.spawn([TSC, "-p", join(dir, "test")], { stdout: "pipe", stderr: "pipe" });
    const [testOut, testErr] = await Promise.all([
      new Response(tests.stdout).text(),
      new Response(tests.stderr).text(),
    ]);
    if ((await tests.exited) !== 0) {
      console.log(`  FAIL  ${name} (tests)\n${(testOut + testErr).trim().replace(/^/gm, "        ")}`);
      failed++;
    } else console.log(`  ok    ${name} (tests)`);
  }
}
console.log(failed === 0 ? "\nevery project typechecks." : `\n${failed} project(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
