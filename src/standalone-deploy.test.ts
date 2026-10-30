import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployFlyScript,
  deployVpsScript,
  dockerfile,
  flyToml,
  systemdService,
  systemdSocket,
  writeDeployFiles,
} from "./standalone-deploy";

const input = { name: "notes", target: "linux-x86_64" } as const;

test("the container is the binary and nothing else, and drains on SIGTERM", () => {
  const text = dockerfile(input);
  expect(text).toContain("FROM scratch");
  expect(text).not.toMatch(/^RUN /m);
  expect(text).toContain('ENTRYPOINT ["/app/notes"]');
  expect(text).toContain("STOPSIGNAL SIGTERM");
  expect(text).toContain("USER 65532:65532");
  expect(dockerfile({ name: "notes", target: "linux-arm64" })).toContain("--platform linux/arm64");
});

test("systemd keeps the socket open across a restart", () => {
  expect(systemdSocket(input)).toContain("ListenStream=8080");
  const service = systemdService(input);
  expect(service).toContain("Requires=notes.socket");
  expect(service).toContain("KillSignal=SIGTERM");
  // Longer than the drain, or systemd kills a process that is still answering.
  expect(service).toContain("SB_DRAIN_SECONDS=20");
  expect(service).toContain("TimeoutStopSec=30");
});

test("the VPS script swaps the file atomically and restarts the service, not the socket", () => {
  const script = deployVpsScript(input);
  expect(script).toContain("mv -f /opt/notes/notes.new /opt/notes/notes");
  expect(script).toContain("systemctl restart notes.service");
  expect(script).not.toContain("restart notes.socket");
});

test("Fly terminates TLS and gets a drain window longer than the binary's", () => {
  const toml = flyToml(input);
  expect(toml).toContain('kill_signal = "SIGTERM"');
  expect(toml).toContain("kill_timeout = 10");
  expect(toml).toContain('SB_DRAIN_SECONDS = "8"');
  expect(toml).toContain('handlers = ["tls", "http"]');
  expect(deployFlyScript(input)).toContain("fly deploy -a notes");
});

test("writeDeployFiles puts the binary where the Dockerfile and scp expect it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-deploy-"));
  try {
    const binary = join(dir, "notes");
    await writeFile(binary, "#!/bin/sh\n");
    const written = await writeDeployFiles({ ...input, binary });
    expect(written.dir).toBe(join(dir, "notes.deploy"));
    expect(written.files).toContain("Dockerfile");
    expect(await readFile(join(written.dir, "notes"), "utf8")).toBe("#!/bin/sh\n");
    expect((await stat(join(written.dir, "deploy-vps.sh"))).mode & 0o111).not.toBe(0);
    expect((await stat(join(written.dir, "data"))).isDirectory()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
