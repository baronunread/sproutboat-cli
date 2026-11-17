import { afterEach, expect, test } from "bun:test";
import { porfforChannel } from "./compile";
import { porfforVersion } from "./toolchain";

const saved = process.env.SPROUTBOAT_PORFFOR_CHANNEL;
afterEach(() => {
  if (saved === undefined) delete process.env.SPROUTBOAT_PORFFOR_CHANNEL;
  else process.env.SPROUTBOAT_PORFFOR_CHANNEL = saved;
});

test("standalone builds use alpha 25, by default and when asked for by name", () => {
  delete process.env.SPROUTBOAT_PORFFOR_CHANNEL;
  expect(porfforChannel()).toBe("alpha-25");
  process.env.SPROUTBOAT_PORFFOR_CHANNEL = "alpha-25";
  expect(porfforChannel()).toBe("alpha-25");
});

test("alpha 19, 21, 22, 23 and 24 are errors that say they are no longer supported", () => {
  for (const channel of ["alpha-19", "alpha-21", "alpha-22", "alpha-23", "alpha-24"]) {
    process.env.SPROUTBOAT_PORFFOR_CHANNEL = channel;
    expect(() => porfforChannel()).toThrow(/no longer supported/);
  }
});

test("the recorded Porffor version names the channel's release", () => {
  expect(porfforVersion("alpha-25")).toStartWith("alpha-25 (");
});
