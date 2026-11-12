// Durable Objects: one addressable instance per name, with its own storage.
//
// Two requests for the same name reach the same object, one event at a time, so the read-add-write in
// increment() cannot interleave. That is the guarantee KV does not give you.
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  // Public methods are RPC: the Worker calls them as `await stub.increment()`.
  async increment(): Promise<number> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    // At most one alarm is pending per object, so a burst schedules one roll-up, not one per call.
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    return n;
  }

  // Runs after the traffic stops, with no request in flight.
  async alarm() {
    console.log("counter settled at", await this.ctx.storage.get("n"));
  }
}

export default {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.slice(1) || "default";
    const counter = env.COUNTERS.getByName(name);
    return new Response(`${name}: ${await counter.increment()}\n`);
  },
} satisfies ExportedHandler<Env>;
