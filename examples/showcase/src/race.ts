import type { Env } from "./env";
import { LIMITS } from "./guard";

export type Strategy = "naive" | "statement" | "object";
export const STRATEGIES: Strategy[] = ["naive", "statement", "object"];

type Counter = { sold: number; seats: number };

// #region naive
// Read the counter, then write it back. Two fans that read before either writes get the same seat.
async function buyNaive(env: Env, sale: string, fan: number): Promise<number | null> {
  const row = await env.DB.prepare("SELECT sold, seats FROM sale WHERE id = ?").bind(sale).first<Counter>();
  if (!row || row.sold >= row.seats) return null;
  const seat = row.sold + 1;
  await env.DB.prepare("UPDATE sale SET sold = ? WHERE id = ?").bind(seat, sale).run();
  await env.DB.prepare("INSERT INTO ticket (sale, seat, fan) VALUES (?, ?, ?)").bind(sale, seat, fan).run();
  return seat;
}
// #endregion

// #region statement
// The same sale in one statement: the database checks and counts in a single step.
async function buyStatement(env: Env, sale: string, fan: number): Promise<number | null> {
  const row = await env.DB.prepare("UPDATE sale SET sold = sold + 1 WHERE id = ? AND sold < seats RETURNING sold")
    .bind(sale)
    .first<Pick<Counter, "sold">>();
  if (!row) return null;
  await env.DB.prepare("INSERT INTO ticket (sale, seat, fan) VALUES (?, ?, ?)").bind(sale, row.sold, fan).run();
  return row.sold;
}
// #endregion

// #region object
// One object per sale. The same read-then-write as buyNaive, on SQLite that lives inside the object:
// the calls are synchronous and requests to one object run one at a time, so nothing runs in between.
export class TicketOffice {
  ctx: DurableObjectState;
  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const sql = this.ctx.storage.sql;
    const url = new URL(request.url);
    if (url.pathname === "/open") {
      sql.exec("CREATE TABLE IF NOT EXISTS sale (sold INTEGER, seats INTEGER)");
      sql.exec("CREATE TABLE IF NOT EXISTS ticket (seat INTEGER, fan INTEGER)");
      sql.exec("INSERT INTO sale VALUES (0, ?)", Number(url.searchParams.get("seats")));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/buy") {
      const { sold, seats } = sql.exec<Counter>("SELECT sold, seats FROM sale").one();
      if (sold >= seats) return Response.json({ seat: null });
      sql.exec("UPDATE sale SET sold = ?", sold + 1);
      sql.exec("INSERT INTO ticket VALUES (?, ?)", sold + 1, Number(url.searchParams.get("fan")));
      return Response.json({ seat: sold + 1 });
    }
    if (url.pathname === "/tally") {
      return Response.json({
        counter: sql.exec<Counter>("SELECT sold, seats FROM sale").one().sold,
        seats: sql.exec<{ seat: number; n: number }>("SELECT seat, count(*) AS n FROM ticket GROUP BY seat").toArray(),
      });
    }
    if (url.pathname === "/close") {
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
}
// #endregion

export interface RaceResult {
  strategy: Strategy;
  sale: string;
  fans: number;
  seats: number;
  /** Tickets handed out, counted from the stored rows. */
  ticketsIssued: number;
  /** What the sale's own counter says was sold. */
  counterSold: number;
  /** Seats that more than one fan was given. */
  seatsDoubleBooked: number;
  /** Tickets beyond the number of seats. */
  oversold: number;
  /** Fans who were told the show is sold out. */
  turnedAway: number;
  /** Fans given each seat: tally[0] is seat 1. */
  tally: number[];
}

const stub = (env: Env, sale: string) => env.TICKETS.get(env.TICKETS.idFromName(sale));

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS sale (id TEXT PRIMARY KEY, strategy TEXT, seats INTEGER, sold INTEGER, made INTEGER)",
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ticket (sale TEXT, seat INTEGER, fan INTEGER)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS ticket_sale ON ticket (sale)"),
  ]);
}

/** Forget sales nobody collected, so the demo's storage cannot grow. Run it after a response, with ctx.waitUntil. */
export async function prune(env: Env): Promise<void> {
  const old = await env.DB.prepare("SELECT id, strategy FROM sale WHERE made < ?")
    .bind(Date.now() - LIMITS.saleTtlMs)
    .all<{ id: string; strategy: Strategy }>();
  for (const sale of old.results) await discard(env, sale.id, sale.strategy);
}

async function discard(env: Env, sale: string, strategy: Strategy): Promise<void> {
  if (strategy === "object") await stub(env, sale).fetch("http://object/close");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ticket WHERE sale = ?").bind(sale),
    env.DB.prepare("DELETE FROM sale WHERE id = ?").bind(sale),
  ]);
}

/** Start a sale. Returns null when too many sales are open already. */
export async function openSale(env: Env, strategy: Strategy, seats: number): Promise<string | null> {
  await ensureSchema(env);
  const open = await env.DB.prepare("SELECT count(*) AS n FROM sale WHERE made >= ?")
    .bind(Date.now() - LIMITS.saleTtlMs)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= LIMITS.maxOpenSales) return null;
  const sale = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sale VALUES (?, ?, ?, 0, ?)").bind(sale, strategy, seats, Date.now()).run();
  if (strategy === "object") await stub(env, sale).fetch(`http://object/open?seats=${seats}`);
  return sale;
}

/** One fan tries to buy: the seat they were given, or null when it is sold out. */
export async function buy(env: Env, strategy: Strategy, sale: string, fan: number): Promise<number | null> {
  if (strategy === "naive") return buyNaive(env, sale, fan);
  if (strategy === "statement") return buyStatement(env, sale, fan);
  const answer = await stub(env, sale).fetch(`http://object/buy?fan=${fan}`);
  const body: { seat: number | null } = await answer.json();
  return body.seat;
}

/** Count what is stored, delete the sale, and return the tally. */
export async function closeSale(env: Env, strategy: Strategy, sale: string, fans: number): Promise<RaceResult | null> {
  const row = await env.DB.prepare("SELECT seats, sold FROM sale WHERE id = ?").bind(sale).first<Counter>();
  if (!row) return null;
  let counterSold = row.sold;
  let perSeat: { seat: number; n: number }[];
  if (strategy === "object") {
    const tally: { counter: number; seats: { seat: number; n: number }[] } = await (
      await stub(env, sale).fetch("http://object/tally")
    ).json();
    counterSold = tally.counter;
    perSeat = tally.seats;
  } else {
    perSeat = (
      await env.DB.prepare("SELECT seat, count(*) AS n FROM ticket WHERE sale = ? GROUP BY seat")
        .bind(sale)
        .all<{ seat: number; n: number }>()
    ).results;
  }
  await discard(env, sale, strategy);
  const tally = Array.from({ length: row.seats }, () => 0);
  let ticketsIssued = 0;
  let seatsDoubleBooked = 0;
  for (const { seat, n } of perSeat) {
    ticketsIssued += n;
    if (n > 1) seatsDoubleBooked++;
    if (seat >= 1 && seat <= row.seats) tally[seat - 1] = n;
  }
  return {
    strategy,
    sale,
    fans,
    seats: row.seats,
    ticketsIssued,
    counterSold,
    seatsDoubleBooked,
    oversold: Math.max(0, ticketsIssued - row.seats),
    turnedAway: Math.max(0, fans - ticketsIssued),
    tally,
  };
}

// #region race
// All the fans press "buy" at once: every purchase starts before any of them has finished.
export async function runRace(env: Env, strategy: Strategy, fans: number, seats: number) {
  const sale = await openSale(env, strategy, seats);
  if (!sale) return null;
  const started = Date.now();
  await Promise.all(Array.from({ length: fans }, (_, fan) => buy(env, strategy, sale, fan)));
  const elapsedMs = Date.now() - started;
  const result = await closeSale(env, strategy, sale, fans);
  return result && { ...result, elapsedMs };
}
// #endregion
