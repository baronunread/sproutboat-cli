import { afterEach, expect, test } from "bun:test";
import { porfforChannel } from "./compile";
import { porfforVersion } from "./toolchain";

const saved = process.env.SPROUTBOAT_PORFFOR_CHANNEL;
afterEach(() => {
  if (saved === undefined) delete process.env.SPROUTBOAT_PORFFOR_CHANNEL;
  else process.env.SPROUTBOAT_PORFFOR_CHANNEL = saved;
});

test("standalone builds default to alpha 23, with alpha 22 and alpha 19 selectable", () => {
  delete process.env.SPROUTBOAT_PORFFOR_CHANNEL;
  expect(porfforChannel()).toBe("alpha-23");
  process.env.SPROUTBOAT_PORFFOR_CHANNEL = "alpha-22";
  expect(porfforChannel()).toBe("alpha-22");
  process.env.SPROUTBOAT_PORFFOR_CHANNEL = "alpha-19";
  expect(porfforChannel()).toBe("alpha-19");
});

test("--with-restore stays on alpha 19 unless alpha 22 or 23 is asked for, which is an error", () => {
  delete process.env.SPROUTBOAT_PORFFOR_CHANNEL;
  expect(porfforChannel(true)).toBe("alpha-19");
  process.env.SPROUTBOAT_PORFFOR_CHANNEL = "alpha-19";
  expect(porfforChannel(true)).toBe("alpha-19");
  for (const channel of ["alpha-22", "alpha-23"]) {
    process.env.SPROUTBOAT_PORFFOR_CHANNEL = channel;
    expect(() => porfforChannel(true)).toThrow(/--with-restore is not available on Porffor alpha 22 or 23/);
  }
});

test("the recorded Porffor version names the channel's release", () => {
  expect(porfforVersion("alpha-23")).toStartWith("alpha-23 (");
  expect(porfforVersion("alpha-22")).toStartWith("alpha-22 (");
  expect(porfforVersion("alpha-19")).toStartWith("alpha-19 (");
});
