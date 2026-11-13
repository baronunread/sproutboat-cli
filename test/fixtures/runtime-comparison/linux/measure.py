#!/usr/bin/env python3
"""Repeat the same validated HTTP workload on three direct Linux app runtimes."""
import concurrent.futures
import hashlib
import http.client
import json
import os
import pathlib
import random
import socket
import statistics
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
TOOLS = ROOT.parent / "tools"
NODE = TOOLS / "node"
WORKERD = TOOLS / "workerd"


def setting(name, default, low, high):
    value = int(os.environ.get(name, default))
    if not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


SEED = setting("BENCH_SEED", 20260930, 0, 2**32 - 1)
REPEATS = setting("BENCH_REPEATS", 3, 1, 20)
IDLE_SECONDS = setting("BENCH_IDLE_SECONDS", 60, 1, 300)
RATE = setting("BENCH_RATE", 50, 1, 1000)
REQUESTS = setting("BENCH_REQUESTS", 500, 10, 100000)
WARMUP = setting("BENCH_WARMUP_REQUESTS", 100, 0, 10000)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def version(binary):
    result = subprocess.run([str(binary), "--version"], capture_output=True, text=True, check=True)
    return (result.stdout + result.stderr).strip()


def request(port, probe):
    start = time.perf_counter()
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"content-type": "application/json"}
    if "signature" in probe:
        headers["x-signature"] = probe["signature"]
    try:
        conn.request(probe.get("method", "GET"), probe["path"], body=probe.get("body", "").encode(), headers=headers)
        response = conn.getresponse()
        body = response.read().decode()
        correct = (response.status == probe["status"] and body == probe["expected"]
                   and response.getheader("content-type", "").startswith(probe["type"]))
        return {"ok": correct, "ms": (time.perf_counter() - start) * 1000, "status": response.status}
    except Exception as error:
        return {"ok": False, "ms": (time.perf_counter() - start) * 1000, "error": str(error)}
    finally:
        conn.close()


def memory(pid):
    values = {}
    try:
        for line in pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
            parts = line.split()
            if parts[0] in ("Rss:", "Pss:"):
                values[parts[0][:-1] + "KiB"] = int(parts[1])
    except OSError:
        pass
    return values


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def cpu_usage(cgroup):
    path = pathlib.Path("/sys/fs/cgroup") / cgroup.lstrip("/") / "cpu.stat"
    return int(next(line.split()[1] for line in path.read_text().splitlines() if line.startswith("usage_usec ")))


def load(port, probe, mixed_probe=None):
    for _ in range(WARMUP):
        if not request(port, probe)["ok"]:
            raise RuntimeError("Warmup response failed validation")
        time.sleep(1 / RATE)
    samples = []
    memory_samples = []
    dropped = 0
    start_cpu = cpu_usage(current_cgroup)
    start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
        pending = []
        for index in range(REQUESTS):
            due = start + index / RATE
            time.sleep(max(0, due - time.perf_counter()))
            if time.perf_counter() - due > 0.1:
                dropped += 1
                continue
            candidate = mixed_probe if mixed_probe and index % 10 == 0 else probe
            pending.append(pool.submit(request, port, candidate))
            if index % max(1, RATE) == 0:
                memory_samples.append(memory(current_pid))
        samples = [future.result() for future in pending]
    elapsed = time.perf_counter() - start
    used_cpu = cpu_usage(current_cgroup) - start_cpu
    sorted_ms = sorted(sample["ms"] for sample in samples)
    at = lambda fraction: sorted_ms[int(fraction * (len(sorted_ms) - 1))] if sorted_ms else None
    return {
        "name": "mixed" if mixed_probe else "order", "offeredRate": RATE,
        "scheduled": REQUESTS, "generatorDropped": dropped, "completed": len(samples),
        "correct": sum(sample["ok"] for sample in samples), "elapsedSeconds": elapsed,
        "cpuUsec": used_cpu, "samples": samples, "memorySamples": memory_samples,
        "p50Ms": at(0.5), "p95Ms": at(0.95), "p99Ms": at(0.99),
    }


# The gate reports its PID after systemd creates the scope, then execs the app.
if len(sys.argv) > 1 and sys.argv[1] == "--gate":
    print(json.dumps({"pid": os.getpid(), "cgroup": pathlib.Path("/proc/self/cgroup").read_text()}), flush=True)
    sys.stdin.readline()
    os.execv(sys.argv[2], sys.argv[2:])

for binary in (NODE, WORKERD, ROOT / "sprout"):
    if not binary.is_file():
        raise SystemExit(f"Missing runtime executable: {binary}")

corpus = json.loads((ROOT / "corpus.json").read_text())
health = corpus[0]
order = next(probe for probe in corpus if probe["name"] == "small order")
upstream_probe = next(probe for probe in corpus if probe["name"] == "upstream 50ms")
protocol = {"seed": SEED, "repeats": REPEATS, "idleSeconds": IDLE_SECONDS, "offeredRate": RATE,
            "requestsPerWorkload": REQUESTS, "warmupRequests": WARMUP, "connection": "fresh HTTP/1.1 per request",
            "cpuQuota": "100%", "memoryMax": "512M", "appCpu": 0, "generatorCpu": 1}
report = {
    "schema": 2, "label": "Direct app, shared Linux host, fixed offered load",
    "dateUTC": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "machine": {"uname": list(os.uname()), "cpu": pathlib.Path("/proc/cpuinfo").read_text(),
                "memory": pathlib.Path("/proc/meminfo").read_text(), "loadBefore": os.getloadavg()},
    "protocol": protocol, "payload": json.loads((ROOT / "payload.json").read_text()),
    "tools": {name: {"version": version(path), "sha256": sha256(path), "executableBytes": path.stat().st_size}
              for name, path in (("node", NODE), ("workerd", WORKERD))},
    "artifacts": {"nodeAppBytes": (ROOT / "adapters/node.mjs").stat().st_size + (ROOT / "fixtures/app.js").stat().st_size,
                  "workerdBundleBytes": (ROOT / "worker.js").stat().st_size},
    "runs": [],
}
log = (ROOT / "runtime.log").open("w")
# SB_EGRESS_ALLOW: the upstream is on loopback, which a sprout's fetch() refuses (#174).
env = dict(os.environ, BENCH_UPSTREAM="http://127.0.0.1:18081", PORT="18081", SB_EGRESS_ALLOW="127.0.0.1")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 18081))
upstream = subprocess.Popen(["taskset", "-c", "1", str(NODE), str(ROOT / "adapters/upstream.mjs")],
                            env=env, stdout=log, stderr=log)
try:
    for _ in range(200):
        if request(18081, dict(health, type=""))["ok"]:
            break
        time.sleep(0.01)
    else:
        raise RuntimeError("Controlled upstream failed readiness")
    rng = random.Random(SEED)
    for repeat in range(REPEATS):
        names = ["node", "workerd", "sproutboat"]
        rng.shuffle(names)
        for name in names:
            appport = free_port()
            env["PORT"] = str(appport)
            env["SB_DATA_DIR"] = str(ROOT / "data")
            gate = None
            if name == "node":
                command = [str(NODE), str(ROOT / "adapters/node.mjs")]
            elif name == "sproutboat":
                command = [str(ROOT / "sprout")]
            else:
                config = ROOT / "workerd.capnp"
                config.write_text('''using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = (modules = [(name = "worker.js", esModule = embed "worker.js")], compatibilityDate = "2026-09-01", bindings = [(name = "BENCH_UPSTREAM", text = "http://127.0.0.1:18081")])), (name = "internet", network = (allow = ["127.0.0.1/32"]))], sockets = [(name = "http", address = "127.0.0.1:%d", http = (), service = "main")]);''' % appport)
                command = [str(WORKERD), "serve", str(config)]
            proc = subprocess.Popen(["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=512M",
                                     "-p", "CPUQuota=100%", "taskset", "-c", "0", sys.executable,
                                     str(ROOT / "measure.py"), "--gate", *command],
                                    env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
            try:
                gate = json.loads(proc.stdout.readline())
                current_pid = gate["pid"]
                current_cgroup = gate["cgroup"].strip().split(":")[-1]
                start = time.perf_counter()
                proc.stdin.write("\n")
                proc.stdin.flush()
                for _ in range(1000):
                    if request(appport, health)["ok"]:
                        break
                    if proc.poll() is not None:
                        raise RuntimeError(f"{name} exited during startup")
                    time.sleep(0.001)
                else:
                    raise RuntimeError("Readiness timeout")
                row = {"runtime": name, "repeat": repeat, "startupMs": (time.perf_counter() - start) * 1000,
                       "gate": gate, "correctness": [dict(name=probe["name"], **request(appport, probe)) for probe in corpus]}
                report["runs"].append(row)
                if not all(probe["ok"] for probe in row["correctness"]):
                    raise RuntimeError(f"{name} failed correctness")
                row["idleSamples"] = []
                for _ in range(IDLE_SECONDS):
                    time.sleep(1)
                    row["idleSamples"].append(memory(current_pid))
                row["idleMemory"] = {key: statistics.median(sample[key] for sample in row["idleSamples"])
                                     for key in ("PssKiB", "RssKiB")}
                row["workloads"] = [load(appport, order), load(appport, order, upstream_probe)]
                cgroup_path = pathlib.Path("/sys/fs/cgroup") / current_cgroup.lstrip("/")
                row["cgroup"] = {field: (cgroup_path / field).read_text()
                                 for field in ("memory.current", "memory.peak", "memory.max", "cpu.stat", "cpu.max")
                                 if (cgroup_path / field).exists()}
                if any(work["generatorDropped"] or work["correct"] != work["scheduled"] for work in row["workloads"]):
                    raise RuntimeError("Load failed arrival or response validation")
                print(name, repeat, "passed", row["idleMemory"], flush=True)
            except Exception as error:
                if "row" in locals() and row.get("runtime") == name and row.get("repeat") == repeat:
                    row["error"] = str(error)
                raise
            finally:
                (ROOT / "results.json").write_text(json.dumps(report, indent=2))
                if gate is not None:
                    try:
                        os.kill(gate["pid"], 15)
                    except ProcessLookupError:
                        pass
                try:
                    proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
finally:
    upstream.terminate()
    upstream.wait(timeout=5)
    report["machine"]["loadAfter"] = os.getloadavg()
    (ROOT / "results.json").write_text(json.dumps(report, indent=2))
    log.close()
