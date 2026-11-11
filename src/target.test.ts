import { describe, expect, test } from "bun:test";
import { chooseTarget, TargetError, type TargetInput } from "./target";

const CLOUD = "https://dash.sproutboat.com";
const LOCAL = "http://localhost:8787";
const base: TargetInput = {
  profiles: { default: { apiUrl: LOCAL }, cloud: { apiUrl: CLOUD } },
  activeProfile: "default",
  defaultUrl: CLOUD,
};

describe("which endpoint and profile a command uses", () => {
  test("nothing named: the active profile, which is the Community login on this Mac", () => {
    expect(chooseTarget(base)).toEqual({
      apiUrl: LOCAL,
      source: "profile",
      profile: { name: "default", source: "active profile", exists: true },
    });
  });

  test("no profiles stored: the default endpoint", () => {
    expect(chooseTarget({ ...base, profiles: {}, activeProfile: undefined })).toEqual({
      apiUrl: CLOUD,
      source: "default",
    });
  });

  test("--profile beats the active profile", () => {
    const target = chooseTarget({ ...base, flagProfile: "cloud" });
    expect(target.apiUrl).toBe(CLOUD);
    expect(target.profile).toEqual({ name: "cloud", source: "--profile", exists: true });
  });

  test("SPROUTBOAT_PROFILE beats the active profile, and --profile beats SPROUTBOAT_PROFILE", () => {
    expect(chooseTarget({ ...base, envProfile: "cloud" }).profile?.name).toBe("cloud");
    expect(chooseTarget({ ...base, envProfile: "cloud", flagProfile: "default" }).profile?.name).toBe("default");
  });

  test("--api-url beats the active profile and SPROUTBOAT_PROFILE, and leaves the profile to the URL lookup", () => {
    expect(chooseTarget({ ...base, flagUrl: "https://x.test/" })).toEqual({
      apiUrl: "https://x.test",
      source: "--api-url",
    });
    expect(chooseTarget({ ...base, flagUrl: CLOUD, envProfile: "default" })).toEqual({
      apiUrl: CLOUD,
      source: "--api-url",
    });
  });

  test("SPROUTBOAT_API_URL beats the active profile; --profile beats SPROUTBOAT_API_URL", () => {
    expect(chooseTarget({ ...base, envUrl: CLOUD })).toEqual({ apiUrl: CLOUD, source: "SPROUTBOAT_API_URL" });
    expect(chooseTarget({ ...base, envUrl: CLOUD, flagProfile: "default" }).apiUrl).toBe(LOCAL);
  });

  test("a profile and a URL that name different places are an error, not a quiet pick", () => {
    expect(() => chooseTarget({ ...base, flagProfile: "cloud", flagUrl: LOCAL })).toThrow(TargetError);
    expect(() => chooseTarget({ ...base, envProfile: "cloud", envUrl: LOCAL })).toThrow("drop one of them");
    expect(chooseTarget({ ...base, flagProfile: "cloud", flagUrl: `${CLOUD}/` }).apiUrl).toBe(CLOUD);
  });

  test("an unknown profile is an error that lists the known ones, unless login may create it", () => {
    expect(() => chooseTarget({ ...base, flagProfile: "nope" })).toThrow(
      'no profile named "nope" (profiles: default, cloud)',
    );
    expect(chooseTarget({ ...base, flagProfile: "work", allowNew: true })).toEqual({
      apiUrl: CLOUD,
      source: "default",
      profile: { name: "work", source: "--profile", exists: false },
    });
    expect(chooseTarget({ ...base, flagProfile: "work", flagUrl: "https://x.test", allowNew: true }).apiUrl).toBe(
      "https://x.test",
    );
    expect(chooseTarget({ ...base, flagProfile: "work", envUrl: "https://e.test", allowNew: true }).apiUrl).toBe(
      "https://e.test",
    );
  });

  test("a profile name is checked", () => {
    expect(() => chooseTarget({ ...base, flagProfile: "../x" })).toThrow("not a profile name");
  });

  test("an active profile that is no longer stored falls through to the default endpoint", () => {
    expect(chooseTarget({ ...base, activeProfile: "gone" })).toEqual({ apiUrl: CLOUD, source: "default" });
  });
});
