/**
 * The CLI end to end with stored profiles: which one whoami and deploy report, how --profile,
 * SPROUTBOAT_PROFILE and --api-url rank, and the global flags wherever they sit on the line.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two Community control planes; each knows one user.
const serve = (username: string) =>
  Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/account")
        return request.headers.get("x-api-key") === `${username}-token`
          ? Response.json({ profile: { username }, user: { email: `${username}@example.com` } })
          : new Response("no", { status: 401 });
      return new Response("not found", { status: 404 });
    },
  });
const alpha = serve("alice");
const beta = serve("bob");
const A = `http://127.0.0.1:${alpha.port}`;
const B = `http://127.0.0.1:${beta.port}`;

let root: string;
let configDir: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-profiles-cli-"));
  configDir = join(root, "config");
  project = join(root, "site");
  await mkdir(join(configDir, "sproutboat"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "index.js"), "export default { fetch() { return new Response('ok'); } };\n");
  await writeFile(
    join(project, "sproutboat.jsonc"),
    '{ "name": "site-one", "main": "src/index.js", "compatibility_date": "2026-09-28" }\n',
  );
  // What 0.53 wrote: A is the active endpoint, B is also stored.
  await writeFile(
    join(configDir, "sproutboat", "credentials.json"),
    JSON.stringify({
      version: 1,
      activeApiUrl: A,
      profiles: { [A]: { token: "alice-token", kind: "community" }, [B]: { token: "bob-token", kind: "community" } },
    }),
  );
});

afterAll(async () => {
  alpha.stop(true);
  beta.stop(true);
  await rm(root, { recursive: true, force: true });
});

const BOB = `127.0.0.1-${new URL(B).port}`;

async function cli(args: string[], env: Record<string, string> = {}, cwd = join(import.meta.dir, "..")) {
  const base = { ...process.env };
  for (const name of ["SPROUTBOAT_API_URL", "SPROUTBOAT_API_TOKEN", "SPROUTBOAT_TOKEN", "SPROUTBOAT_PROFILE"])
    delete base[name];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
    cwd,
    env: { ...base, NO_COLOR: "1", SPROUTBOAT_NO_UPDATE_CHECK: "1", SPROUTBOAT_CONFIG_DIR: configDir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

test("whoami names the profile and the endpoint, and an old login is the default profile", async () => {
  const result = await cli(["whoami"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("profile   default  (active profile)");
  expect(result.stdout).toContain(`endpoint  ${A}  (profile default)`);
  expect(result.stdout).toContain("account   alice");
});

test("--profile picks another stored login, before or after the command", async () => {
  for (const args of [
    ["whoami", "--profile", BOB],
    ["--profile", BOB, "whoami"],
    ["whoami", `--profile=${BOB}`],
  ]) {
    const result = await cli(args);
    expect(result.stdout).toContain(`profile   ${BOB}  (--profile)`);
    expect(result.stdout).toContain(`endpoint  ${B}`);
    expect(result.stdout).toContain("account   bob");
  }
});

test("SPROUTBOAT_PROFILE picks one, and --profile beats it", async () => {
  expect((await cli(["whoami"], { SPROUTBOAT_PROFILE: BOB })).stdout).toContain("account   bob");
  const flag = await cli(["whoami", "--profile", "default"], { SPROUTBOAT_PROFILE: BOB });
  expect(flag.stdout).toContain("account   alice");
});

test("--api-url beats SPROUTBOAT_PROFILE and finds the stored login for that endpoint", async () => {
  const result = await cli(["whoami", "--api-url", B], { SPROUTBOAT_PROFILE: "default" });
  expect(result.stdout).toContain(`endpoint  ${B}  (--api-url)`);
  expect(result.stdout).toContain(`profile   ${BOB}  (the stored login for this endpoint)`);
  expect(result.stdout).toContain("account   bob");
});

test("a profile and an endpoint that disagree fail instead of picking one", async () => {
  const result = await cli(["whoami", "--profile", "default", "--api-url", B]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`the profile "default" is for ${A}, but --api-url says ${B}`);
});

test("an unknown profile fails and lists the known ones", async () => {
  const result = await cli(["whoami", "--profile", "nope"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`no profile named "nope" (profiles: default, ${BOB})`);
});

test("deploy says which profile and endpoint it uses before it builds, and refuses an unknown profile", async () => {
  const unknown = await cli(["deploy", "--profile", "nope", project, "--dry-run"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stdout).not.toContain("Building");
  const result = await cli(["deploy", project, "--profile", BOB, "--dry-run", "--artifact", join(root, "missing")]);
  expect(result.stdout.split("\n").slice(0, 2)).toEqual([
    `profile   ${BOB}  (--profile)`,
    `endpoint  ${B}  (profile ${BOB})`,
  ]);
});

test("profile list marks the default; profile use changes it for later commands", async () => {
  const listed = await cli(["profile", "list"]);
  expect(listed.stdout).toContain(`* default`);
  expect(listed.stdout).toContain(`  ${BOB}`);
  expect((await cli(["profile", "use", BOB])).code).toBe(0);
  expect((await cli(["whoami"])).stdout).toContain("account   bob");
  expect((await cli(["profile", "use", "default"])).code).toBe(0);
  expect((await cli(["profile", "use", "nope"])).code).toBe(1);
});

test("login --profile makes a new profile and leaves the default alone", async () => {
  const result = await cli(["login", "--profile", "ci", "--api-url", B, "--token", "bob-token"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('stored as the profile "ci"');
  expect(result.stdout).toContain('the default profile stays "default"');
  const file = JSON.parse(await readFile(join(configDir, "sproutboat", "credentials.json"), "utf8"));
  expect(file.version).toBe(1);
  expect(file.activeApiUrl).toBe(A);
  const names = JSON.parse(await readFile(join(configDir, "sproutboat", "profiles.json"), "utf8"));
  expect(names.activeProfile).toBe("default");
  expect(names.profiles.ci.endpoint).toBe(B);
  expect((await cli(["whoami", "--profile", "ci"])).stdout).toContain("account   bob");
  const out = await cli(["logout", "--profile", "ci"]);
  expect(out.stdout).toContain("forgot the credential");
});

test("-v and --version print the version wherever they are", async () => {
  const { version } = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
  for (const args of [["-v"], ["--version"], ["deploy", "-v"], ["whoami", "--version"]])
    expect((await cli(args)).stdout.trim()).toBe(`sproutboat ${version}`);
});

test("--cwd and --config find the project from anywhere", async () => {
  expect((await cli(["check", "--cwd", project])).code).toBe(0);
  const byConfig = await cli(["check", "-c", join(project, "sproutboat.jsonc")], {}, root);
  expect(byConfig.code).toBe(0);
  expect(byConfig.stdout).toContain("site-one");
  const relative = await cli(["check", "--cwd", root, "--config", "site/sproutboat.jsonc"], {}, tmpdir());
  expect(relative.code).toBe(0);
  const missing = await cli(["check", "--cwd", join(root, "nowhere")]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("--cwd: no such directory");
  const conflict = await cli(["check", join(root, "elsewhere"), "-c", join(project, "sproutboat.jsonc")]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain("pass one");
});

test("--env and --env-file are refused where they would do nothing", async () => {
  const env = await cli(["deploy", "--env", "staging"]);
  expect(env.code).toBe(2);
  expect(env.stderr).toContain("deploy does not use --env");
  const file = await cli(["whoami", "--env-file", ".env"]);
  expect(file.code).toBe(2);
  expect(file.stderr).toContain("does not read env files");
});

test("run takes --env-file from the global parser, later files winning, in either spelling", async () => {
  await writeFile(join(project, "a.env"), "SECRET=first\n");
  await writeFile(join(project, "b.env"), "SECRET=second\n");
  await writeFile(
    join(project, "sproutboat.jsonc"),
    '{ "name": "site-one", "main": "src/index.js", "compatibility_date": "2026-09-28", "secrets": ["SECRET"] }\n',
  );
  await mkdir(join(project, "dist"), { recursive: true });
  await writeFile(join(project, "dist", "site-one"), "#!/bin/sh\n");
  for (const args of [
    ["--env-file", "a.env", "--env-file=b.env", "run", "--check"],
    ["run", "--check", "--env-file", "a.env", "--env-file", "b.env"],
  ]) {
    const result = await cli(args, {}, project);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("SECRET (env file)");
  }
});
