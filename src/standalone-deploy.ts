/**
 * Deploy recipes for a standalone binary: `build --standalone --deploy-files` writes them beside it.
 *
 * Nothing here terminates TLS. The binary is a plain HTTP server, and every recipe puts it behind
 * something that owns the certificate (Fly's edge, a reverse proxy, a load balancer). The recipes are
 * strings so they can be tested without a build; docs/standalone.md explains what they do.
 */
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { LINUX_TARGETS, type LinuxTarget } from "./targets";

export type DeployFilesInput = {
  /** The project name: the binary, unit and Fly app are all called this. */
  name: string;
  target: LinuxTarget;
};

/** A scratch image, so the container is the binary and nothing else. See docs/standalone.md. */
export function dockerfile(input: DeployFilesInput): string {
  const { name } = input;
  return `# syntax=docker/dockerfile:1
# ${LINUX_TARGETS[input.target].platform}. Build:  docker build --platform ${LINUX_TARGETS[input.target].platform} -t ${name} .
# The binary is static and carries its own CA roots, so there is no base image and no libc.
FROM scratch
# 65532 is the usual unprivileged uid. data/ is an empty directory this recipe ships, so the volume
# below starts out writable by that uid without a RUN step (scratch has no shell).
COPY --chown=65532:65532 data/ /data/
COPY --chown=65532:65532 --chmod=0755 ${name} /app/${name}
ENV PORT=8080 SB_DATA_DIR=/data SB_DRAIN_SECONDS=8
EXPOSE 8080
VOLUME /data
USER 65532:65532
# SIGTERM drains: it stops accepting, answers what is in flight and exits. docker stop waits 10 s.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/${name}"]
`;
}

export function dockerignore(): string {
  return "deploy-vps.sh\ndeploy-fly.sh\n*.service\n*.socket\nfly.toml\n";
}

/** The socket systemd keeps open across a restart: the connections waiting in it are never reset. */
export function systemdSocket(input: DeployFilesInput): string {
  const { name } = input;
  return `[Unit]
Description=${name} (listening socket)

[Socket]
# systemd binds this and hands it to ${name}.service as fd 3. The binary serves on it instead of
# binding PORT. It stays open while the service stops and starts, so a restart resets nothing.
ListenStream=8080
Backlog=4096
# By default systemd closes the socket if more than 200 starts are triggered in 2 s, which a busy
# restart can do. Closing it is the reset this exists to avoid.
TriggerLimitIntervalSec=0

[Install]
WantedBy=sockets.target
`;
}

export function systemdService(input: DeployFilesInput): string {
  const { name } = input;
  return `[Unit]
Description=${name}
Requires=${name}.socket
After=network.target

[Service]
Type=simple
ExecStart=/opt/${name}/${name}
# State (SQLite files, R2 objects) lives here; systemd creates it and owns it for the dynamic user.
StateDirectory=${name}
Environment=SB_DATA_DIR=/var/lib/${name}
# Secrets and other settings, one KEY=value per line. The dash makes the file optional.
EnvironmentFile=-/etc/${name}.env
DynamicUser=yes
# A restart sends SIGTERM: the old process answers what it has accepted and exits, then systemd
# starts the new binary on the same socket. Allow it longer than SB_DRAIN_SECONDS.
KillSignal=SIGTERM
Environment=SB_DRAIN_SECONDS=20
TimeoutStopSec=30
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
`;
}

/** One command: first run installs the units, every later run swaps the binary. */
export function deployVpsScript(input: DeployFilesInput): string {
  const { name } = input;
  return `#!/bin/sh
# Usage: ./deploy-vps.sh user@host [ssh options]
# Copies the binary and the systemd units to a Linux box and restarts the service on its socket,
# so the connections waiting at the moment of the swap are served by the new binary, not reset.
# The user needs sudo on the box. TLS is yours: put nginx, Caddy or a load balancer in front of :8080.
set -eu
HOST=\${1:?usage: deploy-vps.sh user@host}
shift
HERE=$(cd "$(dirname "$0")" && pwd)
scp "$@" "$HERE/${name}" "$HERE/${name}.service" "$HERE/${name}.socket" "$HOST:/tmp/"
ssh "$@" "$HOST" 'sudo sh -eu' <<'REMOTE'
mkdir -p /opt/${name}
install -m 0755 /tmp/${name} /opt/${name}/${name}.new
mv -f /opt/${name}/${name}.new /opt/${name}/${name}
install -m 0644 /tmp/${name}.service /tmp/${name}.socket /etc/systemd/system/
rm -f /tmp/${name} /tmp/${name}.service /tmp/${name}.socket
systemctl daemon-reload
systemctl enable --now ${name}.socket
systemctl restart ${name}.service
systemctl --no-pager --lines=5 status ${name}.service
REMOTE
`;
}

export function flyToml(input: DeployFilesInput): string {
  const { name } = input;
  return `app = "${name}"
# Pick the region closest to your users: fly platform regions
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = 10

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  SB_DATA_DIR = "/data"
  SB_DRAIN_SECONDS = "8"

# State lives on a volume. A volume attaches to one machine, so a deploy stops it and starts the new
# one and there is a few seconds with no machine. For an app with no state (no KV, D1, R2, queues or
# Durable Objects), delete this block and run two machines: Fly then replaces them one at a time.
[mounts]
  source = "data"
  destination = "/data"

# Fly terminates TLS at its edge and speaks plain HTTP to the binary.
[[services]]
  protocol = "tcp"
  internal_port = 8080
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.tcp_checks]]
    grace_period = "5s"
    interval = "10s"
    timeout = "2s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
`;
}

/** One command: creates the app and its volume the first time, then deploys. Needs a logged-in fly CLI. */
export function deployFlyScript(input: DeployFilesInput): string {
  const { name } = input;
  return `#!/bin/sh
# Usage: ./deploy-fly.sh [region]
# Needs the fly CLI, logged in (fly auth login). Creates the app and its 1 GB volume on the first run.
set -eu
cd "$(dirname "$0")"
REGION=\${1:-iad}
fly apps list --json | grep -q '"Name": *"${name}"' || fly apps create ${name}
fly volumes list -a ${name} --json | grep -q '"name": *"data"' || fly volumes create data -a ${name} --region "$REGION" --size 1 --yes
fly deploy -a ${name} --config fly.toml
`;
}

export type DeployFiles = { dir: string; files: string[] };

/** Write the recipes into `<binary>.deploy/`, with a copy of the binary where the Dockerfile and scp expect it. */
export async function writeDeployFiles(input: DeployFilesInput & { binary: string }): Promise<DeployFiles> {
  const dir = resolve(dirname(input.binary), `${basename(input.binary)}.deploy`);
  await mkdir(resolve(dir, "data"), { recursive: true });
  await writeFile(resolve(dir, "data/.keep"), "");
  await copyFile(input.binary, resolve(dir, input.name));
  await chmod(resolve(dir, input.name), 0o755);
  const text: [string, string][] = [
    ["Dockerfile", dockerfile(input)],
    [".dockerignore", dockerignore()],
    [`${input.name}.socket`, systemdSocket(input)],
    [`${input.name}.service`, systemdService(input)],
    ["fly.toml", flyToml(input)],
    ["deploy-vps.sh", deployVpsScript(input)],
    ["deploy-fly.sh", deployFlyScript(input)],
  ];
  for (const [file, body] of text) {
    await writeFile(resolve(dir, file), body);
    if (file.endsWith(".sh")) await chmod(resolve(dir, file), 0o755);
  }
  return { dir, files: [input.name, ...text.map(([file]) => file).filter((file) => file !== ".dockerignore")] };
}
