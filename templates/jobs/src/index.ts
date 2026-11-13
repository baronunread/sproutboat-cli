// Scheduled work with a queue in the middle.
//
//   cron (hourly)  scheduled()  ->  JOBS queue  ->  queue()  ->  KV
//
// The cron handler only decides what to do and enqueues it, which is fast and cannot be half-done. The queue
// consumer does the work, is retried when it throws, and is safe to run twice (queues deliver at least once).
// POST /jobs enqueues the same job by hand, so you can try the whole path without waiting for the hour.
//
//   POST /events            {"name": "signup"}        record an event for today (UTC)
//   POST /jobs              {"date": "2026-11-13"}    enqueue a digest of that day (default today), 202
//   GET  /jobs/:id                                    queued, done (with the digest) or failed
//   GET  /digests/:date                               the latest stored digest of a day
import {
  DATE_PATTERN,
  NAME_PATTERN,
  digestKey,
  enqueueDigest,
  failJob,
  getJob,
  processDigest,
  recordEvent,
  today,
  type DigestJob,
} from "./digest.ts";

const MAX_ATTEMPTS = 3;
const HOUR = 60 * 60 * 1000;

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const bad = (message: string) => Response.json({ error: message }, { status: 400 });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/")
      return Response.json({
        name: "jobs",
        routes: ["POST /events", "POST /jobs", "GET /jobs/:id", "GET /digests/:date"],
      });

    if (pathname === "/events" && request.method === "POST") {
      const body = await readObject(request);
      const name = body?.name;
      if (typeof name !== "string" || !NAME_PATTERN.test(name))
        return bad("name is 1 to 40 characters: a-z, 0-9, dot, dash, underscore");
      await recordEvent(env.STATE, name);
      return Response.json({ recorded: name, date: today() }, { status: 201 });
    }

    if (pathname === "/jobs" && request.method === "POST") {
      const body = (await readObject(request)) ?? {};
      const date = body.date ?? today();
      if (typeof date !== "string" || !DATE_PATTERN.test(date) || Number.isNaN(Date.parse(date)))
        return bad("date is YYYY-MM-DD");
      const job: DigestJob = { id: crypto.randomUUID(), date };
      await enqueueDigest(env, job);
      return Response.json(job, { status: 202, headers: { location: `/jobs/${job.id}` } });
    }

    const job = /^\/jobs\/([0-9a-z-]{1,64})$/.exec(pathname);
    if (job && request.method === "GET") {
      const record = await getJob(env.STATE, job[1]);
      return record ? Response.json(record) : Response.json({ error: "no such job" }, { status: 404 });
    }

    const digest = /^\/digests\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
    if (digest && request.method === "GET") {
      const stored = await env.STATE.get(digestKey(digest[1]), "json");
      return stored ? Response.json(stored) : Response.json({ error: "no digest for that day yet" }, { status: 404 });
    }

    return new Response("not found\n", { status: 404 });
  },

  // Runs on the cron expression in sproutboat.jsonc. The job id is the hour, so a trigger that fires twice for the
  // same hour (cron is at least once too) enqueues one job.
  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime);
    const hour = Math.floor(controller.scheduledTime / HOUR);
    await enqueueDigest(env, { id: `hourly-${hour}`, date: today(at) }, at);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processDigest(env, message.body, message.attempts);
        message.ack();
      } catch (error) {
        console.error(`job ${message.body.id} failed (attempt ${message.attempts})`, error);
        if (message.attempts < MAX_ATTEMPTS) {
          message.retry({ delaySeconds: 2 ** message.attempts });
        } else {
          // Out of attempts: keep the reason where GET /jobs/:id shows it, and stop redelivering.
          await failJob(env, message.body, message.attempts, error);
          message.ack();
        }
      }
    }
  },
} satisfies ExportedHandler<Env, DigestJob>;
