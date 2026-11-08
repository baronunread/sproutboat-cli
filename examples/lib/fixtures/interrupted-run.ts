// A harness run that is waiting on a server which never answers; the test
// interrupts it and checks nothing is left behind.
import { Harness } from "../harness";
const port = Number(process.argv[2]);
const harness = new Harness({ backend: "interrupt-fixture", requestTimeoutMs: 60_000 });
const child = harness.spawn(
  "fault-server",
  [process.execPath, new URL("./fault-server.ts", import.meta.url).pathname, "stall"],
  {
    env: { ...process.env, PORT: String(port) },
  },
);
await harness.waitReady(`http://127.0.0.1:${port}/`);
console.log(JSON.stringify({ pid: child.pid, workdir: harness.workdir }));
harness.step("download (never completes)");
await harness.fetch(`http://127.0.0.1:${port}/body`);
