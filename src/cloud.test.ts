import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { configAccount, parseProjectConfig } from "./account-field";
import {
  cloudLogout,
  detectKind,
  deviceLogin,
  envToken,
  explainApiFailure,
  fetchWhoami,
  loginAndStore,
  resolveSession,
  type CloudIo,
} from "./cloud";
import {
  buildAssetBundle,
  type CloudDeployPlan,
  compileModule,
  deployToCloud,
  hostFor,
  type ModuleInputs,
} from "./cloud-deploy";
import { FAKE_KEY, startFakeCloud } from "./cloud-fake";
import { activeApiUrl, forgetToken, saveTeam, savedProfile, saveToken, type StoredTeam } from "./credentials";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-cloud-"));
  process.env.SPROUTBOAT_CONFIG_DIR = dir;
});
afterEach(async () => {
  delete process.env.SPROUTBOAT_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

function fakeIo(overrides: Partial<CloudIo> = {}) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const io: CloudIo = {
    log: (l) => lines.push(l),
    warn: (l) => lines.push(l),
    interactive: false,
    openUrl: (u) => (opened.push(u), true),
    sleep: async (ms) => void sleeps.push(ms),
    choose: async (_q, choices) => choices[0]!,
    ...overrides,
  };
  return { io, lines, sleeps, opened };
}

const team = (slug: string, token = `sbk_${slug}`): StoredTeam => ({
  token,
  id: `org_${slug}`,
  name: slug.toUpperCase(),
  role: "developer",
  keyId: "k",
  keyName: "CLI on testbox",
});
const pending = { status: 400, body: { error: "authorization_pending" } };

describe("credentials", () => {
  test("the file and its directory are private", async () => {
    await saveTeam("https://dash.test", "acme", team("acme"));
    expect((await stat(join(dir, "sproutboat", "credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "sproutboat"))).mode & 0o777).toBe(0o700);
  });

  test("several teams per profile, the newest is the default, and the file carries a plain token", async () => {
    await saveTeam("https://dash.test", "acme", team("acme"));
    await saveTeam("https://dash.test", "beta", team("beta"));
    const profile = await savedProfile("https://dash.test");
    expect(profile?.team).toBe("beta");
    expect(profile?.token).toBe("sbk_beta");
    expect(Object.keys(profile?.teams ?? {})).toEqual(["acme", "beta"]);
    const raw = JSON.parse(await Bun.file(join(dir, "sproutboat", "credentials.json")).text());
    expect(raw.version).toBe(1);
    expect(raw.activeApiUrl).toBe("https://dash.test");
    expect(raw.profiles["https://dash.test"]).toMatchObject({ team: "beta", token: "sbk_beta" });
  });

  test("forgetting the default team promotes another; the last one removes the endpoint", async () => {
    await saveTeam("https://dash.test", "acme", team("acme"));
    await saveTeam("https://dash.test", "beta", team("beta"));
    expect(await forgetToken("https://dash.test", "beta")).toMatchObject({ removed: true, remaining: ["acme"] });
    expect((await savedProfile("https://dash.test"))?.team).toBe("acme");
    expect(await forgetToken("https://dash.test", "nope")).toMatchObject({ removed: false });
    await forgetToken("https://dash.test", "acme");
    expect(await savedProfile("https://dash.test")).toBeUndefined();
    expect(await activeApiUrl()).toBeUndefined();
  });

  test("a version 1 file from an older CLI (token only) still reads", async () => {
    await mkdir(join(dir, "sproutboat"), { recursive: true });
    await writeFile(
      join(dir, "sproutboat", "credentials.json"),
      JSON.stringify({
        version: 1,
        activeApiUrl: "https://old.test",
        profiles: { "https://old.test": { token: "t" } },
      }),
    );
    expect(await savedProfile("https://old.test")).toEqual({
      apiUrl: "https://old.test",
      token: "t",
      kind: undefined,
      team: undefined,
      teams: {},
    });
    await saveToken("https://old.test", "t2", "community");
    expect((await savedProfile("https://old.test"))?.kind).toBe("community");
  });

  test.skipIf(platform() !== "darwin")(
    "macOS: the old ~/.config location is read when the new one has no file",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "sb-home-"));
      const previous = {
        home: process.env.HOME,
        config: process.env.SPROUTBOAT_CONFIG_DIR,
        xdg: process.env.XDG_CONFIG_HOME,
      };
      try {
        delete process.env.SPROUTBOAT_CONFIG_DIR;
        delete process.env.XDG_CONFIG_HOME;
        process.env.HOME = home;
        await mkdir(join(home, ".config", "sproutboat"), { recursive: true });
        await writeFile(
          join(home, ".config", "sproutboat", "credentials.json"),
          JSON.stringify({ version: 1, profiles: { "https://old.test": { token: "old" } } }),
        );
        expect((await savedProfile("https://old.test"))?.token).toBe("old");
        await saveToken("https://new.test", "n");
        expect((await stat(join(home, "Library", "Preferences", "sproutboat", "credentials.json"))).mode & 0o777).toBe(
          0o600,
        );
      } finally {
        process.env.HOME = previous.home;
        process.env.SPROUTBOAT_CONFIG_DIR = previous.config;
        if (previous.xdg !== undefined) process.env.XDG_CONFIG_HOME = previous.xdg;
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

test("SPROUTBOAT_API_TOKEN beats the older name", () => {
  expect(envToken({ SPROUTBOAT_API_TOKEN: "a", SPROUTBOAT_TOKEN: "b" })).toEqual({
    token: "a",
    source: "SPROUTBOAT_API_TOKEN",
  });
  expect(envToken({ SPROUTBOAT_TOKEN: "b" })).toEqual({ token: "b", source: "SPROUTBOAT_TOKEN" });
  expect(envToken({})).toBeUndefined();
});

describe("account field", () => {
  test("is read from the config and hidden from the shared schema", () => {
    const source = `{ // comment\n "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07", "account": "acme", }`;
    expect(configAccount(source)).toBe("acme");
    const parsed = parseProjectConfig(source);
    expect(parsed.ok).toBe(true);
    expect(
      parseProjectConfig(
        `{"name":"hello","main":"src/index.js","compatibility_date":"2026-09-07","account":"Not Valid"}`,
      ).ok,
    ).toBe(false);
    expect(configAccount(`{"name":"hello"}`)).toBeUndefined();
  });
});

describe("device login", () => {
  const options = (url: string, io: CloudIo) => ({ apiUrl: url, io, hostname: "testbox", os: "linux x64" });

  test("detects a Cloud by /v1/config", async () => {
    const cloud = startFakeCloud();
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("nope", { status: 404 }) });
    try {
      expect(await detectKind(cloud.url)).toBe("cloud");
      expect(await detectKind(`http://127.0.0.1:${other.port}`)).toBe("community");
    } finally {
      cloud.stop();
      other.stop(true);
    }
  });

  test("pending, slow_down (+5 s), then approval stores the key", async () => {
    const cloud = startFakeCloud({
      tokenReplies: [
        pending,
        { status: 400, body: { error: "slow_down" } },
        pending,
        {
          status: 200,
          body: {
            access_token: FAKE_KEY,
            key_id: "key_1",
            key_name: "CLI on testbox",
            organization: { id: "org_1", slug: "acme", name: "Acme Inc" },
            role: "developer",
          },
        },
      ],
    });
    const { io, lines, sleeps, opened } = fakeIo({ interactive: true });
    try {
      const done = await loginAndStore({ ...options(cloud.url, io), account: "acme" });
      expect(done.slug).toBe("acme");
      expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
      expect(opened).toEqual([`${cloud.url}/device?code=ABCD-EFGH&team=acme`]);
      expect(lines.join("\n")).toContain("ABCD-EFGH");
      expect((await savedProfile(cloud.url))?.teams.acme?.token).toBe(FAKE_KEY);
      const start = cloud.calls.find((c) => c.path === "/v1/device/code")!;
      expect(JSON.parse(start.body)).toEqual({ client_id: "sproutboat-cli", hostname: "testbox", os: "linux x64" });
    } finally {
      cloud.stop();
    }
  });

  test("without a terminal the address is printed and no browser is opened", async () => {
    const cloud = startFakeCloud();
    const { io, lines, opened } = fakeIo({ interactive: false });
    try {
      await deviceLogin(options(cloud.url, io));
      expect(opened).toEqual([]);
      expect(lines.join("\n")).toContain(`${cloud.url}/device?code=ABCD-EFGH`);
    } finally {
      cloud.stop();
    }
  });

  test("a terminal that cannot open a browser still prints the address", async () => {
    const cloud = startFakeCloud();
    const { io, lines } = fakeIo({ interactive: true, openUrl: () => false });
    try {
      await deviceLogin(options(cloud.url, io));
      expect(lines.join("\n")).toContain("Open this address");
    } finally {
      cloud.stop();
    }
  });

  test("denied and expired stop with a clear message", async () => {
    for (const [error, message] of [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
    ] as const) {
      const cloud = startFakeCloud({ tokenReplies: [pending, { status: 400, body: { error } }] });
      try {
        await expect(deviceLogin(options(cloud.url, fakeIo().io))).rejects.toThrow(message);
        expect(cloud.tokenPolls).toBe(2);
      } finally {
        cloud.stop();
      }
    }
  });

  test("gives up at the local deadline", async () => {
    const cloud = startFakeCloud({ tokenReplies: [pending] });
    let clock = 0;
    const { io } = fakeIo({ sleep: async (ms) => void (clock += ms) });
    try {
      await expect(deviceLogin({ ...options(cloud.url, io), now: () => clock })).rejects.toThrow("expired");
      expect(cloud.tokenPolls).toBe(120);
    } finally {
      cloud.stop();
    }
  });

  test("a rate-limited start says so", async () => {
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ error: "slow" }, { status: 429 }),
    });
    try {
      await expect(deviceLogin(options(`http://127.0.0.1:${other.port}`, fakeIo().io))).rejects.toThrow(
        "too many login attempts",
      );
    } finally {
      other.stop(true);
    }
  });
});

describe("who and which team", () => {
  test("whoami reads the key's team and permissions", async () => {
    const cloud = startFakeCloud();
    try {
      const who = await fetchWhoami(cloud.url, FAKE_KEY, false);
      expect(who).toMatchObject({
        slug: "acme",
        name: "Acme Inc",
        keyName: "CLI on testbox",
        person: { email: "robin@example.test" },
      });
      expect(who.permissions).toContain("app:read/write/delete_own");
      await expect(fetchWhoami(cloud.url, "sbk_wrong", false)).rejects.toThrow("sproutboat login");
      await expect(fetchWhoami(cloud.url, "sbk_wrong", true)).rejects.toThrow("SPROUTBOAT_API_TOKEN was rejected");
    } finally {
      cloud.stop();
    }
  });

  const login = async () => {
    throw new Error("login must not run");
  };

  test("the environment key wins over the stored login and fixes the team", async () => {
    const cloud = startFakeCloud();
    try {
      await saveTeam(cloud.url, "other", team("other"));
      const session = await resolveSession({
        apiUrl: cloud.url,
        io: fakeIo().io,
        env: { SPROUTBOAT_API_TOKEN: FAKE_KEY },
        login,
      });
      expect(session).toMatchObject({ token: FAKE_KEY, slug: "acme", source: "SPROUTBOAT_API_TOKEN" });
      await expect(
        resolveSession({
          apiUrl: cloud.url,
          io: fakeIo().io,
          account: "other",
          env: { SPROUTBOAT_API_TOKEN: FAKE_KEY },
          login,
        }),
      ).rejects.toThrow('belongs to the team "acme"');
    } finally {
      cloud.stop();
    }
  });

  test("one stored team is used; several need a choice", async () => {
    await saveTeam("https://x.test", "acme", team("acme"));
    const single = await resolveSession({ apiUrl: "https://x.test", io: fakeIo().io, env: {}, login });
    expect(single.slug).toBe("acme");
    await saveTeam("https://x.test", "beta", team("beta"));
    await expect(resolveSession({ apiUrl: "https://x.test", io: fakeIo().io, env: {}, login })).rejects.toThrow(
      /account.*SPROUTBOAT_ACCOUNT/,
    );
    const asked: string[][] = [];
    const picked = await resolveSession({
      apiUrl: "https://x.test",
      io: fakeIo({ interactive: true, choose: async (_q, c) => (asked.push(c), c[1]!) }).io,
      env: {},
      login,
    });
    expect(asked).toEqual([["acme", "beta"]]);
    expect(picked.slug).toBe("beta");
    expect(
      (await resolveSession({ apiUrl: "https://x.test", io: fakeIo().io, account: "acme", env: {}, login })).slug,
    ).toBe("acme");
    expect(
      (await resolveSession({ apiUrl: "https://x.test", io: fakeIo().io, env: { SPROUTBOAT_ACCOUNT: "beta" }, login }))
        .slug,
    ).toBe("beta");
    await expect(
      resolveSession({ apiUrl: "https://x.test", io: fakeIo().io, account: "gamma", env: {}, login }),
    ).rejects.toThrow("login --account gamma");
  });

  test("logged out: no terminal names SPROUTBOAT_API_TOKEN, a terminal starts the login", async () => {
    await expect(resolveSession({ apiUrl: "https://x.test", io: fakeIo().io, env: {}, login })).rejects.toThrow(
      "SPROUTBOAT_API_TOKEN",
    );
    const { io, lines } = fakeIo({ interactive: true });
    const session = await resolveSession({
      apiUrl: "https://x.test",
      io,
      env: {},
      login: async () => ({ slug: "acme", team: team("acme") }),
    });
    expect(session.slug).toBe("acme");
    expect(lines.join("\n")).toContain("starting the login");
  });

  test("logout revokes on the server then forgets; a dead key or server still clears the file", async () => {
    const cloud = startFakeCloud();
    try {
      await saveTeam(cloud.url, "acme", team("acme", FAKE_KEY));
      const out = await cloudLogout(cloud.url);
      expect(out).toEqual({ kind: "done", slug: "acme", server: "revoked", remaining: [] });
      expect(cloud.revoked).toBe(true);
      expect(await savedProfile(cloud.url)).toBeUndefined();
      await saveTeam(cloud.url, "acme", team("acme", FAKE_KEY));
      expect(await cloudLogout(cloud.url)).toMatchObject({ server: "already-gone" });
      await saveTeam("http://127.0.0.1:1", "acme", team("acme"));
      expect(await cloudLogout("http://127.0.0.1:1")).toMatchObject({ server: "unreachable" });
      expect(await savedProfile("http://127.0.0.1:1")).toBeUndefined();
      expect(await cloudLogout(cloud.url)).toEqual({ kind: "none" });
    } finally {
      cloud.stop();
    }
  });
});

describe("error mapping", () => {
  test("401, 403 and 413", () => {
    expect(explainApiFailure(401, "{}", false)).toContain("sproutboat login");
    expect(explainApiFailure(401, "{}", true)).toContain("SPROUTBOAT_API_TOKEN was rejected");
    const forbidden = explainApiFailure(
      403,
      JSON.stringify({ error: "viewer may not write app", need: "app:write" }),
      false,
    );
    expect(forbidden).toContain("app:write");
    expect(forbidden).toContain("role");
    expect(explainApiFailure(413, JSON.stringify({ error: "module exceeds 64 MiB" }), false)).toContain("too large");
    expect(explainApiFailure(500, "boom", false)).toContain("HTTP 500");
  });
});

describe("cloud deploy", () => {
  let work: string;
  let moduleFile: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "sb-deploy-"));
    moduleFile = join(work, "app.so");
    await writeFile(moduleFile, "module-bytes");
  });
  afterEach(() => rm(work, { recursive: true, force: true }));

  const plan = (url: string, extra: Partial<CloudDeployPlan> = {}) => ({
    apiUrl: url,
    token: FAKE_KEY,
    tokenFromEnv: false,
    project: "hello",
    hosts: [hostFor("hello", "acme")],
    modulePath: moduleFile,
    noWait: false,
    pollMs: 1,
    ...extra,
  });

  test("first deploy creates the app and waits for the host", async () => {
    const cloud = startFakeCloud({ applyStates: ["pending", "applied"] });
    try {
      const result = await deployToCloud(plan(cloud.url), fakeIo().io);
      expect(result).toEqual({ created: true, generation: 1, url: "https://hello.acme.sproutboat.app", applied: true });
      expect(cloud.spec).toMatchObject({ hosts: ["hello.acme.sproutboat.app"] });
      expect(cloud.modules.size).toBe(1);
      const paths = cloud.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f]{64}/, "<sha>")}`);
      expect(paths.slice(0, 3)).toEqual(["GET /v1/apps/hello", "PUT /v1/modules/<sha>", "PUT /v1/apps/hello"]);
      expect(cloud.calls.every((c) => c.auth === `Bearer ${FAKE_KEY}`)).toBe(true);
    } finally {
      cloud.stop();
    }
  });

  test("an update reports Updated and keeps the current assets when there are none", async () => {
    const ref = `assets/${"a".repeat(64)}`;
    const cloud = startFakeCloud({ appExists: true, existingAssetsRef: ref });
    try {
      const result = await deployToCloud(plan(cloud.url, { noWait: true }), fakeIo().io);
      expect(result).toMatchObject({ created: false, applied: "skipped" });
      expect(cloud.spec).toMatchObject({ assets_manifest_ref: ref });
    } finally {
      cloud.stop();
    }
  });

  test("assets upload only the missing blobs, then the manifest, and the app points at it", async () => {
    const site = join(work, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "<h1>hi</h1>");
    await writeFile(join(site, "a.css"), "body{}");
    await writeFile(join(site, "_headers"), "/*\n  X-Test: 1\n");
    const bundle = buildAssetBundle(work, { directory: "site" });
    expect(bundle.files).toBe(2);
    const cloud = startFakeCloud();
    const known = [...bundle.blobs.keys()][0]!;
    cloud.blobs.add(known);
    try {
      await deployToCloud(plan(cloud.url, { assets: bundle, noWait: true }), fakeIo().io);
      expect(cloud.blobs.size).toBe(2);
      expect(cloud.calls.filter((c) => c.path.startsWith("/v1/assets/blobs/")).length).toBe(1);
      expect(cloud.manifests.has(bundle.manifestSha)).toBe(true);
      expect(cloud.spec).toMatchObject({ assets_manifest_ref: `assets/${bundle.manifestSha}` });
      expect(bundle.manifestText).toContain("X-Test");
    } finally {
      cloud.stop();
    }
    expect(() => buildAssetBundle(work, { directory: "missing" })).toThrow("not found");
  });

  test("a failed apply is an error carrying the host's reason", async () => {
    const cloud = startFakeCloud({ applyStates: ["failed"] });
    try {
      await expect(deployToCloud(plan(cloud.url), fakeIo().io)).rejects.toThrow("module failed to load");
    } finally {
      cloud.stop();
    }
  });

  test("a host that never applies returns applied: false at the deadline", async () => {
    const cloud = startFakeCloud({ applyStates: ["pending"] });
    try {
      const result = await deployToCloud(plan(cloud.url, { waitMs: 30 }), fakeIo().io);
      expect(result.applied).toBe(false);
    } finally {
      cloud.stop();
    }
  });

  test("401 and 403 become guidance", async () => {
    const cloud = startFakeCloud();
    const denied = startFakeCloud({
      failWith: { status: 403, body: { error: "viewer may not write app", need: "app:write" } },
    });
    try {
      await expect(deployToCloud(plan(cloud.url, { token: "sbk_bad" }), fakeIo().io)).rejects.toThrow(
        "sproutboat login",
      );
      await expect(
        deployToCloud(plan(cloud.url, { token: "sbk_bad", tokenFromEnv: true }), fakeIo().io),
      ).rejects.toThrow("SPROUTBOAT_API_TOKEN was rejected");
      await expect(deployToCloud(plan(denied.url), fakeIo().io)).rejects.toThrow("app:write");
    } finally {
      cloud.stop();
      denied.stop();
    }
  });

  test("without --module, --sproutd and --generation the error says deploys are built by the Cloud", async () => {
    const run = (extra: Partial<ModuleInputs>) =>
      compileModule({
        project: "hello",
        emit: async () => join(work, "unit.js"),
        out: join(work, "out.so"),
        bun: process.execPath,
        ...extra,
      });
    await expect(run({})).rejects.toThrow("Regular deploys are built by the Cloud");
    await expect(run({ sproutd: work, generation: work })).rejects.toThrow("compile-app.ts");
  });

  test("compile-app is run against the generation with the unit and the app name", async () => {
    const sproutd = join(work, "sproutd");
    const generation = join(work, "gen");
    await mkdir(join(sproutd, "build"), { recursive: true });
    await mkdir(generation);
    await writeFile(join(generation, "manifest.json"), "{}");
    await writeFile(
      join(sproutd, "build", "compile-app.ts"),
      `import { writeFileSync } from "node:fs";
const [gen, unit, out, flag, name] = process.argv.slice(2);
writeFileSync(out, JSON.stringify({ gen, unit, flag, name }));
console.log(JSON.stringify({ status: "admitted" }));`,
    );
    const out = join(work, "out.so");
    await compileModule({
      project: "hello",
      emit: async () => "/unit/sprout.generated.js",
      sproutd,
      generation,
      out,
      bun: process.execPath,
    });
    expect(JSON.parse(await Bun.file(out).text())).toMatchObject({
      unit: "/unit/sprout.generated.js",
      flag: "--name",
      name: "hello",
    });
  });
});

describe("the CLI end to end", () => {
  const main = join(import.meta.dir, "main.ts");
  const run = async (args: string[], env: Record<string, string>, cwd?: string) => {
    const child = Bun.spawn([process.execPath, main, ...args], {
      cwd,
      env: {
        ...process.env,
        SPROUTBOAT_CONFIG_DIR: dir,
        SPROUTBOAT_NO_UPDATE_CHECK: "1",
        SPROUTBOAT_API_TOKEN: "",
        SPROUTBOAT_TOKEN: "",
        ...env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  let project: string;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "sb-proj-"));
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "index.js"), "export default { fetch() { return new Response('hi'); } };\n");
    await writeFile(
      join(project, "sproutboat.jsonc"),
      `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07", "account": "acme" }`,
    );
    await writeFile(join(project, "app.so"), "module-bytes");
  });
  afterEach(() => rm(project, { recursive: true, force: true }));

  test("deploy with an environment key, then whoami, then logout is refused for env-only", async () => {
    const cloud = startFakeCloud();
    try {
      const env = { SPROUTBOAT_API_URL: cloud.url, SPROUTBOAT_API_TOKEN: FAKE_KEY };
      const deployed = await run(["deploy", project, "--module", join(project, "app.so")], env);
      expect(deployed.stderr).toBe("");
      expect(deployed.code).toBe(0);
      expect(deployed.stdout).toContain("Created hello");
      expect(deployed.stdout).toContain("https://hello.acme.sproutboat.app");
      expect(deployed.stdout).toContain("generation 1");
      const again = await run(["deploy", project, "--module", join(project, "app.so"), "--no-wait"], env);
      expect(again.stdout).toContain("Updated hello");
      const who = await run(["whoami"], env);
      expect(who.code).toBe(0);
      expect(who.stdout).toContain("acme");
      expect(who.stdout).toContain("token from SPROUTBOAT_API_TOKEN");
      expect(who.stdout).toContain("robin@example.test");
    } finally {
      cloud.stop();
    }
  });

  test("deploy dry-run prints the plan and writes nothing", async () => {
    const cloud = startFakeCloud();
    try {
      const out = await run(["deploy", project, "--dry-run", "--module", join(project, "app.so")], {
        SPROUTBOAT_API_URL: cloud.url,
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("https://hello.acme.sproutboat.app");
      expect(out.stdout).toContain("--dry-run: not uploading.");
      expect(cloud.calls.filter((c) => c.method !== "GET")).toEqual([]);
    } finally {
      cloud.stop();
    }
  });

  test("deploy logged out with no terminal fails naming SPROUTBOAT_API_TOKEN", async () => {
    const cloud = startFakeCloud();
    try {
      const out = await run(["deploy", project, "--module", join(project, "app.so")], {
        SPROUTBOAT_API_URL: cloud.url,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("SPROUTBOAT_API_TOKEN");
      expect(cloud.calls.some((c) => c.path === "/v1/device/code")).toBe(false);
    } finally {
      cloud.stop();
    }
  });

  test("login (no terminal prints the link), whoami, logout revokes the key", async () => {
    const cloud = startFakeCloud();
    try {
      const env = { SPROUTBOAT_API_URL: cloud.url };
      const loggedIn = await run(["login"], env);
      // The fake's interval is 5 s, so this polls once after waiting.
      expect(loggedIn.code).toBe(0);
      expect(loggedIn.stdout).toContain("ABCD-EFGH");
      expect(loggedIn.stdout).toContain("logged in to acme");
      expect(loggedIn.stdout + loggedIn.stderr).not.toContain(FAKE_KEY);
      const who = await run(["whoami"], env);
      expect(who.stdout).toContain("stored login");
      const out = await run(["logout"], env);
      expect(out.stdout).toContain("revoked its key on the server");
      expect(cloud.revoked).toBe(true);
      expect((await run(["whoami"], env)).code).toBe(1);
    } finally {
      cloud.stop();
    }
  }, 30000);
});
