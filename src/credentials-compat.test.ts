/**
 * Older CLIs (every release up to 0.53) read `credentials.json` as version 1 and nothing else. `sproutboat init` pins
 * the CLI per project, so a global new CLI and a project-local old one share one machine: whatever the new CLI does,
 * the old reader below (the parsing of 0.53's src/credentials.ts) must still find the right endpoint and token.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeApiUrl,
  forgetToken,
  listProfiles,
  saveTeam,
  saveToken,
  savedProfile,
  selectProfile,
  useProfile,
} from "./credentials";
import { isString, jsonObject } from "./json";

const CLOUD = "https://dash.sproutboat.com";
const LOCAL = "http://localhost:8787";

/** 0.53's reader: version 1 only, a token per endpoint, a machine-wide active endpoint. */
type OldView = { active: string | undefined; token(apiUrl: string): string | undefined; endpoints: string[] };
function oldCli(text: string): OldView {
  const none: OldView = { active: undefined, token: () => undefined, endpoints: [] };
  const input = jsonObject(JSON.parse(text));
  const profiles = input && jsonObject(input.profiles);
  if (!input || input.version !== 1 || !profiles) return none;
  const tokens: Record<string, string> = {};
  for (const [apiUrl, value] of Object.entries(profiles)) {
    const token = jsonObject(value)?.token;
    if (!isString(token)) return none;
    tokens[apiUrl] = token;
  }
  return {
    active: isString(input.activeApiUrl) ? input.activeApiUrl : undefined,
    token: (apiUrl) => tokens[apiUrl],
    endpoints: Object.keys(tokens),
  };
}

let root: string;
let directory: string;
const oldView = async () => oldCli(await readFile(join(directory, "credentials.json"), "utf8"));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-compat-"));
  process.env.SPROUTBOAT_CONFIG_DIR = root;
  directory = join(root, "sproutboat");
  await mkdir(directory, { recursive: true });
  selectProfile(undefined);
});
afterEach(async () => {
  selectProfile(undefined);
  delete process.env.SPROUTBOAT_CONFIG_DIR;
  await rm(root, { recursive: true, force: true });
});

const team = (slug: string, token: string) => ({
  token,
  id: `org_${slug}`,
  name: slug,
  role: "owner",
  keyId: "k",
  keyName: "CLI",
});

describe("an older CLI after the new one writes", () => {
  test("login: the active endpoint and its token", async () => {
    await saveToken(LOCAL, "community-token", "community");
    await saveTeam(CLOUD, "acme", team("acme", "cloud-token"));
    const old = await oldView();
    expect(old.active).toBe(LOCAL);
    expect(old.token(LOCAL)).toBe("community-token");
    expect(old.token(CLOUD)).toBe("cloud-token");
  });

  test("logout: the endpoint is gone, the active one clears, the rest still works", async () => {
    await saveToken(LOCAL, "community-token");
    await saveToken(CLOUD, "cloud-token");
    await forgetToken(CLOUD);
    let old = await oldView();
    expect(old.endpoints).toEqual([LOCAL]);
    expect(old.active).toBe(LOCAL);
    await forgetToken(LOCAL);
    old = await oldView();
    expect(old.active).toBeUndefined();
    expect(old.endpoints).toEqual([]);
  });

  test("profile use: the active endpoint follows, with that profile's token", async () => {
    await saveToken(LOCAL, "community-token");
    await saveToken(CLOUD, "cloud-token");
    expect((await oldView()).active).toBe(LOCAL);
    await useProfile("dash.sproutboat.com");
    const old = await oldView();
    expect(old.active).toBe(CLOUD);
    expect(old.token(CLOUD)).toBe("cloud-token");
    expect(old.token(LOCAL)).toBe("community-token");
  });

  test("the files are version 1 and 0600, with no temporary files left", async () => {
    await saveToken(LOCAL, "t");
    expect(JSON.parse(await readFile(join(directory, "credentials.json"), "utf8")).version).toBe(1);
    expect((await readdir(directory)).sort()).toEqual(["credentials.json", "profiles.json"]);
    for (const file of ["credentials.json", "profiles.json"])
      expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  test("profiles.json holds no token for a profile that credentials.json already has", async () => {
    await saveToken(CLOUD, "cloud-token");
    selectProfile("ci");
    await saveToken(LOCAL, "ci-token");
    const text = await readFile(join(directory, "profiles.json"), "utf8");
    expect(text).not.toContain("cloud-token");
    expect(text).not.toContain("ci-token");
  });
});

describe("two profiles on one endpoint", () => {
  test("credentials.json holds the profile most recently used there; the other keeps its own token", async () => {
    await saveToken(CLOUD, "personal");
    selectProfile("work");
    await saveToken(CLOUD, "work");
    // work was saved last, so an older CLI reads its token for the endpoint
    expect((await oldView()).token(CLOUD)).toBe("work");
    expect((await savedProfile(CLOUD))?.token).toBe("work");
    selectProfile("default");
    expect((await savedProfile(CLOUD))?.token).toBe("personal");

    // the one with its own stored credential is the only one profiles.json carries a token for
    const names = JSON.parse(await readFile(join(directory, "profiles.json"), "utf8"));
    expect(names.profiles.work.credential).toBeUndefined();
    expect(names.profiles.default.credential.token).toBe("personal");

    // profile use hands the endpoint entry back, and an older CLI follows
    selectProfile(undefined);
    await useProfile("default");
    const old = await oldView();
    expect(old.active).toBe(CLOUD);
    expect(old.token(CLOUD)).toBe("personal");
    selectProfile("work");
    expect((await savedProfile(CLOUD))?.token).toBe("work");
  });

  test("teams and the default team travel with their profile", async () => {
    await saveTeam(CLOUD, "acme", team("acme", "acme-key"));
    selectProfile("other");
    await saveTeam(CLOUD, "beta", team("beta", "beta-key"));
    selectProfile("default");
    expect(await savedProfile(CLOUD)).toMatchObject({ team: "acme", token: "acme-key" });
    selectProfile("other");
    expect(await savedProfile(CLOUD)).toMatchObject({ team: "beta", token: "beta-key" });
    expect(Object.keys((await savedProfile(CLOUD))?.teams ?? {})).toEqual(["beta"]);
  });

  test("logging out of the holder leaves the other profile's token and gives the endpoint back to it", async () => {
    await saveToken(CLOUD, "personal");
    selectProfile("work");
    await saveToken(CLOUD, "work");
    await forgetToken(CLOUD);
    selectProfile(undefined);
    expect((await listProfiles()).map((entry) => entry.name)).toEqual(["default"]);
    expect((await savedProfile(CLOUD))?.token).toBe("personal");
    expect((await oldView()).token(CLOUD)).toBe("personal");
  });
});

describe("migration from version 1", () => {
  const v1 = JSON.stringify({
    version: 1,
    activeApiUrl: LOCAL,
    profiles: { [LOCAL]: { token: "community-token", kind: "community" }, [CLOUD]: { token: "cloud-token" } },
  });

  test("reading rewrites nothing; the default profile is the active endpoint", async () => {
    await writeFile(join(directory, "credentials.json"), v1);
    expect(await activeApiUrl()).toBe(LOCAL);
    expect((await listProfiles()).map((entry) => entry.name)).toEqual(["default", "dash.sproutboat.com"]);
    expect(await readFile(join(directory, "credentials.json"), "utf8")).toBe(v1);
    expect(await readdir(directory)).toEqual(["credentials.json"]);
  });

  test("the first write keeps every old entry and the active endpoint", async () => {
    await writeFile(join(directory, "credentials.json"), v1);
    await saveToken("https://third.test", "t3");
    const old = await oldView();
    expect(old.active).toBe(LOCAL);
    expect(old.endpoints).toEqual([LOCAL, CLOUD, "https://third.test"]);
    expect(old.token(LOCAL)).toBe("community-token");
    expect(old.token(CLOUD)).toBe("cloud-token");
    expect(await activeApiUrl()).toBe(LOCAL);
  });

  test("an older CLI that logs in afterwards is picked up as a profile, and its changes are kept", async () => {
    await saveToken(LOCAL, "community-token");
    const current = JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"));
    current.profiles["https://old-cli.test"] = { token: "from-old-cli" };
    current.profiles[LOCAL].token = "rotated-by-old-cli";
    await writeFile(join(directory, "credentials.json"), JSON.stringify(current));
    expect((await listProfiles()).map((entry) => entry.name)).toEqual(["default", "old-cli.test"]);
    expect((await savedProfile(LOCAL))?.token).toBe("rotated-by-old-cli");
    expect((await savedProfile("https://old-cli.test"))?.token).toBe("from-old-cli");
  });

  test("an older CLI that logs out of an endpoint drops that profile; one that changes the active endpoint wins", async () => {
    await saveToken(LOCAL, "community-token");
    await saveToken(CLOUD, "cloud-token");
    const current = JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"));
    delete current.profiles[LOCAL];
    current.activeApiUrl = CLOUD;
    await writeFile(join(directory, "credentials.json"), JSON.stringify(current));
    expect((await listProfiles()).map((entry) => `${entry.name}${entry.active ? "*" : ""}`)).toEqual([
      "dash.sproutboat.com*",
    ]);
    expect(await activeApiUrl()).toBe(CLOUD);
  });
});

describe("migration from the pre-release version 2 file", () => {
  const profile = (apiUrl: string, token: string) => ({ apiUrl, token, teams: {} });
  const v2 = () =>
    JSON.stringify({
      version: 2,
      activeProfile: "work",
      profiles: {
        default: profile(LOCAL, "community-token"),
        personal: profile(CLOUD, "personal"),
        work: { ...profile(CLOUD, "work"), kind: "cloud", team: "acme", teams: { acme: team("acme", "work") } },
      },
    });

  test("reading converts credentials.json back to version 1 and writes profiles.json", async () => {
    await writeFile(join(directory, "credentials.json"), v2());
    expect(await activeApiUrl()).toBe(CLOUD);
    const old = await oldView();
    expect(old.active).toBe(CLOUD);
    // work is the active profile, so it is the one an older CLI sees on that endpoint
    expect(old.token(CLOUD)).toBe("work");
    expect(old.token(LOCAL)).toBe("community-token");
    expect(JSON.parse(await readFile(join(directory, "credentials.json"), "utf8")).profiles[CLOUD].team).toBe("acme");
    expect((await stat(join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "profiles.json"))).mode & 0o777).toBe(0o600);
  });

  test("every profile survives, with its own token", async () => {
    await writeFile(join(directory, "credentials.json"), v2());
    const entries = await listProfiles();
    expect(entries.map((entry) => `${entry.name}${entry.active ? "*" : ""}:${entry.profile.token}`)).toEqual([
      "default:community-token",
      "personal:personal",
      "work*:work",
    ]);
    // a second read finds the converted files and changes nothing
    const before = await readFile(join(directory, "profiles.json"), "utf8");
    await listProfiles();
    expect(await readFile(join(directory, "profiles.json"), "utf8")).toBe(before);
  });

  test("a version 2 file with the old backup beside it is converted and the backup is left alone", async () => {
    await writeFile(join(directory, "credentials.json"), v2());
    await writeFile(join(directory, "credentials.v1.json"), "backup");
    await listProfiles();
    expect(await readFile(join(directory, "credentials.v1.json"), "utf8")).toBe("backup");
  });
});

// The CLI itself: the flags that pick a profile for one command must not disturb what an older CLI reads.
describe("through the CLI", () => {
  const serve = (username: string) =>
    Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/api/account")
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
  let cliRoot: string;
  let configDir: string;
  let project: string;

  beforeAll(async () => {
    cliRoot = await mkdtemp(join(tmpdir(), "sb-compat-cli-"));
    configDir = join(cliRoot, "config");
    project = join(cliRoot, "site");
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
        activeApiUrl: A,
        profiles: { [A]: { token: "alice-token", kind: "community" }, [B]: { token: "bob-token", kind: "community" } },
      }),
    );
  });
  afterAll(async () => {
    alpha.stop(true);
    beta.stop(true);
    await rm(cliRoot, { recursive: true, force: true });
  });

  async function cli(args: string[]) {
    const base = { ...process.env };
    for (const name of ["SPROUTBOAT_API_URL", "SPROUTBOAT_API_TOKEN", "SPROUTBOAT_TOKEN", "SPROUTBOAT_PROFILE"])
      delete base[name];
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...base, NO_COLOR: "1", SPROUTBOAT_NO_UPDATE_CHECK: "1", SPROUTBOAT_CONFIG_DIR: configDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }
  const old = async () => oldCli(await readFile(join(configDir, "sproutboat", "credentials.json"), "utf8"));

  test("login, --profile, profile use, deploy --profile and logout leave the version 1 reader working", async () => {
    // login to B as a second profile on B's endpoint: A stays the active endpoint
    expect((await cli(["login", "--profile", "bob", "--api-url", B, "--token", "bob-token"])).code).toBe(0);
    let view = await old();
    expect(view.active).toBe(A);
    expect(view.token(A)).toBe("alice-token");
    expect(view.token(B)).toBe("bob-token");

    // a second profile on A's endpoint with another token: it is the most recently used there
    expect((await cli(["login", "--profile", "carol", "--api-url", A, "--token", "alice-token"])).code).toBe(0);
    view = await old();
    expect(view.active).toBe(A);
    expect(view.token(A)).toBe("alice-token");

    // commands that only read, with --profile: nothing changes for an older CLI
    const before = await readFile(join(configDir, "sproutboat", "credentials.json"), "utf8");
    expect((await cli(["whoami", "--profile", "bob"])).stdout).toContain("account   bob");
    const dry = await cli(["deploy", project, "--profile", "bob", "--dry-run", "--artifact", join(cliRoot, "missing")]);
    expect(dry.stdout).toContain(`endpoint  ${B}`);
    expect(await readFile(join(configDir, "sproutboat", "credentials.json"), "utf8")).toBe(before);

    // profile use: the old reader follows the default
    expect((await cli(["profile", "use", "bob"])).code).toBe(0);
    view = await old();
    expect(view.active).toBe(B);
    expect(view.token(B)).toBe("bob-token");
    expect((await cli(["profile", "use", "default"])).code).toBe(0);
    view = await old();
    expect(view.active).toBe(A);
    expect(view.token(A)).toBe("alice-token");

    // logout of a named profile: the other endpoints stay readable
    expect((await cli(["logout", "--profile", "bob"])).code).toBe(0);
    view = await old();
    expect(view.active).toBe(A);
    // the profile migrated from the old file is still on B, so B stays
    expect(view.endpoints).toEqual([A, B]);
    expect(view.token(A)).toBe("alice-token");
    expect(view.token(B)).toBe("bob-token");
  });
});
