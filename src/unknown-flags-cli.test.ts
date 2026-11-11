/**
 * The CLI end to end on the mix-up that shipped in 0.53.1: `deploy --api-url <url>` read the URL as the project
 * directory, and `--api-url=<url>` was ignored, so the deploy went to the saved endpoint. Each of these must reach the
 * endpoint it names or stop with an error, and an unknown flag must never be a no-op.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY, startFakeCloud } from "./cloud-fake";
import { COMMAND_OPTIONS } from "./options";

const hits: string[] = [];
// A Community control plane that records what reaches it.
const community = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    hits.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/v1/config") return new Response("not found", { status: 404 });
    if (url.pathname === "/api/projects/site-one/deployments") return Response.json([]);
    if (url.pathname === "/api/projects/site-one/secrets") return Response.json({ names: ["FROM_COMMUNITY"] });
    if (url.pathname === "/api/account") return Response.json({ profile: { username: "bob" }, user: {} });
    return new Response("not found", { status: 404 });
  },
});
// A Cloud (`deploy --dry-run` there only plans; on Community it would build the app).
const cloud = startFakeCloud({ appExists: true });
// The saved login: a decoy that is the default, and the two control planes above under names of their own.
const DECOY = "http://127.0.0.1:9";
const PLANE = `http://127.0.0.1:${community.port}`;
const CLOUD = cloud.url;
const PROFILE = `127.0.0.1-${new URL(CLOUD).port}`;

let root: string;
let configDir: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-unknown-flags-"));
  configDir = join(root, "config");
  project = join(root, "site");
  await mkdir(join(configDir, "sproutboat"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "index.js"), "export default { fetch() { return new Response('ok'); } };\n");
  await writeFile(
    join(project, "sproutboat.jsonc"),
    '{ "name": "site-one", "main": "src/index.js", "compatibility_date": "2026-09-28" }\n',
  );
  await writeFile(
    join(configDir, "sproutboat", "credentials.json"),
    JSON.stringify({
      version: 1,
      activeApiUrl: DECOY,
      profiles: {
        [DECOY]: { token: "decoy", kind: "community" },
        [PLANE]: { token: "bob-token", kind: "community" },
        [CLOUD]: { token: FAKE_KEY, kind: "cloud" },
      },
    }),
  );
});

afterAll(async () => {
  community.stop(true);
  cloud.stop();
  await rm(root, { recursive: true, force: true });
});

async function cli(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env };
  for (const name of ["SPROUTBOAT_API_URL", "SPROUTBOAT_API_TOKEN", "SPROUTBOAT_TOKEN", "SPROUTBOAT_PROFILE"])
    delete base[name];
  hits.length = 0;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
    cwd: project,
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

describe("deploy and the endpoint", () => {
  test("--api-url <url> and --api-url=<url> both name the endpoint, before or after the other flags", async () => {
    for (const args of [
      ["deploy", "--dry-run", "--api-url", CLOUD],
      ["deploy", "--dry-run", `--api-url=${CLOUD}`],
      ["--api-url", CLOUD, "deploy", "--dry-run"],
      ["deploy", `--api-url=${CLOUD}`, "--dry-run"],
    ]) {
      const run = await cli(args);
      expect(run.stdout, args.join(" ")).toContain(`endpoint  ${CLOUD}  (--api-url)`);
      expect(run.stdout).not.toContain(DECOY);
    }
  });

  test("--profile names the endpoint through the stored login", async () => {
    const run = await cli(["deploy", "--dry-run", "--profile", PROFILE]);
    expect(run.stdout).toContain(`endpoint  ${CLOUD}  (profile ${PROFILE})`);
  });

  test("the saved default is used only when nothing names an endpoint", async () => {
    // (`whoami`, because a Community `deploy --dry-run` would start a build.)
    const run = await cli(["whoami"]);
    expect(run.stdout).toContain(`endpoint  ${DECOY}`);
  });

  test("a URL where the project directory goes is an error that points to the real options", async () => {
    for (const args of [
      ["deploy", "https://dash.sproutboat.com"],
      ["deploy", "--dry-run", "http://127.0.0.1:9/"],
      ["check", "https://dash.sproutboat.com"],
      ["build", "https://dash.sproutboat.com"],
    ]) {
      const run = await cli(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stderr).toContain("looks like a URL, not a project directory");
      expect(run.stderr).toContain("--api-url <url>, --profile <name> or SPROUTBOAT_API_URL");
      expect(run.stdout).not.toContain("endpoint");
    }
    expect(hits).toEqual([]);
  });

  test("a badly formed --api-url is refused", async () => {
    const run = await cli(["deploy", "--dry-run", "--api-url", "dash.sproutboat.com"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("is not an http(s) URL");
  });
});

describe("--api-url on the commands that use an endpoint", () => {
  test("every one of them reaches the endpoint it names, in both forms", async () => {
    const cases: string[][] = [["secrets", "list"], ["versions", "list"], ["whoami"]];
    for (const base of cases)
      for (const flag of [["--api-url", PLANE], [`--api-url=${PLANE}`]]) {
        const run = await cli([...base, ...flag]);
        expect(run.stderr + run.stdout, `${base.join(" ")} ${flag.join(" ")}`).not.toContain(DECOY);
        expect(hits.length, `${base.join(" ")} ${flag.join(" ")}`).toBeGreaterThan(0);
        expect(hits.every((hit) => !hit.includes("undefined"))).toBe(true);
      }
    const list = await cli(["secrets", "list", `--api-url=${PLANE}`]);
    expect(list.stdout).toContain("FROM_COMMUNITY");
  });

  test("a command with no control plane refuses it, and says how to choose one", async () => {
    for (const command of ["init", "check", "types", "dev", "run", "build", "toolchain", "profile", "complete"]) {
      for (const flag of [["--api-url", PLANE], [`--api-url=${PLANE}`]]) {
        const run = await cli([command, ...flag]);
        expect(run.code, `${command} ${flag.join(" ")}`).toBe(2);
        expect(run.stderr).toContain("does not talk to a control plane");
        expect(run.stderr).toContain("--profile <name> or SPROUTBOAT_API_URL");
      }
    }
  });
});

describe("unknown flags", () => {
  test("every command refuses one, with exit 2 and the flag's name", async () => {
    for (const command of Object.keys(COMMAND_OPTIONS)) {
      for (const flag of ["--definitely-not-a-flag", "--definitely-not-a-flag=1", "-Q"]) {
        const run = await cli([command, flag]);
        expect(run.code, `${command} ${flag}`).toBe(2);
        expect(run.stderr, `${command} ${flag}`).toContain(`unknown option ${flag.split("=")[0]}`);
        expect(run.stdout).toBe("");
      }
    }
    expect(hits).toEqual([]);
  });

  test("a flag is checked wherever it sits, so a typo cannot ride along with a real command line", async () => {
    for (const args of [
      ["deploy", "--dry-run", "--no-wiat"],
      ["deploy", "--bogus", "--dry-run", `--api-url=${CLOUD}`],
      ["secrets", "put", "TOKEN", "--vlaue", "x"],
      ["versions", "list", "--json"],
      ["logout", "--force"],
    ]) {
      const run = await cli(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stderr).toContain("unknown option");
    }
    expect(hits).toEqual([]);
  });

  test("a typo gets the nearest real flag", async () => {
    const run = await cli(["deploy", "--dry-runn"]);
    expect(run.stderr).toContain("did you mean --dry-run?");
  });

  test("a flag that exists still works, including a value that starts with a dash", async () => {
    const run = await cli(["deploy", "--dry-run", "--profile", PROFILE]);
    expect(run.code, run.stderr).not.toBe(2);
    expect(run.stdout).toContain("endpoint");
  });
});
