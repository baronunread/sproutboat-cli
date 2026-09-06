// Durable Objects: one addressable instance per name, with its own storage.
//
//   curl localhost:8080/downloads    # each path is its own counter
//   curl localhost:8080/signups
//
// Two requests to the same name reach the same object, so the read-add-write
// below cannot interleave. That is the guarantee KV does not give you.

export class Counter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // Synchronous: state.storage.* are blocking calls.
  fetch() {
    const n = (this.state.storage.get("n") || 0) + 1;
    this.state.storage.put("n", n);
    // At most one alarm is pending per object, so a burst schedules one
    // roll-up rather than one per request.
    this.state.storage.setAlarm(Date.now() + 5000);
    return new Response(String(n));
  }

  // Runs after the traffic stops, without a request in flight.
  alarm() {
    console.log("counter settled at", this.state.storage.get("n"));
  }
}

export default {
  fetch(request) {
    const name = new URL(request.url).pathname.slice(1) || "default";
    const stub = env.COUNTERS.get(env.COUNTERS.idFromName(name));
    return new Response(`${name}: ${stub.fetch(request).text()}\n`);
  },
};
