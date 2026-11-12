import type { Env } from "./env";

export interface Timing {
  /** Queries in one timed batch. */
  batch: number;
  /** Microseconds per query, one value per batch. */
  samplesUs: number[];
  medianUs: number;
  minUs: number;
  maxUs: number;
}

// #region timing
// Date.now() ticks in whole milliseconds, so one query cannot be timed alone. Grow a batch until it
// takes at least 10 ms, then time eight batches and divide each by its size.
export async function perQuery(query: () => object | null | undefined): Promise<Timing> {
  let batch = 25;
  for (;;) {
    const start = Date.now();
    for (let i = 0; i < batch; i++) await query();
    if (Date.now() - start >= 10 || batch >= 20_000) break;
    batch *= 2;
  }
  const samplesUs: number[] = [];
  for (let run = 0; run < 8; run++) {
    const start = Date.now();
    for (let i = 0; i < batch; i++) await query();
    samplesUs.push(Math.round(((Date.now() - start) * 1000 * 10) / batch) / 10);
  }
  const sorted = [...samplesUs].sort((a, b) => a - b);
  return { batch, samplesUs, medianUs: sorted[3]!, minUs: sorted[0]!, maxUs: sorted[7]! };
}

// The same SELECT twice. D1 is a binding to a database; the object's SQLite is inside the object.
export async function compareQueries(env: Env) {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS bench (k INTEGER PRIMARY KEY, v TEXT)");
  await env.DB.exec("INSERT OR REPLACE INTO bench VALUES (1, 'x')");
  const d1 = await perQuery(() => env.DB.prepare("SELECT v FROM bench WHERE k = ?").bind(1).first());
  const inObject = await env.BENCH.get(env.BENCH.idFromName("bench")).fetch("http://object/");
  const object: Timing = await inObject.json();
  return { d1, object };
}

export class QueryBench {
  ctx: DurableObjectState;
  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(): Promise<Response> {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS bench (k INTEGER PRIMARY KEY, v TEXT)");
    sql.exec("INSERT OR REPLACE INTO bench VALUES (1, 'x')");
    return Response.json(await perQuery(() => sql.exec("SELECT v FROM bench WHERE k = ?", 1).one()));
  }
}
// #endregion
