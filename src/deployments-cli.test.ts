import { expect, test } from "bun:test";
import {
  formatDeployment,
  formatStatus,
  parseCommunityVersions,
  parseDeployments,
  parseDeploymentsArgs,
  parseLive,
  tailSummary,
  LIST_USAGE,
} from "./deployments-cli";
import { parseBuildView } from "./cloud-deploy";
import { explainApiFailure } from "./cloud";
import type { JsonObject } from "./json";

const build = (over: JsonObject = {}): JsonObject => ({
  id: "b1",
  state: "ready",
  cached: false,
  record_generation: 3,
  hosts: ["hello.acme.sproutboat.app"],
  queued_at: "2026-11-11T10:00:00.000Z",
  finished_at: "2026-11-11T10:00:05.000Z",
  stats: { wall_ms: 4100 },
  error: null,
  ...over,
});

test("arguments: --json, --api-url, --account, positionals, and refusals", () => {
  expect(parseDeploymentsArgs(["--json", "abc", "--account", "acme"], LIST_USAGE)).toEqual({
    positional: ["abc"],
    flags: { json: true, limit: 10, account: "acme" },
  });
  expect(() => parseDeploymentsArgs(["--wat"], LIST_USAGE)).toThrow("unknown option --wat");
  expect(() => parseDeploymentsArgs(["--api-url"], LIST_USAGE)).toThrow("--api-url needs a value");
});

test("the live deployment is the ready build whose generation a host applied", () => {
  const live = parseLive({
    record_generation: 3,
    apply: { state: "applied", applied_generation: 3, error: null },
    spec: { hosts: ["h.example"] },
  });
  expect(live).toEqual({
    recordGeneration: 3,
    appliedGeneration: 3,
    state: "applied",
    error: null,
    hosts: ["h.example"],
  });
  const list = parseDeployments(
    {
      builds: [
        build({ id: "b3", record_generation: 3 }),
        build({ id: "b2", record_generation: 2 }),
        build({
          id: "bf",
          state: "failed",
          record_generation: null,
          error: { code: "compile_failed", message: "x\nunsupported syntax" },
        }),
      ],
    },
    live,
  );
  expect(list.map((d) => [d.id, d.live])).toEqual([
    ["b3", true],
    ["b2", false],
    ["bf", false],
  ]);
  expect(list[2]!.error).toBe("x\nunsupported syntax");
  // A generation that is written but not applied yet is not live.
  expect(parseDeployments({ builds: [build()] }, { ...live, state: "pending", appliedGeneration: 2 })[0]!.live).toBe(
    false,
  );
  expect(parseDeployments({ builds: [{ nonsense: true }] }, null)).toEqual([]);
});

test("a deployment prints its id, state, generation and hosts; a failure shows its first line", () => {
  const [ready, failed] = parseDeployments(
    {
      builds: [
        build(),
        build({
          id: "bf",
          state: "failed",
          record_generation: null,
          error: { code: "compile_failed", message: "first line\nsecond" },
          stats: null,
        }),
      ],
    },
    { recordGeneration: 3, appliedGeneration: 3, state: "applied", error: null, hosts: [] },
  );
  const text = formatDeployment(ready!);
  expect(text).toContain("b1");
  expect(text).toContain("live");
  expect(text).toContain("ready (built in 4.1 s)");
  expect(text).toContain("Generation:  3");
  expect(text).toContain("hello.acme.sproutboat.app");
  expect(formatDeployment(failed!)).toContain("Error:       first line");
  expect(formatDeployment(failed!)).not.toContain("second");
});

test("status says what is live, whether a host applied it, and what is not deployed", () => {
  const live = { recordGeneration: 4, appliedGeneration: 3, state: "pending", error: null, hosts: ["h.example"] };
  const text = formatStatus("hello", live, undefined);
  expect(text).toContain("Generation:   4");
  expect(text).toContain("Host apply:   pending");
  expect(formatStatus("hello", { ...live, appliedGeneration: 4, state: "applied" }, undefined)).toContain(
    "applied by a host",
  );
  expect(formatStatus("hello", { ...live, state: "failed", error: "module failed to load" }, undefined)).toContain(
    "failed (module failed to load)",
  );
  expect(formatStatus("hello", null, undefined)).toContain("hello is not deployed yet");
});

test("Community versions are parsed from the project's deployments", () => {
  expect(
    parseCommunityVersions([
      { id: "d1", artifact: "a".repeat(64), deployedAt: "2026-11-01", active: true },
      { id: "d2" },
    ]),
  ).toEqual([{ id: "d1", artifact: "a".repeat(64), deployedAt: "2026-11-01", active: true }]);
});

test("tail summaries for each end state", () => {
  const ready = parseBuildView({ id: "b", state: "ready", record_generation: 5 });
  expect(tailSummary(ready)).toContain("record generation 5");
  expect(tailSummary(parseBuildView({ id: "b", state: "failed", error: { message: "a\nb", code: "x" } }))).toContain(
    "failed: b",
  );
  expect(
    tailSummary(parseBuildView({ id: "b", state: "canceled", error: { message: "superseded", code: "superseded" } })),
  ).toContain("superseded");
});

test("the Cloud's rate limit and failed audit are explained", () => {
  expect(explainApiFailure(429, JSON.stringify({ error: "x", reason: "rate", retry_after: 4 }), false)).toContain(
    "try again in 4 s",
  );
  expect(explainApiFailure(503, JSON.stringify({ error: "x", reason: "audit-unavailable" }), false)).toContain(
    "audit log",
  );
});
