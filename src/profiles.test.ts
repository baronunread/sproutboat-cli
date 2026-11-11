import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeApiUrl,
  activeProfileName,
  forgetToken,
  listProfiles,
  migrateV1,
  profileNameForUrl,
  savedProfile,
  savedProfileName,
  saveToken,
  selectProfile,
  useProfile,
} from "./credentials";

const CLOUD = "https://dash.sproutboat.com";
const LOCAL = "http://localhost:8787";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sb-profiles-"));
  process.env.SPROUTBOAT_CONFIG_DIR = directory;
  directory = join(directory, "sproutboat");
  await mkdir(directory, { recursive: true });
  selectProfile(undefined);
});
afterEach(async () => {
  selectProfile(undefined);
  delete process.env.SPROUTBOAT_CONFIG_DIR;
  await rm(join(directory, ".."), { recursive: true, force: true });
});

const v1File = (activeApiUrl: string | undefined) =>
  JSON.stringify({
    version: 1,
    activeApiUrl,
    profiles: {
      [LOCAL]: { token: "community-token", kind: "community" },
      [CLOUD]: {
        token: "cloud-token",
        kind: "cloud",
        team: "acme",
        teams: { acme: { token: "cloud-token", id: "o1", name: "Acme", role: "owner", keyId: "k1", keyName: "CLI" } },
      },
    },
  });

describe("migrating the credentials written before profiles", () => {
  test("the active endpoint becomes the default profile and keeps working", async () => {
    await writeFile(join(directory, "credentials.json"), v1File(LOCAL));
    expect(await activeProfileName()).toBe("default");
    expect(await activeApiUrl()).toBe(LOCAL);
    expect((await savedProfile(LOCAL))?.token).toBe("community-token");
    expect((await savedProfile(CLOUD))?.teams.acme?.name).toBe("Acme");
  });

  test("every other stored endpoint becomes a profile named after its host", async () => {
    await writeFile(join(directory, "credentials.json"), v1File(LOCAL));
    const names = (await listProfiles()).map(
      (entry) => `${entry.name}${entry.active ? "*" : ""}=${entry.profile.apiUrl}`,
    );
    expect(names).toEqual([`default*=${LOCAL}`, `dash.sproutboat.com=${CLOUD}`]);
  });

  test("with no active endpoint there is no default profile, as before", async () => {
    await writeFile(join(directory, "credentials.json"), v1File(undefined));
    expect(await activeProfileName()).toBeUndefined();
    expect(await activeApiUrl()).toBeUndefined();
    expect((await listProfiles()).map((entry) => entry.name)).toEqual(["localhost-8787", "dash.sproutboat.com"]);
  });

  test("reading changes nothing on disk; the first write keeps the old file and writes version 2", async () => {
    const original = v1File(LOCAL);
    await writeFile(join(directory, "credentials.json"), original);
    await listProfiles();
    expect(await readFile(join(directory, "credentials.json"), "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["credentials.json"]);

    await saveToken("https://third.test", "t3");
    expect(await readFile(join(directory, "credentials.v1.json"), "utf8")).toBe(original);
    const written = JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"));
    expect(written.version).toBe(2);
    expect(written.activeProfile).toBe("default");
    expect(Object.keys(written.profiles)).toEqual(["default", "dash.sproutboat.com", "third.test"]);

    // a later write does not replace the backup with something newer
    await saveToken("https://fourth.test", "t4");
    expect(await readFile(join(directory, "credentials.v1.json"), "utf8")).toBe(original);
  });

  test("a version 2 file round-trips", async () => {
    await saveToken(CLOUD, "t1", "cloud");
    await saveToken(LOCAL, "t2", "community");
    expect((await listProfiles()).map((entry) => [entry.name, entry.active])).toEqual([
      ["default", true],
      ["localhost-8787", false],
    ]);
    expect(await activeApiUrl()).toBe(CLOUD);
    expect(await readdir(directory)).toEqual(["credentials.json"]);
  });

  test("migrateV1 never repoints or drops anything", () => {
    const profile = (apiUrl: string) => ({ apiUrl, token: apiUrl, teams: {} });
    const migrated = migrateV1(CLOUD, {
      [LOCAL]: profile(LOCAL),
      [CLOUD]: profile(CLOUD),
      "https://x.test": profile("https://x.test"),
    });
    expect(migrated.activeProfile).toBe("default");
    expect(migrated.profiles.default.apiUrl).toBe(CLOUD);
    expect(
      Object.values(migrated.profiles)
        .map((entry) => entry.apiUrl)
        .sort(),
    ).toEqual([CLOUD, LOCAL, "https://x.test"].sort());
  });

  test("names made from hosts are unique", () => {
    expect(profileNameForUrl("http://localhost:8787", new Set())).toBe("localhost-8787");
    expect(profileNameForUrl("http://localhost:8787", new Set(["localhost-8787"]))).toBe("localhost-8787-2");
  });
});

describe("selecting a profile", () => {
  test("lookups and saves go to the selected profile", async () => {
    await saveToken(CLOUD, "cloud-1", "cloud");
    selectProfile("work");
    await saveToken(CLOUD, "cloud-2", "cloud");
    expect((await savedProfile(CLOUD))?.token).toBe("cloud-2");
    selectProfile("default");
    expect((await savedProfile(CLOUD))?.token).toBe("cloud-1");
    selectProfile(undefined);
    expect(await savedProfileName(CLOUD)).toBe("default");
  });

  test("two profiles on one endpoint keep separate credentials, and logging out of one leaves the other", async () => {
    await saveToken(CLOUD, "personal");
    selectProfile("work");
    await saveToken(CLOUD, "work");
    expect((await forgetToken(CLOUD)).removed).toBe(true);
    selectProfile(undefined);
    expect((await savedProfile(CLOUD))?.token).toBe("personal");
  });

  test("a selected profile is not used for a different endpoint, and cannot be saved over one", async () => {
    await saveToken(LOCAL, "community");
    selectProfile("default");
    expect(await savedProfile(CLOUD)).toBeUndefined();
    await expect(saveToken(CLOUD, "x")).rejects.toThrow('the profile "default" is for http://localhost:8787');
  });

  test("a login to a second endpoint becomes its own profile and leaves the default alone", async () => {
    const first = await saveToken(LOCAL, "community");
    expect(first).toMatchObject({ profile: "default", activeProfile: "default" });
    const second = await saveToken(CLOUD, "cloud");
    expect(second).toMatchObject({ profile: "dash.sproutboat.com", activeProfile: "default", activeApiUrl: LOCAL });
  });

  test("profile use changes the default; an unknown name changes nothing", async () => {
    await saveToken(LOCAL, "community");
    await saveToken(CLOUD, "cloud");
    expect(await useProfile("nope")).toBe(false);
    expect(await useProfile("dash.sproutboat.com")).toBe(true);
    expect(await activeApiUrl()).toBe(CLOUD);
  });

  test("logging out of the default profile clears it", async () => {
    await saveToken(LOCAL, "community");
    await saveToken(CLOUD, "cloud");
    expect(await forgetToken(LOCAL)).toEqual({ removed: true, activeApiUrl: undefined, remaining: [] });
    expect(await activeProfileName()).toBeUndefined();
  });
});
