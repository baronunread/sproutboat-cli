/**
 * `sproutboat init`: scaffold a project, in the shape of `npm create cloudflare` (create-cloudflare, "C3").
 *
 *   sproutboat init [name] [--template <name>] [--git | --no-git] [--install | --no-install] [-y]
 *   sproutboat init --list-templates
 *
 * Interactive in a terminal (it asks for the template, the directory, git and installing, with C3's defaults);
 * silent everywhere else, where nothing runs that a flag did not ask for. Everything outside the filesystem
 * (prompts, git, the package manager) goes through `InitIo`, so tests drive the whole flow without a terminal.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseConfig } from "./config";
import {
  detectPackageManager,
  installCommand,
  planPackageJson,
  runScriptCommand,
  type PackagePlan,
} from "./init-package";
import {
  DEFAULT_TEMPLATE,
  firstRunScript,
  isTemplate,
  listTemplates,
  templateFiles,
  type TemplateFile,
} from "./templates";
import { amber, dim } from "./style";
import { parseTypesArgs, planTypes } from "./types-cmd";

export type InitOptions = {
  name?: string;
  template?: string;
  git?: boolean;
  install?: boolean;
  /** `-y`: take every default without asking, git and install included. */
  yes: boolean;
  list: boolean;
};

export type Choice = { value: string; label: string };

export type InitIo = {
  cwd: string;
  cliVersion: string;
  /** A person is here to answer: stdin and stdout are terminals. */
  interactive: boolean;
  log(line: string): void;
  warn(line: string): void;
  ask(question: string, fallback: string): Promise<string>;
  /** Pick one of `choices` by number, `fallback` (a value) on an empty answer. */
  choose(question: string, choices: readonly Choice[], fallback: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** Run a command with the terminal attached; resolves to its exit code (127 when it cannot start). */
  run(command: string, args: readonly string[], cwd: string): Promise<number>;
  /** Run a command and return its exit code and output. */
  capture(command: string, args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>;
  /** Called once when init ends, however it ends. */
  close?(): void;
};

/** A failure the user can act on; `main.ts` prints the message and exits 1. */
export class InitError extends Error {}

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const NAME_ERROR = "project name must be a 3–32 character lowercase slug";

export function parseInitArgs(args: readonly string[]): InitOptions | { error: string } {
  const options: InitOptions = { yes: false, list: false };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--template") {
      const value = args[(at += 1)];
      if (value === undefined || value.startsWith("-")) return { error: "--template needs a template name" };
      options.template = value;
    } else if (arg === "--git") options.git = true;
    else if (arg === "--no-git") options.git = false;
    else if (arg === "--install") options.install = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "-y" || arg === "--yes" || arg === "--accept-defaults") options.yes = true;
    else if (arg === "--list-templates") options.list = true;
    else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    else if (options.name === undefined) options.name = arg;
    else return { error: `unexpected argument "${arg}": init takes one project name` };
  }
  return options;
}

export function templateListing(): string {
  const width = Math.max(...listTemplates().map((template) => template.name.length));
  return listTemplates()
    .map(({ name, description }) => `  ${name.padEnd(width)}  ${description}`)
    .join("\n");
}

// -------------------------------------------------------------- the hello starter

const helloConfig = (name: string) => `{
  "$schema": "https://sproutboat.com/schema.json",
  "name": "${name}",
  "main": "src/index.js",
  "compatibility_date": "2026-09-28"
}
`;
const helloHandler = `export default {
  fetch(request, env, ctx) {
    return new Response("hello from Sproutboat");
  }
};
`;
// .sproutboat/ holds build output (dist/) and `dev`'s local broker state
// (dev/, including its SQLite files), neither of which belongs in version control.
// .dev.vars carries secret values for `sproutboat dev`, same convention as
// Wrangler's file of the same name.
const gitignore = `.sproutboat/
.dev.vars
node_modules/
`;

// -------------------------------------------------------------- the flow

export async function runInit(options: InitOptions, io: InitIo): Promise<void> {
  try {
    await scaffold(options, io);
  } finally {
    io.close?.();
  }
}

async function scaffold(options: InitOptions, io: InitIo): Promise<void> {
  if (options.list) {
    io.log(`Templates (sproutboat init --template <name>):\n${templateListing()}`);
    return;
  }
  const asking = io.interactive && !options.yes;

  let template = options.template;
  if (template !== undefined && !isTemplate(template))
    throw new InitError(`unknown template "${template}". Templates:\n${templateListing()}`);
  if (template === undefined)
    template = asking
      ? await io.choose(
          "Which template would you like to use?",
          listTemplates().map(({ name, description }) => ({ value: name, label: `${name}: ${description}` })),
          DEFAULT_TEMPLATE,
        )
      : DEFAULT_TEMPLATE;

  const fallbackName = template === DEFAULT_TEMPLATE ? "hello" : template;
  const given =
    options.name ??
    (asking ? await io.ask("In which directory do you want to create your application?", fallbackName) : fallbackName);
  // C3 takes a directory and names the app after it; so does this: `init apps/blog` makes ./apps/blog named "blog".
  const directory = resolve(io.cwd, given);
  const name = basename(directory);
  if (!NAME_PATTERN.test(name)) throw new InitError(NAME_ERROR);
  const shown = basename(directory);

  const hello = template === DEFAULT_TEMPLATE;
  const files: TemplateFile[] = hello
    ? [
        { path: "sproutboat.jsonc", content: helloConfig(name) },
        { path: "src/index.js", content: helloHandler },
      ]
    : // An existing .gitignore is not a sign this is not a fresh project (the name can collide with an unrelated
      // directory): keep it rather than fail or clobber it.
      templateFiles(template, name, io.cliVersion).filter(
        (file) => file.path !== ".gitignore" || !existsSync(join(directory, ".gitignore")),
      );

  // Check every target before writing any: `name` can collide with an unrelated existing directory, and a write
  // failing partway through would leave a half-scaffolded project behind.
  for (const file of files)
    if (existsSync(join(directory, file.path))) throw new InitError(`${shown} already contains ${file.path}`);

  // The hello starter merges into an existing package.json (and keeps an existing .gitignore); plan that before
  // writing anything, so an unreadable one stops init instead of half-scaffolding.
  const packagePath = join(directory, "package.json");
  let packagePlan: PackagePlan | undefined;
  if (hello) {
    const existing = existsSync(packagePath) ? await readFile(packagePath, "utf8") : undefined;
    try {
      packagePlan = planPackageJson(name, existing, io.cliVersion);
    } catch (cause) {
      throw new InitError(`${shown}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  for (const file of files) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { flag: "wx" });
    io.log(`Created ${shown}/${file.path}`);
  }
  if (packagePlan) {
    if (!existsSync(join(directory, ".gitignore"))) {
      await writeFile(join(directory, ".gitignore"), gitignore, { flag: "wx" });
      io.log(`Created ${shown}/.gitignore`);
    }
    if (packagePlan.created || packagePlan.addedDependency || packagePlan.addedScripts.length > 0) {
      await writeFile(packagePath, packagePlan.text);
      io.log(`${packagePlan.created ? "Created" : "Updated"} ${shown}/package.json`);
    }
    for (const script of packagePlan.skippedScripts)
      io.warn(
        `  ! package.json already has a "${script}" script; left it as is (sproutboat's would be "sproutboat ${script}")`,
      );
  }

  // A TypeScript template ships without worker-configuration.d.ts: it is written here, for this project's name.
  if (existsSync(join(directory, "tsconfig.json"))) {
    const config = parseConfig(await readFile(join(directory, "sproutboat.jsonc"), "utf8"));
    const args = parseTypesArgs([]);
    if (!config.ok || "error" in args) throw new InitError(`could not write worker-configuration.d.ts for ${shown}`);
    const plan = await planTypes(args, config.value, directory, directory);
    await writeFile(plan.path, plan.text);
    io.log(`Created ${shown}/${basename(plan.path)}`);
  }

  const manager = detectPackageManager(directory);
  const install =
    options.install ??
    (options.yes
      ? true
      : asking
        ? await io.confirm(`Do you want to install dependencies with ${manager}?`, true)
        : false);
  const git =
    options.git ??
    (options.yes ? true : asking ? await io.confirm("Do you want to use git for version control?", true) : false);

  let installed = false;
  if (install) {
    io.log(`Installing dependencies with ${manager}...`);
    installed = (await io.run(manager, ["install"], directory)) === 0;
    if (!installed) io.warn(`  ! ${installCommand(manager)} failed; run it yourself in ${shown}`);
  }
  if (git) await initGit(directory, shown, io);

  const setup = firstRunScript(template);
  const steps = [
    `cd ${shown}`,
    ...(installed ? [] : [installCommand(manager)]),
    ...(setup ? [runScriptCommand(manager, setup)] : []),
    runScriptCommand(manager, "dev"),
  ];
  io.log(`\nNext: ${steps.join(" && ")}`);
  io.log(dim(`After "sproutboat login", ship it with ${runScriptCommand(manager, "deploy")}.`));
}

async function initGit(directory: string, shown: string, io: InitIo): Promise<void> {
  if ((await io.capture("git", ["--version"], directory)).code !== 0) {
    io.warn("  ! git is not installed; skipped git init");
    return;
  }
  // A project made inside someone's repository belongs to that repository: do not nest a second one in it.
  const inside = await io.capture("git", ["rev-parse", "--is-inside-work-tree"], directory);
  if (inside.code === 0 && inside.stdout.trim() === "true") {
    io.log(`  git: ${shown} is already inside a git repository; not creating another`);
    return;
  }
  if ((await io.capture("git", ["init", "--quiet"], directory)).code !== 0) {
    io.warn("  ! git init failed");
    return;
  }
  await io.capture("git", ["add", "-A"], directory);
  const commit = await io.capture("git", ["commit", "--quiet", "-m", "Initial commit (by sproutboat init)"], directory);
  io.log(
    commit.code === 0
      ? `  git: initialized ${shown} with a first commit`
      : `  git: initialized ${shown}; the first commit failed (is user.name set?)`,
  );
}

// -------------------------------------------------------------- the terminal

export function terminalInitIo(cliVersion: string): InitIo {
  let lines: import("node:readline/promises").Interface | undefined;
  const question = async (text: string): Promise<string> => {
    const { createInterface } = await import("node:readline/promises");
    lines ??= createInterface({ input: process.stdin, output: process.stdout });
    return (await lines.question(text)).trim();
  };
  const spawn = (command: string, args: readonly string[], cwd: string) => {
    try {
      return Bun.spawnSync([command, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      return undefined;
    }
  };
  return {
    cwd: process.cwd(),
    cliVersion,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    log: (line) => console.log(line),
    warn: (line) => console.log(amber(line)),
    ask: async (text, fallback) => (await question(`${text} (${fallback}) `)) || fallback,
    choose: async (text, choices, fallback) => {
      console.log(text);
      choices.forEach((choice, at) => console.log(`  ${at + 1}) ${choice.label}`));
      for (;;) {
        const answer = await question(`> (${choices.findIndex((choice) => choice.value === fallback) + 1}) `);
        if (answer === "") return fallback;
        const picked = choices[Number(answer) - 1] ?? choices.find((choice) => choice.value === answer);
        if (picked) return picked.value;
      }
    },
    confirm: async (text, fallback) => {
      const answer = (await question(`${text} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
      return answer === "" ? fallback : answer.startsWith("y");
    },
    run: async (command, args, cwd) => {
      try {
        const child = Bun.spawn([command, ...args], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        return await child.exited;
      } catch {
        return 127;
      }
    },
    capture: async (command, args, cwd) => {
      const result = spawn(command, args, cwd);
      return { code: result?.exitCode ?? 127, stdout: result?.stdout.toString() ?? "" };
    },
    close: () => lines?.close(),
  };
}
