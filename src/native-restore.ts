import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NATIVE_RESTORE_SOURCES } from "./native-restore-sources";

/** Included in the native artifact cache key, including in the packaged CLI. */
export const NATIVE_RESTORE_IDENTITY = createHash("sha256")
  .update(JSON.stringify(NATIVE_RESTORE_SOURCES))
  .digest("hex");

const CONTROLLER_HEAD = String.raw`
static int sb_cli_restore_stdout = -1;
`;
const DISPATCH = String.raw`
int sb_cli_restore_dispatch(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "ltx-restore")) return -1;
  const char *source = NULL, *output = NULL, *target = "";
  const char *usage = "usage: APP ltx-restore --generation DIR --output NEW_DB [--txid DECIMAL_TXID]\n";
  if (argc == 3 && (!strcmp(argv[2], "--help") || !strcmp(argv[2], "-h"))) { fputs(usage, stdout); return 0; }
  for (int i = 2; i < argc; i += 2) {
    if (i + 1 >= argc || !argv[i + 1][0]) { fputs(usage, stderr); return 2; }
    if (!strcmp(argv[i], "--generation") && !source) source = argv[i + 1];
    else if (!strcmp(argv[i], "--output") && !output) output = argv[i + 1];
    else if (!strcmp(argv[i], "--txid") && !target[0]) target = argv[i + 1];
    else { fputs(usage, stderr); return 2; }
  }
  if (!source || !output || strlen(source) > 4095 || strlen(output) > 4095) { fputs(usage, stderr); return 2; }
  if (target[0]) {
    uint64_t value = 0;
    for (const unsigned char *p = (const unsigned char *)target; *p; p++) {
      unsigned int digit = (unsigned int)(*p - '0');
      if (digit > 9 || value > (UINT64_MAX - digit) / 10) { fputs(usage, stderr); return 2; }
      value = value * 10 + digit;
    }
    if (!value) { fputs(usage, stderr); return 2; }
  }
  if (setenv("SB_LTX_RESTORE_GENERATION", source, 1) || setenv("SB_LTX_RESTORE_OUTPUT", output, 1) ||
      setenv("SB_LTX_RESTORE_TXID", target, 1)) { perror("restore arguments"); return 1; }
  sb_cli_restore_stdout = dup(STDOUT_FILENO);
  if (sb_cli_restore_stdout < 0) { perror("restore stdout"); return 1; }
  porf_native_fetch_runtime_init();
  fputs("restore startup returned without completing\n", stderr);
  return 1;
}
`;

const STARTUP = String.raw`
extern "C" int sb_cli_restore_dispatch(int, char **);
int sb_app_main(void);
int main(int argc, char **argv) {
  const int result = sb_cli_restore_dispatch(argc, argv);
  return result >= 0 ? result : sb_app_main();
}
`;

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`native restore build failed (${command[0]}): ${stderr || stdout}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

/** Prefix only defined external symbols. Undefined libc/SQLite/server imports stay external. */
export function restoreSymbolDefines(symbols: string, macho: boolean): string {
  const names = new Set<string>();
  for (const line of symbols.split("\n")) {
    const match = /^\s*[0-9a-fA-F]+\s+[A-Za-z]\s+([A-Za-z_][A-Za-z_0-9]*)\s*$/.exec(line);
    if (!match) continue;
    const name = macho ? match[1].slice(1) : match[1];
    if (name !== "sb_cli_restore_dispatch") names.add(name);
  }
  if (!names.has("porf_mem") || !names.has("porf_native_fetch_runtime_init"))
    throw new Error("native restore compiler symbol inventory changed");
  return [...names]
    .sort()
    .map((name) => `#define ${name} sb_ltx_trusted_${name}\n`)
    .join("");
}

/** Trusted source only. No project source, bindings, configuration or secrets enter this compile. */
export async function buildNativeRestore(input: {
  directory: string;
  prelude: string;
  porfforCommand: string[];
  cc: string[];
  cxx: string[];
  cflags: string[];
  macho: boolean;
}): Promise<string[]> {
  const root = resolve(input.directory, "native-restore");
  await mkdir(root, { recursive: true });
  for (const [name, source] of Object.entries(NATIVE_RESTORE_SOURCES)) {
    const file = resolve(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  const bundled = await Bun.build({ entrypoints: [resolve(root, "program.ts")], target: "browser", format: "esm" });
  if (!bundled.success) throw new Error(`cannot bundle trusted restore: ${bundled.logs.join("\n")}`);
  // Full released transport supplies the existing CRC kernel and SQLite declarations.
  const generated = resolve(root, "trusted.generated.js");
  const { wrapNativeFetchHandler, EMPTY_BINDINGS } = await import("./wrap");
  const program = await bundled.outputs[0].text();
  const wrapped = wrapNativeFetchHandler(
    program,
    input.prelude + "\nPorffor.c`" + CONTROLLER_HEAD + "`;\n",
    {},
    EMPTY_BINDINGS,
    undefined,
    "2026-10-22",
    "ltx-restore",
    undefined,
    "embedded",
  );
  await writeFile(generated, wrapped);
  const emitted = resolve(root, "emitted");
  await rm(emitted, { recursive: true, force: true });
  await run([...input.porfforCommand, "c", generated, "-o", emitted, "--sb-native-bytes-v1"]);
  const c = (await readFile(resolve(emitted, "app.c"), "utf8")) + DISPATCH;
  const source = resolve(root, "trusted.c"),
    probe = resolve(root, "probe.o");
  const compileFlags = ["-std=gnu11", "-w", ...input.cflags];
  await writeFile(source, c);
  await rm(probe, { force: true });
  await run([...input.cc, ...compileFlags, "-O0", "-c", source, "-o", probe]);
  const nm = Bun.which("nm");
  if (!nm) throw new Error("native restore builds require nm from the native compiler tools");
  const defines = restoreSymbolDefines(await run([nm, "-g", "-U", probe]), input.macho);
  await writeFile(source, defines + c);
  const object = resolve(root, "trusted.o");
  await rm(object, { force: true });
  await run([...input.cc, ...compileFlags, "-O3", "-c", source, "-o", object]);
  const symbols = await run([nm, "-g", "-U", object]);
  for (const line of symbols.split("\n")) {
    const match = /^\s*[0-9a-fA-F]+\s+[A-Za-z]\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const name = input.macho ? match[1].slice(1) : match[1];
    if (name !== "sb_cli_restore_dispatch" && !name.startsWith("sb_ltx_trusted_"))
      throw new Error(`native restore external symbol was not namespaced: ${name}`);
  }
  const startup = resolve(root, "startup.cpp"),
    startupObject = resolve(root, "startup.o");
  await writeFile(startup, STARTUP);
  await rm(startupObject, { force: true });
  await run([...input.cxx, "-O3", "-c", startup, "-o", startupObject]);
  return [object, startupObject];
}
