import { corpus } from "./fixtures/corpus";

// A low-rate development pilot, not the dedicated-host capacity harness.
export async function pilot(base: string, rate: number, seconds: number, workload = "order") {
  if (!Number.isInteger(rate) || rate < 1 || rate > 1000 || !Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
    throw new Error("Pilot requires integer RPS 1..1000 and duration 1..60 seconds");
  }
  if (!["order", "upstream", "mixed"].includes(workload))
    throw new Error("Pilot workload must be order, upstream or mixed");
  const order = corpus[1];
  const upstream = corpus.find((probe) => probe.name === "upstream 50ms")!;
  const samples: { probe: string; offsetMs: number; latencyMs: number; ok: boolean; error?: string }[] = [];
  const pending = new Set<Promise<void>>();
  let dropped = 0;
  const started = performance.now();
  const scheduled = rate * seconds;
  for (let i = 0; i < scheduled; i++) {
    const target = started + (i * 1000) / rate;
    const wait = target - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    // Report generator lag rather than delivering accumulated arrivals in a burst.
    if (performance.now() - target > 100 || pending.size >= 256) {
      dropped++;
      continue;
    }
    const probe = workload === "upstream" || (workload === "mixed" && i % 10 === 9) ? upstream : order;
    const sent = performance.now();
    const operation = (async () => {
      try {
        const response = await fetch(base + probe.path, {
          method: probe.method || "GET",
          body: probe.body,
          headers: { "content-type": "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        const body = await response.text();
        samples.push({
          probe: probe.name,
          offsetMs: sent - started,
          latencyMs: performance.now() - sent,
          ok:
            response.status === probe.status &&
            body === probe.expected &&
            response.headers.get("content-type") === probe.type,
        });
      } catch (error) {
        samples.push({
          probe: probe.name,
          offsetMs: sent - started,
          latencyMs: performance.now() - sent,
          ok: false,
          error: String(error),
        });
      }
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  }
  const remaining = started + seconds * 1000 - performance.now();
  if (remaining > 0) await Bun.sleep(remaining);
  await Promise.all(pending);
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const quantile = (p: number) => (latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null);
  return {
    purpose: "local development pilot; generator shares the app host",
    workload,
    mix: workload === "mixed" ? "90% order, 10% upstream 50ms; every tenth scheduled arrival" : null,
    rate,
    seconds,
    scheduled,
    issued: samples.length,
    generatorDropped: dropped,
    correct: samples.filter((sample) => sample.ok).length,
    incorrectOrFailed: samples.filter((sample) => !sample.ok).length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    byProbe: [order.name, upstream.name].map((name) => {
      const group = samples.filter((sample) => sample.probe === name);
      const times = group.map((sample) => sample.latencyMs).sort((a, b) => a - b);
      return {
        name,
        issued: group.length,
        correct: group.filter((sample) => sample.ok).length,
        p50Ms: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
        p99Ms: times.length ? times[Math.ceil(times.length * 0.99) - 1] : null,
      };
    }),
    samples,
  };
}
