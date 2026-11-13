#!/usr/bin/env python3
"""Validate a tagged Linux run and derive its comparison from raw samples."""
import gzip
import hashlib
import json
import pathlib
import statistics
import sys


def median(values):
    return round(statistics.median(values), 2)


def summarize(source):
    raw = source.read_bytes()
    report = json.loads(raw)
    if report.get("schema") != 2:
        raise ValueError("Expected tagged comparison schema 2")
    protocol = report["protocol"]
    repeats = protocol["repeats"]
    names = ("node", "workerd", "sproutboat")
    runs = report["runs"]
    if len(runs) != repeats * len(names):
        raise ValueError("Incomplete run: a candidate or repeat is missing")
    rows = {}
    for name in names:
        selected = [row for row in runs if row["runtime"] == name]
        if len(selected) != repeats or sorted(row["repeat"] for row in selected) != list(range(repeats)):
            raise ValueError(f"Incomplete repeats for {name}")
        for row in selected:
            if row.get("error") or not all(probe["ok"] for probe in row["correctness"]):
                raise ValueError(f"Correctness gate failed for {name}, round {row['repeat']}")
            if {work["name"] for work in row["workloads"]} != {"order", "mixed"}:
                raise ValueError(f"Missing workload for {name}, round {row['repeat']}")
            for work in row["workloads"]:
                if work["generatorDropped"] or work["correct"] != work["scheduled"]:
                    raise ValueError(f"Load validation failed for {name}, round {row['repeat']}")
            if "PssKiB" not in row["idleMemory"]:
                raise ValueError(f"Missing idle PSS for {name}, round {row['repeat']}")
        all_workloads = [work for row in selected for work in row["workloads"]]
        orders = [work for work in all_workloads if work["name"] == "order"]
        mixed = [work for work in all_workloads if work["name"] == "mixed"]
        rows[name] = {
            "checks": f"{len(selected[0]['correctness'])}/{len(selected[0]['correctness'])}",
            "startupMs": median(row["startupMs"] for row in selected),
            "idlePssMiB": median(row["idleMemory"]["PssKiB"] / 1024 for row in selected),
            "orderP95Ms": median(work["p95Ms"] for work in orders),
            "mixedP95Ms": median(work["p95Ms"] for work in mixed),
            "orderCpuMsPer1000": median(work["cpuUsec"] / work["correct"] for work in orders),
            "correctTraffic": sum(work["correct"] for work in all_workloads),
            "scheduledTraffic": sum(work["scheduled"] for work in all_workloads),
        }
    artifact = report["artifacts"]
    tools = report["tools"]
    payload = report["payload"]
    rows["node"].update(runtimeExecutableBytes=tools["node"]["executableBytes"], appArtifactBytes=artifact["nodeAppBytes"])
    rows["workerd"].update(runtimeExecutableBytes=tools["workerd"]["executableBytes"], appArtifactBytes=artifact["workerdBundleBytes"])
    rows["sproutboat"].update(runtimeExecutableBytes=None, appArtifactBytes=payload["binaryBytes"])
    return {
        "schema": 1, "cliTag": payload["cliTag"], "cliCommit": payload["cliCommit"],
        "dateUTC": report["dateUTC"], "sourceResultsSha256": hashlib.sha256(raw).hexdigest(),
        "protocol": protocol, "tools": tools, "rows": rows,
    }


def markdown(summary):
    rows = summary["rows"]
    protocol = summary["protocol"]
    lines = [
        f"# Direct app comparison: Sproutboat {summary['cliTag']}", "",
        f"Run: {summary['dateUTC']}. Same validated Worker-style fixture on one Linux host, "
        f"{protocol['repeats']} randomized rounds, {protocol['offeredRate']} offered requests/s. "
        "This fixed-rate run does not measure maximum throughput or hosted Cloudflare Workers.", "",
        "| Measure | Node | workerd | Sproutboat |", "| --- | ---: | ---: | ---: |",
    ]
    def add(label, key, suffix=""):
        lines.append("| " + label + " | " + " | ".join(f"{rows[name][key]}{suffix}" for name in ("node", "workerd", "sproutboat")) + " |")
    add("Correct probes per round", "checks")
    add("App artifact", "appArtifactBytes", " bytes")
    lines.append("| Runtime executable | " + " | ".join(
        "included in app artifact" if rows[name]["runtimeExecutableBytes"] is None
        else f"{rows[name]['runtimeExecutableBytes']} bytes" for name in ("node", "workerd", "sproutboat")) + " |")
    add("Initialized idle PSS", "idlePssMiB", " MiB")
    add("Exec to first correct response", "startupMs", " ms")
    add("Order p95 at fixed load", "orderP95Ms", " ms")
    add("Mixed p95 at fixed load", "mixedP95Ms", " ms")
    add("Order CPU per 1,000 correct responses", "orderCpuMsPer1000", " ms")
    add("Correct measured responses", "correctTraffic")
    lines += ["", "App artifact sizes count the Node source plus shared logic, the workerd bundle, and the Sproutboat standalone binary. Node and workerd also require their separately listed runtime executables and possibly shared system libraries. These sizes are an inventory, not equivalent compressed deployment packages.",
              "", "Idle PSS is the median of one sample per second after correctness checks. Startup includes the test gate and one verified HTTP response. The order workload sends valid roughly 1 KiB JSON; mixed traffic sends 90% orders and 10% requests to a local upstream delayed by 50 ms. Every measured response is checked. The generator and upstream share this host on another CPU, and other services remain running.",
              "", "This is a direct-app fixed-rate comparison. It does not establish saturation, many-app density, public-platform overhead, or a universal latency ranking. Raw samples, cgroup accounting, source hashes, executable hashes, versions and machine details are in the JSON artifact.",
              "", f"Raw results SHA-256: `{summary['sourceResultsSha256']}`.", ""]
    return "\n".join(lines)


def main():
    if len(sys.argv) not in (2, 4) or (len(sys.argv) == 4 and sys.argv[2] != "--export"):
        raise SystemExit("usage: report.py results.json [--export directory]")
    source = pathlib.Path(sys.argv[1]).resolve()
    summary = summarize(source)
    rendered = markdown(summary)
    source.with_name("summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    source.with_name("summary.md").write_text(rendered)
    if len(sys.argv) == 4:
        destination = pathlib.Path(sys.argv[3]).resolve() / summary["cliTag"]
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        (destination / "summary.md").write_text(rendered)
        with (destination / "results.json.gz").open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", filename="", compresslevel=9, mtime=0) as compressed:
            compressed.write(source.read_bytes())
    print(rendered)


if __name__ == "__main__":
    main()
