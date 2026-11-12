/**
 * The experiments' contract, run against any running copy of src/index.ts: `sproutboat dev`, the standalone
 * binary, or workerd (`wrangler dev`). The same file runs against all of them (see harness.ts and workerd.ts).
 *
 *   bun check.ts http://127.0.0.1:8731 [--json report.json]
 *
 * It asserts what must hold everywhere (the safe strategies never double-book, the caps hold) and records what
 * differs by runtime (whether the naive version races across separate requests) instead of asserting it.
 */
import type { RaceResult, Strategy } from "./src/race";
import type { Timing } from "./src/timing";

export type Summary = Omit<RaceResult, "tally">;
export interface Report {
  base: string;
  info: { edition: string; runtime: string };
  /** One run per strategy: 300 fans inside one request. */
  inRequest: Partial<Record<Strategy, Summary>>;
  /** 40 fans as 40 separate HTTP requests, sent at once. */
  separateRequests: Partial<Record<Strategy, Summary>>;
  timings: { d1: Timing; object: Timing };
}

const STRATEGIES: Strategy[] = ["naive", "statement", "object"];

async function post<Body>(base: string, path: string): Promise<{ status: number; body: Body }> {
  const response = await fetch(base + path, { method: "POST" });
  return { status: response.status, body: await response.json() };
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`);
}

const withoutTally = ({ tally: _tally, ...summary }: RaceResult): Summary => summary;

export async function runChecks(base: string): Promise<Report> {
  const health = await fetch(base + "/healthz");
  expect(health.status === 200, "/healthz answers 200");
  const info: Report["info"] = await (await fetch(base + "/api/info")).json();

  const inRequest: Report["inRequest"] = {};
  for (const strategy of STRATEGIES) {
    const { status, body } = await post<RaceResult>(base, `/api/race?strategy=${strategy}&fans=300&seats=100`);
    expect(status === 200, `${strategy} race answers 200 (got ${status}: ${JSON.stringify(body)})`);
    expect(body.tally.length === 100, `${strategy}: one tally slot per seat`);
    if (strategy === "naive") {
      // Every fan starts before any has finished, so the read-then-write must race on any runtime.
      expect(body.ticketsIssued > body.seats, "naive: more tickets than seats when the fans overlap");
    } else {
      expect(
        body.ticketsIssued === 100 && body.seatsDoubleBooked === 0 && body.oversold === 0,
        `${strategy}: exactly 100 tickets, none twice`,
      );
      expect(body.counterSold === 100, `${strategy}: the counter agrees with the tickets`);
    }
    inRequest[strategy] = withoutTally(body);
  }

  const separateRequests: Report["separateRequests"] = {};
  for (const strategy of STRATEGIES) {
    const opened = await post<{ sale: string }>(base, `/api/sale?strategy=${strategy}&seats=20`);
    const sale = opened.body.sale;
    expect(sale.length > 0, `${strategy}: a sale opens`);
    await Promise.all(
      Array.from({ length: 40 }, (_, fan) => post(base, `/api/buy?strategy=${strategy}&sale=${sale}&fan=${fan}`)),
    );
    const { body } = await post<RaceResult>(base, `/api/sale/close?strategy=${strategy}&sale=${sale}&fans=40`);
    if (strategy !== "naive") {
      expect(
        body.ticketsIssued === 20 && body.seatsDoubleBooked === 0,
        `${strategy}: 20 tickets across 40 separate requests, none twice`,
      );
    }
    separateRequests[strategy] = withoutTally(body);
    const again = await post(base, `/api/sale/close?strategy=${strategy}&sale=${sale}&fans=40`);
    expect(again.status === 404, "a closed sale is gone");
  }

  const capped = await post<RaceResult>(base, "/api/race?strategy=statement&fans=100000&seats=100000");
  expect(capped.body.fans === 500 && capped.body.seats === 200, "fans and seats are capped at 500 and 200");
  expect((await post(base, "/api/race?strategy=nope")).status === 404, "an unknown strategy is refused");

  const timings = await post<Report["timings"]>(base, "/api/timings");
  expect(timings.status === 200 && timings.body.d1.medianUs > 0 && timings.body.object.medianUs > 0, "timings answer");

  // The limiter: thirty starts a minute per address. Seven were used above (3 races, the capped one, 3 sales, timings).
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++)
    limited = (await post(base, "/api/race?strategy=statement&fans=1&seats=1")).status === 429;
  expect(limited, "the per-address rate limit answers 429");

  return { base, info, inRequest, separateRequests, timings: timings.body };
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) throw new Error("usage: bun check.ts <base-url> [--json report.json]");
  const report = await runChecks(base.replace(/\/$/, ""));
  const out = process.argv.indexOf("--json");
  const path = process.argv[out + 1];
  if (out > 0 && path) await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log("\nall checks passed");
}
