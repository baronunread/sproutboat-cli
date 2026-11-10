import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudIo } from "./cloud";
import { jsonObject } from "./json";
import { buildAndDeploy, deployToCloud, SERVICE_BINDINGS_MIN_DATE, type BuildPlan } from "./cloud-deploy";
import { FAKE_KEY, fakeAppId, startFakeCloud, type FakeOptions } from "./cloud-fake";
import { deleteCloudSecret, listCloudSecrets, putCloudSecret, readSecretsFile } from "./cloud-secrets";

const io: CloudIo = {
  log: () => {},
  warn: () => {},
  interactive: false,
  openUrl: () => true,
  sleep: async () => {},
  choose: async (_q, choices) => choices[0]!,
};

let work: string;
let sourcePath: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "sb-secrets-"));
  sourcePath = join(work, "sprout.generated.js");
  await writeFile(sourcePath, "export default { fetch() { return new Response('hi'); } };\n");
  await writeFile(join(work, "app.so"), "module-bytes");
});
afterEach(() => rm(work, { recursive: true, force: true }));

async function withCloud(options: FakeOptions, run: (cloud: ReturnType<typeof startFakeCloud>) => Promise<void>) {
  const cloud = startFakeCloud(options);
  try {
    await run(cloud);
  } finally {
    cloud.stop();
  }
}

const creds = (apiUrl: string) => ({ apiUrl, token: FAKE_KEY, tokenFromEnv: false });
const plan = (apiUrl: string, extra: Partial<BuildPlan> = {}): BuildPlan => ({
  ...creds(apiUrl),
  project: "hello",
  hosts: ["hello.acme.sproutboat.app"],
  sourcePath,
  cli: { version: "9.9.9" },
  noWait: true,
  ...extra,
});
const nonGets = (cloud: ReturnType<typeof startFakeCloud>) => cloud.calls.filter((c) => c.method !== "GET");

describe("secrets on deploy", () => {
  test("the first deploy sends secrets_patch.set and never `secrets`", async () => {
    await withCloud({}, async (cloud) => {
      await buildAndDeploy(plan(cloud.url, { secrets: { ADMIN_TOKEN: "s3cret" }, noWait: false }), io);
      const sent = sentSpec(cloud);
      expect(sent.secrets_patch).toEqual({ set: { ADMIN_TOKEN: "s3cret" } });
      expect("secrets" in sent).toBe(false);
      expect(cloud.secrets).toEqual({ ADMIN_TOKEN: "s3cret" });
    });
  });

  test("a deploy without secrets keeps the existing ones", async () => {
    await withCloud({ appExists: true, existingSecrets: { ADMIN_TOKEN: "keep" } }, async (cloud) => {
      await buildAndDeploy(plan(cloud.url), io);
      const sent = sentSpec(cloud);
      expect("secrets" in sent).toBe(false);
      expect("secrets_patch" in sent).toBe(false);
      expect(cloud.secrets).toEqual({ ADMIN_TOKEN: "keep" });
    });
  });

  test("a module deploy merges the patch into the same PUT", async () => {
    await withCloud({ appExists: true, existingSecrets: { OLD: "1" } }, async (cloud) => {
      await deployToCloud(
        {
          ...creds(cloud.url),
          project: "hello",
          hosts: ["hello.acme.sproutboat.app"],
          modulePath: join(work, "app.so"),
          noWait: true,
          secrets: { NEW: "2" },
        },
        io,
      );
      expect(cloud.secrets).toEqual({ NEW: "2", OLD: "1" });
      expect(cloud.calls.filter((c) => c.method === "PUT" && c.path === "/v1/apps/hello")).toHaveLength(1);
    });
  });
});

describe("secrets commands against the Cloud", () => {
  test("put, list and delete by name", async () => {
    await withCloud({ appExists: true }, async (cloud) => {
      expect(await putCloudSecret(creds(cloud.url), "hello", "B_KEY", "b")).toBe(1);
      await putCloudSecret(creds(cloud.url), "hello", "A_KEY", "a");
      expect(await listCloudSecrets(creds(cloud.url), "hello")).toEqual(["A_KEY", "B_KEY"]);
      await deleteCloudSecret(creds(cloud.url), "hello", "A_KEY");
      expect(await listCloudSecrets(creds(cloud.url), "hello")).toEqual(["B_KEY"]);
      expect(cloud.calls.find((c) => c.path === "/v1/apps/hello/secrets/B_KEY")!.body).toBe('{"value":"b"}');
    });
  });

  test("an app that is not deployed says to deploy first", async () => {
    await withCloud({}, async (cloud) => {
      const error = await putCloudSecret(creds(cloud.url), "hello", "A_KEY", "a").catch((e: Error) => e.message);
      expect(error).toContain("hello is not deployed yet");
      expect(error).toContain("sproutboat deploy");
      expect(error).toContain("--secrets-file");
      await expect(listCloudSecrets(creds(cloud.url), "hello")).rejects.toThrow("not deployed yet");
    });
  });

  test("deleting a secret the app does not have is its own message", async () => {
    await withCloud({ appExists: true }, async (cloud) => {
      await expect(deleteCloudSecret(creds(cloud.url), "hello", "NOPE")).rejects.toThrow(
        "hello has no secret named NOPE",
      );
    });
  });

  test("a 403 names the missing permission", async () => {
    await withCloud({ appExists: true, denyPermissions: ["secret:write", "secret:list"] }, async (cloud) => {
      await expect(putCloudSecret(creds(cloud.url), "hello", "A_KEY", "a")).rejects.toThrow("secret:write");
      await expect(deleteCloudSecret(creds(cloud.url), "hello", "A_KEY")).rejects.toThrow("secret:write");
      await expect(listCloudSecrets(creds(cloud.url), "hello")).rejects.toThrow("secret:list");
    });
  });

  test("a deploy with secrets but no secret:write permission fails the write", async () => {
    await withCloud({ denyPermissions: ["secret:write"] }, async (cloud) => {
      await expect(buildAndDeploy(plan(cloud.url, { secrets: { A_KEY: "a" } }), io)).rejects.toThrow("secret:write");
    });
  });
});

describe("--secrets-file", () => {
  test("reads a .dev.vars file, rejects bad names, skips empty values", async () => {
    const file = join(work, "prod.vars");
    await writeFile(file, "ADMIN_TOKEN=abc\n# note\nEMPTY=\nexport API_KEY='x y'\n");
    const read = await readSecretsFile(file);
    expect(read.values).toEqual({ ADMIN_TOKEN: "abc", API_KEY: "x y" });
    expect(read.warnings.join("\n")).toContain("EMPTY");
    await writeFile(file, "lower=1\nFINE=2\n");
    await expect(readSecretsFile(file)).rejects.toThrow("not valid: lower");
    await expect(readSecretsFile(join(work, "missing"))).rejects.toThrow("env file not found");
  });
});

describe("service bindings", () => {
  const services = [{ binding: "PEER", service: "quote-service" }];
  const date = SERVICE_BINDINGS_MIN_DATE;

  test("resolves the callee to the team's app id and sends bindings and services", async () => {
    await withCloud({ otherApps: ["quote-service"] }, async (cloud) => {
      await buildAndDeploy(plan(cloud.url, { services, compatibilityDate: date, noWait: false }), io);
      expect(cloud.buildRequests[0]!.spec).toMatchObject({
        bindings: [{ name: "PEER", kind: "service", resource_id: null, config: {} }],
        services: { PEER: fakeAppId("quote-service") },
      });
      expect(cloud.spec.services).toEqual({ PEER: fakeAppId("quote-service") });
    });
  });

  test("a module deploy sends them in the PUT", async () => {
    await withCloud({ otherApps: ["quote-service"] }, async (cloud) => {
      await deployToCloud(
        {
          ...creds(cloud.url),
          project: "hello",
          hosts: ["hello.acme.sproutboat.app"],
          modulePath: join(work, "app.so"),
          noWait: true,
          services,
          compatibilityDate: "2027-01-01",
        },
        io,
      );
      expect(cloud.spec.services).toEqual({ PEER: fakeAppId("quote-service") });
    });
  });

  test("a callee that is not deployed fails before anything is uploaded or written", async () => {
    await withCloud({}, async (cloud) => {
      const error = await buildAndDeploy(plan(cloud.url, { services, compatibilityDate: date }), io).catch(
        (e: Error) => e.message,
      );
      expect(error).toContain("PEER");
      expect(error).toContain('"quote-service"');
      expect(error).toContain("deploy it first");
      expect(error).toContain("sproutboat deploy");
      expect(nonGets(cloud)).toEqual([]);
    });
  });

  test("a binding to the app itself is refused before any call", async () => {
    await withCloud({}, async (cloud) => {
      await expect(
        buildAndDeploy(
          plan(cloud.url, { services: [{ binding: "ME", service: "hello" }], compatibilityDate: date }),
          io,
        ),
      ).rejects.toThrow("cannot bind itself");
      expect(cloud.calls).toEqual([]);
    });
  });

  test("an older compatibility date is refused before any call", async () => {
    await withCloud({ otherApps: ["quote-service"] }, async (cloud) => {
      for (const compatibilityDate of ["2026-11-17", undefined]) {
        await expect(buildAndDeploy(plan(cloud.url, { services, compatibilityDate }), io)).rejects.toThrow(
          `set compatibility_date to ${date} or later`,
        );
      }
      expect(cloud.calls).toEqual([]);
    });
  });

  test("an app without service bindings sends none and needs no date", async () => {
    await withCloud({}, async (cloud) => {
      await buildAndDeploy(plan(cloud.url, { services: [], compatibilityDate: "2026-08-26" }), io);
      const sent = sentSpec(cloud);
      expect("bindings" in sent || "services" in sent).toBe(false);
    });
  });
});

describe("the CLI end to end", () => {
  const main = join(import.meta.dir, "main.ts");
  let config: string;
  let project: string;
  const run = async (args: string[], env: Record<string, string>, stdin = "") => {
    const child = Bun.spawn([process.execPath, main, ...args], {
      env: {
        ...process.env,
        SPROUTBOAT_CONFIG_DIR: config,
        SPROUTBOAT_NO_UPDATE_CHECK: "1",
        SPROUTBOAT_API_TOKEN: "",
        SPROUTBOAT_TOKEN: "",
        ...env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(stdin);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const writeConfig = (extra: string) =>
    writeFile(
      join(project, "sproutboat.jsonc"),
      `{ "name": "hello", "main": "src/index.js", ${extra} "account": "acme" }`,
    );
  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), "sb-cfg-"));
    project = await mkdtemp(join(tmpdir(), "sb-proj-"));
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "index.js"), "export default { fetch() { return new Response('hi'); } };\n");
    await writeConfig(`"compatibility_date": "2026-09-07",`);
  });
  afterEach(async () => {
    await rm(config, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  const env = (url: string) => ({ SPROUTBOAT_API_URL: url, SPROUTBOAT_API_TOKEN: FAKE_KEY });

  test("secrets put, list and delete work against a deployed Cloud app", async () => {
    await withCloud({ appExists: true, teamKey: true }, async (cloud) => {
      const put = await run(["secrets", "put", "ADMIN_TOKEN", project], env(cloud.url), "hunter2\n");
      expect(put.stderr).toBe("");
      expect(put.code).toBe(0);
      expect(put.stdout).toContain("set ADMIN_TOKEN on hello");
      expect(cloud.secrets).toEqual({ ADMIN_TOKEN: "hunter2" });
      const list = await run(["secrets", "list", project], env(cloud.url));
      expect(list.stdout.trim()).toBe("ADMIN_TOKEN");
      const del = await run(["secrets", "delete", "ADMIN_TOKEN", project], env(cloud.url));
      expect(del.code).toBe(0);
      expect(cloud.secrets).toEqual({});
    });
  });

  test("secrets put on an app that is not deployed exits 1 and says to deploy first", async () => {
    await withCloud({ teamKey: true }, async (cloud) => {
      const out = await run(["secrets", "put", "ADMIN_TOKEN", "--value", "x", project], env(cloud.url));
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("deploy");
      expect(out.stderr).toContain("--secrets-file");
    });
  });

  test("secrets list without secret:list exits 1 naming the permission", async () => {
    await withCloud({ appExists: true, denyPermissions: ["secret:list"] }, async (cloud) => {
      const out = await run(["secrets", "list", project], env(cloud.url));
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("secret:list");
    });
  });

  test("deploy --secrets-file sends the file's values in the first deploy, never .dev.vars on its own", async () => {
    await writeFile(join(project, ".dev.vars"), "LOCAL_ONLY=1\n");
    await writeFile(join(project, "prod.vars"), "ADMIN_TOKEN=abc\n");
    await withCloud({ teamKey: true }, async (cloud) => {
      const plain = await run(["deploy", project], env(cloud.url));
      expect(plain.code).toBe(0);
      expect(cloud.secrets).toEqual({});
      const out = await run(["deploy", project, "--secrets-file", join(project, "prod.vars")], env(cloud.url));
      expect(out.stderr).toBe("");
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("secrets   1 from");
      expect(cloud.secrets).toEqual({ ADMIN_TOKEN: "abc" });
    });
  });

  test("deploy with service bindings on an older date exits 1 before any call, even with --dry-run", async () => {
    await writeConfig(
      `"compatibility_date": "2026-09-07", "services": [{ "binding": "PEER", "service": "quote-service" }],`,
    );
    await withCloud({ teamKey: true, otherApps: ["quote-service"] }, async (cloud) => {
      for (const args of [
        ["deploy", project],
        ["deploy", project, "--dry-run"],
      ]) {
        const out = await run(args, env(cloud.url));
        expect(out.code).toBe(1);
        expect(out.stderr).toContain("set compatibility_date to 2026-11-18 or later");
      }
      expect(nonGets(cloud)).toEqual([]);
    });
  });

  test("deploy with a service binding to an undeployed app exits 1 naming it", async () => {
    await writeConfig(
      `"compatibility_date": "2026-11-18", "services": [{ "binding": "PEER", "service": "quote-service" }],`,
    );
    await withCloud({ teamKey: true }, async (cloud) => {
      const out = await run(["deploy", project], env(cloud.url));
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('"quote-service"');
      expect(nonGets(cloud)).toEqual([]);
    });
  });

  test("deploy with a resolvable service binding sends it", async () => {
    await writeConfig(
      `"compatibility_date": "2026-11-18", "services": [{ "binding": "PEER", "service": "quote-service" }],`,
    );
    await withCloud({ teamKey: true, otherApps: ["quote-service"] }, async (cloud) => {
      const out = await run(["deploy", project], env(cloud.url));
      expect(out.stderr).toBe("");
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("services  PEER -> quote-service");
      expect(cloud.spec.services).toEqual({ PEER: fakeAppId("quote-service") });
    });
  });
});

function sentSpec(cloud: ReturnType<typeof startFakeCloud>) {
  return jsonObject(cloud.buildRequests[0]?.spec ?? null) ?? {};
}
