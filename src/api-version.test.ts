import { expect, test } from "bun:test";
import { controlVersionWarning, CONTROL_VERSION_HEADER, MIN_CLI_HEADER } from "./api-version";

const reply = (headers: Record<string, string>) => new Response("", { headers });

test("no headers (control plane older than the handshake) says nothing", () => {
  expect(controlVersionWarning(reply({}), "0.6.1")).toBeNull();
});

test("a CLI at or above the minimum says nothing", () => {
  expect(controlVersionWarning(reply({ [MIN_CLI_HEADER]: "0.6.1" }), "0.6.1")).toBeNull();
  expect(controlVersionWarning(reply({ [MIN_CLI_HEADER]: "0.6.1" }), "0.7.0")).toBeNull();
  // 0.10.0 is newer than 0.9.0 — the compare is numeric, not lexical.
  expect(controlVersionWarning(reply({ [MIN_CLI_HEADER]: "0.9.0" }), "0.10.0")).toBeNull();
});

test("an older CLI is told what to do, and by whom", () => {
  const warning = controlVersionWarning(
    reply({ [MIN_CLI_HEADER]: "0.8.0", [CONTROL_VERSION_HEADER]: "0.3.0" }),
    "0.6.1",
  );
  expect(warning).toContain("0.8.0");
  expect(warning).toContain("0.6.1");
  expect(warning).toContain("(0.3.0)");
  expect(warning).toContain("upgrade");
});

test("the control version is optional in the message", () => {
  expect(controlVersionWarning(reply({ [MIN_CLI_HEADER]: "0.8.0" }), "0.6.1")).toContain("needs sproutboat 0.8.0");
});
