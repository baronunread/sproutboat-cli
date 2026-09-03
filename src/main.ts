#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isBoolean, isSafeInteger, isString, jsonObject, parseJsonValue, type JsonObject } from "./json";
import type { AssetFiles } from "./assets";
import { parseConfig, pinBindingId, resourceRefs, type SproutboatConfig } from "./config";
import { validateHttpSyncSource } from "./source";
import { buildArtifact } from "./build";
import { bundleHandler, BundleError, type BundleResult } from "./bundle";
import { hostTarget, validateManifest, type ArtifactManifest } from "./manifest";
import { CLI_VERSION, printDeployReport } from "./report";
import { activeApiUrl, forgetToken, savedToken, saveToken } from "./credentials";
import { helpText, STORAGE_PRODUCTS, STORAGE_VERBS, type StorageProduct } from "./surface";
import { notifyIfOutdated } from "./update-check";
import { amber, bold, dim, leaf, ok, rose } from "./style";

const defaultApiUrl = "https://dashboard.sproutboat.com";

async function responseText(response: Response, failure: string): Promise<string> {
  if (response.ok) return response.text();
  fail(`${failure} (${response.status}): ${await response.text()}`);
}

type VersionSummary = { id: string; artifact: string; deployedAt: string; active: boolean };
type CliAuthorization = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresAt: string };

function parseVersionList(source: string): VersionSummary[] | undefined {
  const value = parseJsonValue(source);
  if (!Array.isArray(value)) return undefined;
  const deployments: VersionSummary[] = [];
  for (const item of value) {
    const record = jsonObject(item);
    if (!record || !isString(record.id) || !isString(record.artifact) || !isString(record.deployedAt) || (record.active !== true && record.active !== false)) return undefined;
    deployments.push({ id: record.id, artifact: record.artifact, deployedAt: record.deployedAt, active: record.active });
  }
  return deployments;
}

function parseUrlResponse(source: string): { url: string; id?: string; artifact?: string; unchanged: boolean } | undefined {
  const record = jsonObject(parseJsonValue(source));
  if (!record || !isString(record.url)) return undefined;
  return {
    url: record.url,
    id: isString(record.id) ? record.id : undefined,
    artifact: isString(record.artifact) ? record.artifact : undefined,
    unchanged: record.unchanged === true,
  };
}

/** #55: `{ from, to }` when this deploy moves the live version onto a different
 *  Porffor pin. Deployed artifacts are frozen at their build-time compiler, so
 *  the pin only changes by redeploying — and the alpha compiler's output can
 *  differ between pins. */
function parsePorfforDrift(source: string): { from: string; to: string } | undefined {
  const drift = (() => { try { return jsonObject(parseJsonValue(source))?.porfforDrift; } catch { return undefined; } })();
  const record = drift && jsonObject(drift);
  return record && isString(record.from) && isString(record.to) ? { from: record.from, to: record.to } : undefined;
}

function parseAuthorization(source: string): CliAuthorization | undefined {
  const record = jsonObject(parseJsonValue(source));
  if (!record || !isString(record.deviceCode) || !isString(record.userCode) || !isString(record.verificationUri) || !isSafeInteger(record.interval) || !isString(record.expiresAt)) return undefined;
  return { deviceCode: record.deviceCode, userCode: record.userCode, verificationUri: record.verificationUri, interval: record.interval, expiresAt: record.expiresAt };
}

function parseToken(source: string): string | undefined {
  const record = jsonObject(parseJsonValue(source));
  return record && isString(record.token) ? record.token : undefined;
}

const starterConfig = (name: string) => `{
  "$schema": "https://sproutboat.com/schema.json",
  "name": "${name}",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26"
}
`;
const starterHandler = `export default {
  fetch() {
    return new Response("hello from Sproutboat");
  }
};
`;

/** An operational failure — the command was invoked correctly but could not complete. Exit 1. */
function fail(message: string): never {
  console.error(`${rose("✗")} ${message}`);
  process.exit(1);
}

/**
 * The command was invoked wrong (missing/unknown arg). Exit 2, the getopt/argparse
 * convention, so scripts can tell "you typed it wrong" apart from "it broke".
 * `usage` is the grammar line without the `usage: ` prefix.
 */
function usageError(what: string, usage: string): never {
  console.error(`${rose("✗")} ${what}\n  ${dim(`usage: sproutboat ${usage}`)}`);
  process.exit(2);
}

async function readProject(directory = process.cwd()) {
  const projectDirectory = resolve(directory);
  const configPath = resolve(projectDirectory, "sproutboat.jsonc");
  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf8");
  } catch {
    fail(`no sproutboat.jsonc found in ${projectDirectory}`);
  }
  const parsed = parseConfig(configSource);
  if (!parsed.ok) fail(parsed.errors.join("\n"));
  const sourcePath = resolve(projectDirectory, parsed.value.main);
  let source: string;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch {
    fail(`entry point not found: ${parsed.value.main}`);
  }
  // #89 — resolve imports first, then hold the *bundled* module to the
  // capability rules. Validating the entry file instead would let a dependency
  // smuggle in a Node API the handler is not allowed to touch.
  let bundle: BundleResult;
  try {
    bundle = await bundleHandler(sourcePath, projectDirectory);
  } catch (cause) {
    fail(cause instanceof BundleError ? cause.message : String(cause));
  }
  const supported = validateHttpSyncSource(bundle.code, (parsed.value.outbound ?? []).length > 0);
  if (!supported.ok) fail(supported.errors.join("\n"));
  return { directory: projectDirectory, config: parsed.value, sourcePath, source, bundle };
}

async function init(name = "hello") {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(name)) fail("project name must be a 3–32 character lowercase slug");
  const directory = resolve(process.cwd(), name);
  const configPath = resolve(directory, "sproutboat.jsonc");
  if (await Bun.file(configPath).exists()) fail(`${basename(directory)} already contains sproutboat.jsonc`);
  await mkdir(resolve(directory, "src"), { recursive: true });
  await writeFile(configPath, starterConfig(name), { flag: "wx" });
  await writeFile(resolve(directory, "src/index.js"), starterHandler, { flag: "wx" });
  console.log(`Created ${basename(directory)}/sproutboat.jsonc`);
  console.log(`Created ${basename(directory)}/src/index.js`);
}

async function check(directory?: string) {
  const project = await readProject(directory);
  console.log(ok(`check passed — ${project.config.name} (${project.config.main}, native-fetch)`));
}

async function build(directory?: string, target: "linux-x86_64" | "host" = "linux-x86_64") {
  const project = await readProject(directory);
  console.log(target === "host"
    ? dim(`Compiling the native-fetch server with Porffor for this machine (${hostTarget()}, local only)…`)
    : dim("Compiling the native-fetch server with Porffor + Zig (linux-x86_64, static)…"));
  const artifact = await buildArtifact({ projectDir: project.directory, config: project.config, sourcePath: project.sourcePath, source: project.bundle.code, target });
  console.log(ok(`built ${project.config.name}`));
  if (target === "host") console.log(dim("  host build — runs here, not deployable; drop --target host to build for a box"));
  console.log(artifact.artifactDir);
  return { project, artifact };
}

const PROVISION_FIELDS = [
  ["kv_namespaces", "kv"],
  ["d1_databases", "d1"],
  ["r2_buckets", "r2"],
  ["queues", "queue"],
] as const;

/**
 * #74 auto-provisioning, wrangler-style. A bare-string KV/D1/R2/queue binding
 * with no id gets an account-level resource created (`<project>-<binding>`) on
 * deploy, and the id is written back into `sproutboat.jsonc`. `--no-provision`
 * skips this — those bindings then get an ephemeral deploy-scoped store.
 */
async function provisionBindings(directory = process.cwd()): Promise<void> {
  const configPath = resolve(directory, "sproutboat.jsonc");
  let source = await readFile(configPath, "utf8");
  const parsed = parseConfig(source);
  if (!parsed.ok) return; // build() re-reads and reports the config error

  const bare: Array<{ field: string; kind: string; binding: string }> = [];
  for (const [field, kind] of PROVISION_FIELDS) {
    for (const ref of resourceRefs(parsed.value[field])) {
      if (!ref.id) bare.push({ field, kind, binding: ref.binding });
    }
  }
  if (bare.length === 0) return;

  const { apiUrl, token } = await apiCredentials();
  for (const { field, kind, binding } of bare) {
    const name = `${parsed.value.name}-${binding.toLowerCase().replace(/_/g, "-")}`;
    const body = await responseText(
      await fetch(`${apiUrl}/api/resources`, {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ kind, name, ifExists: "return" }),
      }),
      `could not provision a ${kind} resource for env.${binding}`,
    );
    const record = jsonObject(jsonObject(parseJsonValue(body))?.resource ?? null);
    if (!record || !isString(record.id)) fail(`provision response for env.${binding} was not a resource`);
    source = pinBindingId(source, field, binding, record.id);
    console.log(ok(`provisioned ${kind} ${bold(name)} → ${record.id}`));
  }
  await writeFile(configPath, source);
}

/** #79 — wrangler parity: drop the stored credential for an endpoint. */
async function logout(args: string[]) {
  const { apiUrl } = parseLoginArgs(args);
  console.log(await forgetToken(apiUrl)
    ? ok(`forgot the credential for ${apiUrl}`)
    : `no stored credential for ${apiUrl}`);
}

/**
 * #79 — wrangler parity: which endpoint, and who the stored token belongs to.
 * The account comes from the control plane, so this also proves the token still
 * works rather than only reporting what is on disk.
 */
async function whoami() {
  const apiUrl = process.env.SPROUTBOAT_API_URL || await activeApiUrl();
  if (!apiUrl) { console.log("not logged in — run `sproutboat login`"); return; }
  const token = process.env.SPROUTBOAT_TOKEN || await savedToken(apiUrl);
  console.log(`endpoint  ${apiUrl}`);
  if (!token) { console.log(`account   ${dim("no stored token — run `sproutboat login`")}`); return; }

  const response = await fetch(`${apiUrl}/api/account`, { headers: { "x-api-key": token } });
  if (!response.ok) {
    console.log(`account   ${rose(response.status === 401 ? "token rejected — run `sproutboat login`" : `control plane said ${response.status}`)}`);
    return;
  }
  const account = jsonObject(parseJsonValue(await response.text()));
  const profile = jsonObject(account?.profile ?? null);
  const user = jsonObject(account?.user ?? null);
  console.log(`account   ${isString(profile?.username) ? profile.username : "(no namespace reserved)"}`);
  if (user && isString(user.email)) console.log(`email     ${user.email}`);
}

async function deploy(args: string[]) {
  const artifactIndex = args.indexOf("--artifact");
  const dryRun = args.includes("--dry-run");
  const directory = args.find((arg, index) => !arg.startsWith("--") && index !== artifactIndex + 1);
  let projectName: string;
  let artifactDir: string;
  let config: SproutboatConfig | undefined;
  if (artifactIndex >= 0) {
    artifactDir = args[artifactIndex + 1]
      ? resolve(args[artifactIndex + 1])
      : usageError("deploy: --artifact needs a directory", "deploy [project-dir] [--dry-run] [--artifact <dir>] [--no-wait]");
    projectName = "";
  } else {
    // wrangler-style: create resources for id-less bindings and pin the ids
    // back into sproutboat.jsonc before the build bakes them into the artifact.
    if (!args.includes("--no-provision") && !dryRun) await provisionBindings(directory);
    const built = await build(directory);
    projectName = built.project.config.name;
    artifactDir = built.artifact.artifactDir;
    config = built.project.config;
  }
  const manifest = Bun.file(resolve(artifactDir, "manifest.json"));
  const sprout = Bun.file(resolve(artifactDir, "sprout"));
  if (!(await manifest.exists()) || !(await sprout.exists())) fail("artifact must contain manifest.json and sprout");
  const manifestValidation = validateManifest(await manifest.json());
  if (!manifestValidation.ok) fail(`invalid artifact manifest: ${manifestValidation.errors.join(", ")}`);
  const artifactManifest: ArtifactManifest = manifestValidation.value;
  if (artifactIndex >= 0) projectName = artifactManifest.project;

  printDeployReport(
    config ?? { name: projectName, main: "", compatibility_date: "(prebuilt artifact)" },
    artifactManifest,
    new Uint8Array(await sprout.arrayBuffer()),
    manifest.size,
  );
  if (dryRun) {
    console.log("\n--dry-run: not uploading.");
    return;
  }
  const { apiUrl, token } = await apiCredentials();
  const form = new FormData();
  form.set("manifest", new File([await manifest.arrayBuffer()], "manifest.json", { type: "application/json" }));
  form.set("sprout", new File([await sprout.arrayBuffer()], "sprout", { type: "application/octet-stream" }));

  // #1 — ship the sidecars `sproutboat build` produced so the server can start
  // the binding broker and serve static assets. Without bindings.json the broker
  // never spawns and every KV/D1/R2/secret/queue/cron/DO call is dead on the box.
  const bindingsFile = Bun.file(resolve(artifactDir, "bindings.json"));
  if (await bindingsFile.exists()) {
    form.set("bindings", new File([await bindingsFile.arrayBuffer()], "bindings.json", { type: "application/json" }));
  }
  const assetsManifestFile = Bun.file(resolve(artifactDir, "assets.json"));
  if (await assetsManifestFile.exists()) {
    // assets.json is written by `sproutboat build` from the AssetManifest contract.
    const assetsManifest: { files?: AssetFiles } = await assetsManifestFile.json();
    form.set("assets_manifest", new File([await assetsManifestFile.arrayBuffer()], "assets.json", { type: "application/json" }));
    for (const key of Object.keys(assetsManifest.files ?? {})) {
      const file = Bun.file(resolve(artifactDir, "assets", `.${key}`));
      if (!(await file.exists())) fail(`assets.json lists ${key} but assets${key} is missing — rebuild`);
      form.append("asset", new File([await file.arrayBuffer()], key));
    }
  }

  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/projects/${projectName}/deployments`, {
    method: "POST",
    headers: { "x-api-key": token },
    body: form,
  });
  const body = await responseText(response, "deployment rejected");
  const deployed = parseUrlResponse(body);
  if (!deployed) fail("deployment response did not include a URL");
  if (deployed.unchanged) {
    console.log(ok(`nothing to deploy — ${projectName} is already serving this exact artifact`));
    console.log(`  ${deployed.url}`);
    return;
  }
  console.log(`\n${leaf("🌱")} ${bold(leaf(`Deployed ${projectName}`))}`);
  console.log(`  ${bold(deployed.url)}`);
  if (deployed.id) console.log(dim(`  version ${deployed.id}${deployed.artifact ? `  ·  artifact ${deployed.artifact.slice(0, 12)}` : ""}`));
  for (const cron of config?.triggers?.crons ?? []) console.log(dim(`  schedule ${cron}`));
  const drift = parsePorfforDrift(body);
  if (drift) {
    console.warn(amber(`\n! Porffor pin changed: ${drift.from} -> ${drift.to}`));
    console.warn(dim(`  The previous live version stays frozen at ${drift.from}; this one is built with ${drift.to}.`));
    console.warn(dim(`  The alpha compiler's output can differ between pins (see COMPAT.md) — roll back if this version misbehaves.`));
  }
  // Verify the edge actually answers (cert issuance + sprout boot). Say nothing
  // on success — "Deployed" already implied that; only speak up if it doesn't.
  if (!args.includes("--no-wait") && !(await waitForHealthy(deployed.url, 90_000))) {
    console.warn(amber("  ! not serving after 90s — Caddy may still be issuing the cert, or the sprout is crashing (`sproutboat tail`)"));
  }
}

/**
 * Poll the deployment URL until the edge returns any non-5xx response. Connection
 * and TLS errors (the cert is issued on the first HTTPS request) count as "not
 * ready yet". Returns false on timeout without failing the deploy — the artifact
 * is already active server-side.
 */
async function waitForHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wait = 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "manual" });
      if (response.status < 500) return true;
    } catch { /* DNS / TLS-not-yet-issued / connection refused — keep waiting */ }
    await Bun.sleep(Math.min(wait, Math.max(0, deadline - Date.now())));
    if (wait < 5000) wait += 1000;
  }
  return false;
}

function parseLoginArgs(args: string[]) {
  let apiUrl = process.env.SPROUTBOAT_API_URL || defaultApiUrl;
  let token: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] === "--api-url" && value) apiUrl = value;
    else if (args[index] === "--token" && value) token = value;
    else usageError(`login: unexpected argument "${args[index]}"`, "login [--api-url <url>] [--token <token>]");
  }
  return { apiUrl: apiUrl.replace(/\/$/, ""), token };
}

async function login(args: string[]) {
  const { apiUrl, token: directToken } = parseLoginArgs(args);
  // Self-hosted / non-interactive: skip the browser flow and store the token
  // the admin already holds (e.g. SPROUTBOAT_BOOTSTRAP_TOKEN).
  if (directToken) {
    await saveToken(apiUrl, directToken);
    console.log(`Saved credentials for ${apiUrl}.`);
    return;
  }
  const response = await fetch(`${apiUrl}/api/cli/authorizations`, { method: "POST" });
  const body = await responseText(response, "could not start login");
  const authorization = parseAuthorization(body);
  if (!authorization) fail("login response did not include a valid authorization request");
  const verificationUrl = new URL(authorization.verificationUri, `${apiUrl}/`).toString();
  const openCommand = process.platform === "darwin" ? ["open", verificationUrl] : process.platform === "win32" ? ["cmd", "/c", "start", "", verificationUrl] : ["xdg-open", verificationUrl];
  try { Bun.spawn(openCommand, { stdout: "ignore", stderr: "ignore" }); }
  catch { console.log(`Open ${verificationUrl}`); }
  console.log("Opening the browser to approve this CLI login.");
  console.log(`Confirm code: ${authorization.userCode}`);
  while (new Date(authorization.expiresAt).getTime() > Date.now()) {
    await Bun.sleep(Math.max(authorization.interval, 1) * 1000);
    const exchange = await fetch(`${apiUrl.replace(/\/$/, "")}/api/cli/authorizations/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: authorization.deviceCode }),
    });
    if (exchange.status === 428) continue;
    const result = await exchange.text();
    if (!exchange.ok) fail(`login failed (${exchange.status}): ${result}`);
    const token = parseToken(result);
    if (!token) fail("login response did not include a CLI token");
    await saveToken(apiUrl, token);
    console.log(ok("login approved — credentials saved for this endpoint"));
    return;
  }
  fail("login expired before approval");
}

async function apiCredentials() {
  const apiUrl = (process.env.SPROUTBOAT_API_URL || await activeApiUrl() || defaultApiUrl).replace(/\/$/, "");
  const token = process.env.SPROUTBOAT_TOKEN || await savedToken(apiUrl);
  if (!token) fail("not logged in; run sproutboat login or set SPROUTBOAT_TOKEN for this command");
  return { apiUrl, token };
}

async function versions(args: string[]) {
  const sub = args[0];
  if (sub !== "list" && sub !== "view") {
    usageError(sub ? `versions: unknown subcommand "${sub}"` : "versions: missing subcommand", "versions <list | view <version-id>> [project-dir]");
  }
  args.shift();

  if (sub === "view") {
    const id = args.shift();
    if (!id) usageError("versions view: missing <version-id>", "versions view <version-id> [project-dir]");
    const [project, { apiUrl, token }] = await Promise.all([readProject(args[0]), apiCredentials()]);
    const body = await responseText(
      await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments/${encodeURIComponent(id)}`, { headers: { "x-api-key": token } }),
      "could not read that version",
    );
    const detail = jsonObject(parseJsonValue(body));
    if (!detail) fail("could not parse version response");
    const manifest = jsonObject(detail.manifest ?? null);
    console.log(`${bold(String(detail.id))} ${detail.active ? ok("active") : dim("superseded")}`);
    console.log(`  route     ${String(detail.hostname)}`);
    console.log(`  artifact  ${String(detail.artifact)}`);
    console.log(`  deployed  ${String(detail.deployedAt)}${isString(detail.deployedBy) ? ` by ${detail.deployedBy}` : ""}`);
    if (manifest) {
      console.log(`  built     ${String(manifest.builtAt)} · porffor ${String(manifest.porfforVersion)} · ${String(manifest.binarySize)} bytes`);
    } else if (isString(detail.manifestError)) {
      console.log(`  ! manifest unavailable: ${detail.manifestError}`);
    }
    const resources = Array.isArray(detail.resources) ? detail.resources.map((entry) => jsonObject(entry)) : [];
    for (const resource of resources) {
      if (resource) console.log(`  bound     ${String(resource.kind)} ${String(resource.name)} ${dim(String(resource.id))}`);
    }
    return;
  }

  const [project, { apiUrl, token }] = await Promise.all([readProject(args[0]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments`, { headers: { "x-api-key": token } });
  const deployments = parseVersionList(await responseText(response, "could not list versions"));
  if (!deployments) fail("could not parse versions response");
  for (const deployment of deployments) console.log(`${deployment.active ? "*" : " "} ${deployment.id} ${deployment.artifact.slice(0, 12)} ${deployment.deployedAt}`);
}

async function rollback(args: string[]) {
  const id = args[0];
  if (!id) usageError("rollback: missing <version-id>", "rollback <version-id> [project-dir]");
  const [project, { apiUrl, token }] = await Promise.all([readProject(args[1]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments/${id}/activate`, { method: "POST", headers: { "x-api-key": token } });
  const deployment = parseUrlResponse(await responseText(response, "rollback rejected"));
  if (!deployment) fail("rollback response did not include a URL");
  console.log(ok(`rolled back ${project.config.name}`));
  console.log(deployment.url);
}

async function tail(args: string[]) {
  const sproutLog = args.includes("--sprout");
  const dir = args.find((arg) => !arg.startsWith("-"));
  const [project, { apiUrl, token }] = await Promise.all([readProject(dir), apiCredentials()]);
  const path = sproutLog ? "logs/sprout" : "logs/recent";
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/${path}`, { headers: { "x-api-key": token } });
  process.stdout.write(await responseText(response, "could not read logs"));
}

type DomainView = {
  hostname: string;
  verified: boolean;
  verification: { type: string; name: string; value: string } | null;
  serverAddresses: string[];
  warning?: string;
};
function parseDomain(source: string): DomainView | undefined {
  const record = jsonObject(parseJsonValue(source));
  if (!record || !isString(record.hostname) || !isBoolean(record.verified)) return undefined;
  const v = jsonObject(record.verification ?? null);
  const verification = v && isString(v.type) && isString(v.name) && isString(v.value) ? { type: v.type, name: v.name, value: v.value } : null;
  const serverAddresses = Array.isArray(record.serverAddresses) ? record.serverAddresses.filter(isString) : [];
  return { hostname: record.hostname, verified: record.verified, verification, serverAddresses, warning: isString(record.warning) ? record.warning : undefined };
}
function printDomain(domain: DomainView) {
  const status = domain.verified ? "verified" : "unverified";
  console.log(`${status.padEnd(10)} ${domain.hostname}`);
  if (domain.verification) {
    console.log("  add these DNS records, then run: sproutboat domains verify " + domain.hostname);
    console.log(`  ${domain.verification.type}  ${domain.verification.name}  "${domain.verification.value}"`);
    if (domain.serverAddresses[0]) {
      console.log(`  A    ${domain.hostname}  ${domain.serverAddresses[0]}   (point the hostname here, DNS-only / not proxied)`);
    }
  }
  if (domain.warning) console.log(amber(`  ! ${domain.warning}`));
}

async function domains(args: string[]) {
  const sub = args[0] && !args[0].startsWith("-") && ["list", "add", "verify", "delete"].includes(args[0]) ? args.shift()! : "list";
  const host = sub === "list" ? undefined : args.shift();
  if (sub !== "list" && !host) usageError(`domains ${sub}: missing <hostname>`, `domains ${sub} <hostname> [project-dir]`);
  const [project, { apiUrl, token }] = await Promise.all([readProject(args[0]), apiCredentials()]);
  const base = `${apiUrl}/api/projects/${project.config.name}/domains`;
  const auth = { "x-api-key": token };

  if (sub === "list") {
    const response = await fetch(base, { headers: auth });
    const body = await responseText(response, "could not list domains");
    const list = parseJsonValue(body);
    if (!Array.isArray(list)) fail("could not parse domains response");
    if (list.length === 0) { console.log("no custom domains"); return; }
    for (const entry of list) { const d = parseDomain(JSON.stringify(entry)); if (d) printDomain(d); }
    return;
  }
  if (sub === "delete") {
    const response = await fetch(`${base}/${host}`, { method: "DELETE", headers: auth });
    await responseText(response, "delete rejected");
    console.log(ok(`removed ${host}`));
    return;
  }
  const url = sub === "add" ? base : `${base}/${host}/verify`;
  const init = sub === "add"
    ? { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ hostname: host }) }
    : { method: "POST", headers: auth };
  const response = await fetch(url, init);
  const domain = parseDomain(await responseText(response, `${sub} rejected`));
  if (!domain) fail(`${sub} response was not a domain record`);
  printDomain(domain);
}

async function secrets(args: string[]) {
  const sub = args[0] && ["list", "put", "delete"].includes(args[0]) ? args.shift()! : "list";

  // `--value` is opt-in; without it the value comes from stdin, so a secret does
  // not land in shell history. It is also what disambiguates the positionals:
  // `secrets put NAME <value> [project-dir]` could not tell a value from a path,
  // and read the value as the project directory.
  let inlineValue: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--value") inlineValue = args[(index += 1)];
    else positional.push(args[index]);
  }

  const name = sub === "list" ? undefined : positional.shift();
  if (sub !== "list" && !name) usageError(`secrets ${sub}: missing <NAME>`, `secrets ${sub} <NAME> [project-dir]`);
  if (name && !/^[A-Z][A-Z0-9_]*$/.test(name)) fail("secret name must be UPPER_SNAKE_CASE");
  const [project, { apiUrl, token }] = await Promise.all([readProject(positional[0]), apiCredentials()]);
  const base = `${apiUrl}/api/projects/${project.config.name}/secrets`;
  const auth = { "x-api-key": token };

  if (sub === "list") {
    const body = await responseText(await fetch(base, { headers: auth }), "could not list secrets");
    const parsed = jsonObject(parseJsonValue(body));
    const names = parsed && Array.isArray(parsed.names) ? parsed.names.filter(isString) : [];
    console.log(names.length ? names.join("\n") : "no secrets");
    return;
  }
  if (sub === "delete") {
    await responseText(await fetch(`${base}/${name}`, { method: "DELETE", headers: auth }), "delete rejected");
    console.log(ok(`removed ${name}`));
    return;
  }

  const value = inlineValue ?? (await Bun.stdin.text()).replace(/\r?\n$/, "");
  if (!value) fail("no value — pipe it on stdin, or pass --value <value>");
  await responseText(
    await fetch(`${base}/${name}`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ value }) }),
    "put rejected",
  );
  console.log(ok(`set ${name} — applies on the next deploy or sprout restart`));
}

/**
 * #79 — one command per storage product (`kv`, `d1`, `r2`, `queues`), each with
 * the same five verbs, over that product's own `/api/<product>` collection.
 *
 * Wrangler nests two of its four (`kv namespace create`, `r2 bucket create`)
 * and leaves `d1 create` and `queues create` flat. The nesting is there to
 * separate the container from its contents, which the verb already does — so
 * ours are uniform, and contents take their own noun when they exist
 * (`kv key get`, `r2 object put`).
 */
/** The account's resources of one kind, by name. */
async function storageRows(base: string, auth: Record<string, string>, product: StorageProduct): Promise<JsonObject[]> {
  const body = await responseText(await fetch(base, { headers: auth }), `could not list ${product.plural}`);
  const parsed = jsonObject(parseJsonValue(body));
  return (parsed && Array.isArray(parsed.resources) ? parsed.resources : [])
    .map((entry) => jsonObject(entry))
    .filter((entry): entry is JsonObject => Boolean(entry));
}

/** Resolve a name to its `<kind>_<id>` handle — the API addresses rows by id. */
function idForName(rows: JsonObject[], name: string, product: StorageProduct): string {
  const match = rows.find((row) => row.name === name);
  if (!match || !isString(match.id)) fail(`no ${product.noun} named "${name}"`);
  return String(match.id);
}

async function storage(key: string, args: string[]) {
  const product = STORAGE_PRODUCTS.find((entry) => entry.name === key)!;
  const sub = args[0] && STORAGE_VERBS.some((verb) => verb === args[0]) ? args.shift()! : "list";
  const { apiUrl, token } = await apiCredentials();
  const base = `${apiUrl}/api/${product.name}`;
  const auth = { "x-api-key": token };

  if (sub === "list") {
    const rows = await storageRows(base, auth, product);
    if (rows.length === 0) { console.log(`no ${product.plural}`); return; }
    for (const row of rows) {
      const bound = Array.isArray(row.projects) ? row.projects.filter(isString) : [];
      console.log(`${String(row.id).padEnd(30)} ${String(row.name).padEnd(24)} ${bound.length ? bound.join(", ") : dim("unbound")}`);
    }
    return;
  }

  const name = args.shift();
  if (!name) usageError(`${key} ${sub}: missing <name>`, `${key} ${sub} <name>`);

  if (sub === "create") {
    const body = await responseText(
      await fetch(base, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name }) }),
      "create rejected",
    );
    const record = jsonObject(jsonObject(parseJsonValue(body))?.resource ?? null);
    if (!record || !isString(record.id)) fail("create response was not a resource");
    console.log(ok(`created ${product.noun} ${bold(String(record.name))}`));
    console.log(record.id);
    return;
  }

  const rows = await storageRows(base, auth, product);
  const id = idForName(rows, name, product);

  if (sub === "info") {
    const row = rows.find((entry) => entry.id === id)!;
    const bound = Array.isArray(row.projects) ? row.projects.filter(isString) : [];
    console.log(`${bold(String(row.name))}  ${dim(String(row.id))}`);
    console.log(`  created  ${String(row.createdAt)}`);
    console.log(`  bound to ${bound.length ? bound.join(", ") : "nothing"}`);
    return;
  }

  if (sub === "rename") {
    const next = args.shift();
    if (!next) usageError(`${key} rename: missing <new-name>`, `${key} rename <name> <new-name>`);
    await responseText(
      await fetch(`${base}/${id}`, { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: next }) }),
      "rename rejected",
    );
    console.log(ok(`renamed ${name} → ${next}`));
    return;
  }

  await responseText(await fetch(`${base}/${id}`, { method: "DELETE", headers: auth }), "delete rejected");
  console.log(ok(`deleted ${product.noun} ${name}`));
}

async function deleteProject(args: string[]) {
  // `sproutboat delete [project-dir] [--name <project>] --yes` — flags in any order.
  const positional: string[] = [];
  let confirmed = false;
  let explicitName: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") confirmed = true;
    else if (arg === "--name") explicitName = args[(index += 1)];
    else if (!arg.startsWith("-")) positional.push(arg);
    else usageError(`delete: unknown flag "${arg}"`, "delete [project-dir] [--name <project>] --yes");
  }

  const { apiUrl, token } = await apiCredentials();
  const name = explicitName ?? (await readProject(positional[0])).config.name;
  if (!confirmed) fail(`this permanently removes "${name}", every version, and its route — re-run with --yes`);

  const url = `${apiUrl}/api/projects/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`;
  const body = await responseText(await fetch(url, { method: "DELETE", headers: { "x-api-key": token } }), "delete rejected");

  let result: JsonObject = {};
  try { result = jsonObject(parseJsonValue(body)) ?? {}; } catch { /* a 2xx already confirmed the delete */ }
  const versions = isSafeInteger(result.versionsRemoved) ? result.versionsRemoved : 0;
  const routes = Array.isArray(result.routeRemoved) ? result.routeRemoved.filter(isString) : [];
  const failed = Array.isArray(result.artifactCleanupFailed) ? result.artifactCleanupFailed.filter(isString) : [];

  console.log(ok(`deleted ${name} — ${versions} version${versions === 1 ? "" : "s"} removed`));
  for (const route of routes) console.log(`  released ${route}`);
  if (failed.length) console.log(`  ! ${failed.length} artifact file(s) left on disk — remove them manually`);
}

/** `sproutboat` alone or with -h/--help/help: the friendly grouped list, exit 0. */
function help(): never {
  console.log(helpText());
  process.exit(0);
}

/** An unrecognised command: a short pointer on stderr, exit 2 (misuse, not failure). */
function usage(): never {
  console.error(`${rose("✗")} unknown command "${command}"\n  ${dim("run `sproutboat` for the list of commands")}`);
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined || command === "help" || command === "-h" || command === "--help") help();
if (command === "--version" || command === "-v") { console.log(`sproutboat ${CLI_VERSION}`); process.exit(0); }

await notifyIfOutdated(CLI_VERSION);

switch (command) {
  case "init": await init(args[0]); break;
  case "check": await check(args[0]); break;
  case "build": {
    const hostBuild = args.includes("--target") && args[args.indexOf("--target") + 1] === "host";
    await build(args.find((arg) => !arg.startsWith("--") && arg !== "host"), hostBuild ? "host" : "linux-x86_64");
    break;
  }
  case "login": await login(args); break;
  case "logout": await logout(args); break;
  case "whoami": await whoami(); break;
  case "deploy": await deploy(args); break;
  case "versions": await versions(args); break;
  case "rollback": await rollback(args); break;
  case "domains": await domains(args); break;
  case "secrets": await secrets(args); break;
  case "kv": case "d1": case "r2": case "queues": await storage(command, args); break;
  case "tail": await tail(args); break;
  case "delete": await deleteProject(args); break;
  default: usage();
}
