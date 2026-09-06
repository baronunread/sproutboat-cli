import { expect, test } from "bun:test";
import { missingSecretsMessage, resolveSecrets, resolveStorePaths } from "./standalone";

test("defaults to <name>.data in the working directory", () => {
  const paths = resolveStorePaths("hello", { cwd: "/srv/apps" });
  expect(paths.dataDir).toBe("/srv/apps/hello.data");
  expect(paths.storePath).toBe("/srv/apps/hello.data/store.sqlite");
  expect(paths.d1Dir).toBe("/srv/apps/hello.data/d1");
});

test("the flag wins over the environment, and both win over the default", () => {
  expect(resolveStorePaths("hello", { flag: "/var/lib/app", env: "/tmp/env", cwd: "/srv" }).dataDir).toBe(
    "/var/lib/app",
  );
  expect(resolveStorePaths("hello", { env: "/tmp/env", cwd: "/srv" }).dataDir).toBe("/tmp/env");
});

test("a relative override resolves against the working directory, not the app name", () => {
  expect(resolveStorePaths("hello", { flag: "state", cwd: "/srv/apps" }).dataDir).toBe("/srv/apps/state");
});

test("an empty override falls through instead of resolving to the working directory", () => {
  // An unset env var arrives as "" often enough that treating it as "here" would
  // scatter store.sqlite into whatever directory the app happened to start in.
  expect(resolveStorePaths("hello", { flag: "", env: "", cwd: "/srv/apps" }).dataDir).toBe("/srv/apps/hello.data");
});

test("D1 is a directory beside the store, never inside it", () => {
  // D1 runs user-supplied DDL: sharing a file with kv/mq/do_storage would let a
  // handler's CREATE TABLE collide with the platform's own tables.
  const paths = resolveStorePaths("hello", { cwd: "/srv" });
  expect(paths.d1Dir.startsWith(paths.dataDir)).toBe(true);
  expect(paths.d1Dir).not.toBe(paths.storePath);
});

test("secrets: the environment wins, the file fills the gaps", () => {
  const result = resolveSecrets(["A", "B"], { env: { A: "from-env" }, file: { A: "ignored", B: "from-file" } });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.values).toEqual({ A: "from-env", B: "from-file" });
    expect(result.sources).toEqual({ A: "env", B: "file" });
  }
});

test("secrets: an empty value counts as absent", () => {
  // `FOO=$UNSET` in a shell script arrives as "": starting with a silently
  // empty API key is worse than refusing to start.
  const result = resolveSecrets(["A"], { env: { A: "" }, file: {} });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.missing).toEqual(["A"]);
});

test("secrets: every missing name is reported at once, not one per restart", () => {
  const result = resolveSecrets(["A", "B", "C"], { env: { B: "x" }, file: {} });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.missing).toEqual(["A", "C"]);
    const message = missingSecretsMessage(result.missing, "/srv/hello.data");
    expect(message).toContain("A, C");
    expect(message).toContain("/srv/hello.data/secrets.json");
  }
});

test("secrets: a non-string in the file is not a value", () => {
  expect(resolveSecrets(["A"], { env: {}, file: { A: 42 } }).ok).toBe(false);
});

test("secrets: declaring none resolves trivially", () => {
  expect(resolveSecrets([], {})).toEqual({ ok: true, values: {}, sources: {} });
});
