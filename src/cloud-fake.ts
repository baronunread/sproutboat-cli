/** An in-process stand-in for the Sproutboat Cloud API, exactly the routes the CLI calls. Used by tests only. */
import { createHash } from "node:crypto";

import type { JsonObject } from "./json";

export const FAKE_KEY = "sbk_fakekey0123456789";

export type FakeOptions = {
  /** Replies to POST /v1/device/token, in order; the last one repeats. */
  tokenReplies?: { status: number; body: JsonObject }[];
  role?: string;
  applyStates?: string[];
  existingAssetsRef?: string;
  appExists?: boolean;
  /** Fail every authenticated call with this status. */
  failWith?: { status: number; body: JsonObject };
};

export function startFakeCloud(options: FakeOptions = {}) {
  const calls: { method: string; path: string; body: string; auth: string | null }[] = [];
  const modules = new Set<string>();
  const blobs = new Set<string>();
  const manifests = new Set<string>();
  const replies = [...(options.tokenReplies ?? [])];
  let tokenPolls = 0;
  let revoked = false;
  let appExists = options.appExists ?? false;
  let generation = 0;
  let applies = [...(options.applyStates ?? ["applied"])];
  let spec: JsonObject = {};
  if (options.existingAssetsRef) spec.assets_manifest_ref = options.existingAssetsRef;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = new TextDecoder().decode(await request.arrayBuffer());
      const path = url.pathname;
      calls.push({
        method: request.method,
        path,
        body: path.startsWith("/v1/modules/") || path.startsWith("/v1/assets/blobs/") ? "" : body,
        auth: request.headers.get("authorization"),
      });
      if (path === "/v1/config") return Response.json({ ingress: "public", github: false, public_url: null });
      if (path === "/v1/device/code")
        return Response.json({
          device_code: "dc-secret",
          user_code: "ABCD-EFGH",
          verification_uri: `${url.origin}/device`,
          verification_uri_complete: `${url.origin}/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      if (path === "/v1/device/token") {
        tokenPolls++;
        const next = replies.length > 1 ? replies.shift()! : replies[0];
        if (next) return Response.json(next.body, { status: next.status });
        return Response.json({
          access_token: FAKE_KEY,
          token_type: "Bearer",
          key_id: "key_1",
          key_name: "CLI on testbox",
          organization: { id: "org_1", slug: "acme", name: "Acme Inc" },
          role: "developer",
        });
      }
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (bearer !== FAKE_KEY || revoked)
        return Response.json({ error: "invalid, expired or revoked API key" }, { status: 401 });
      if (options.failWith) return Response.json(options.failWith.body, { status: options.failWith.status });
      if (path === "/v1/whoami")
        return Response.json({
          kind: "apikey",
          organization: "org_1",
          organization_slug: "acme",
          organization_name: "Acme Inc",
          key: {
            id: "key_1",
            name: "CLI on testbox",
            permissions: { app: ["read", "write", "delete_own"], secret: ["list", "write"] },
          },
          created_by: { id: "u1", name: "Robin", email: "robin@example.test" },
        });
      if (path === "/v1/keys/self" && request.method === "DELETE") {
        revoked = true;
        return Response.json({ revoked: true });
      }
      if (path === "/v1/assets/missing") {
        const wanted: string[] = JSON.parse(body).sha256;
        return Response.json({ missing: wanted.filter((h) => !blobs.has(h)) });
      }
      let m = /^\/v1\/assets\/blobs\/([0-9a-f]{64})$/.exec(path);
      if (m && request.method === "PUT") {
        blobs.add(m[1]!);
        return Response.json({ stored: true });
      }
      m = /^\/v1\/assets\/manifests\/([0-9a-f]{64})$/.exec(path);
      if (m && request.method === "PUT") {
        if (createHash("sha256").update(body).digest("hex") !== m[1])
          return Response.json({ error: "digest mismatch" }, { status: 400 });
        manifests.add(m[1]!);
        return Response.json({ ref: `assets/${m[1]}` });
      }
      m = /^\/v1\/modules\/([0-9a-f]{64})$/.exec(path);
      if (m && request.method === "PUT") {
        modules.add(m[1]!);
        return Response.json({ sha256: m[1] });
      }
      m = /^\/v1\/apps\/([^/]+)$/.exec(path);
      if (m && request.method === "GET") {
        if (!appExists) return Response.json({ error: "no such app" }, { status: 404 });
        const state = applies.length > 1 ? applies.shift()! : applies[0]!;
        return Response.json({
          app_id: m[1],
          record_generation: generation,
          spec,
          apply: {
            state,
            applied_generation: state === "applied" ? generation : null,
            error: state === "failed" ? "module failed to load" : null,
          },
        });
      }
      if (m && request.method === "PUT") {
        const sent = JSON.parse(body);
        if (!modules.has(sent.module.sha256)) return Response.json({ error: "module not uploaded" }, { status: 400 });
        spec = { ...sent };
        appExists = true;
        generation++;
        return Response.json({ app_id: m[1], record_generation: generation, host_id: "h1", placement_generation: 1 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    modules,
    blobs,
    manifests,
    get tokenPolls() {
      return tokenPolls;
    },
    get revoked() {
      return revoked;
    },
    get spec() {
      return spec;
    },
    stop: () => server.stop(true),
  };
}
