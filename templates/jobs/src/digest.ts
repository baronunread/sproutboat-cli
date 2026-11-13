// The work: count the events recorded for one UTC date and store the totals. Pure KV, so it runs the same anywhere.

/** The message on the queue. Keep it small and self-describing: it is stored, retried and may be read by a later version. */
export interface DigestJob {
  id: string;
  date: string;
}

export interface Digest {
  date: string;
  total: number;
  byName: Record<string, number>;
  processedAt: string;
}

export type JobRecord =
  | { id: string; date: string; status: "queued"; queuedAt: string }
  | { id: string; date: string; status: "done"; queuedAt: string; digest: Digest; attempts: number }
  | { id: string; date: string; status: "failed"; queuedAt: string; error: string; attempts: number };

const DAY = 24 * 60 * 60;
export const EVENT_TTL = 8 * DAY;
export const JOB_TTL = 2 * DAY;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const today = (now = new Date()): string => now.toISOString().slice(0, 10);
export const jobKey = (id: string) => `job:${id}`;
export const digestKey = (date: string) => `digest:${date}`;

/** One key per event, so two events recorded at the same moment can never overwrite each other's count. */
export async function recordEvent(kv: Env["STATE"], name: string, now = new Date()): Promise<void> {
  const key = `event:${today(now)}:${name}:${crypto.randomUUID()}`;
  await kv.put(key, "1", { expirationTtl: EVENT_TTL });
}

export async function buildDigest(kv: Env["STATE"], date: string, now = new Date()): Promise<Digest> {
  const byName: Record<string, number> = {};
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: `event:${date}:`, cursor });
    for (const { name: key } of page.keys) {
      const name = key.split(":")[2];
      byName[name] = (byName[name] ?? 0) + 1;
      total++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { date, total, byName, processedAt: now.toISOString() };
}

export async function getJob(kv: Env["STATE"], id: string): Promise<JobRecord | null> {
  return kv.get<JobRecord>(jobKey(id), "json");
}

export async function putJob(kv: Env["STATE"], record: JobRecord): Promise<void> {
  await kv.put(jobKey(record.id), JSON.stringify(record), { expirationTtl: JOB_TTL });
}

/** Record the job and put it on the queue. The record goes first, so a status request never finds a job it cannot see. */
export async function enqueueDigest(env: Env, job: DigestJob, now = new Date()): Promise<void> {
  if ((await getJob(env.STATE, job.id)) !== null) return; // the same id twice (a retried cron, a double click) is one job
  await putJob(env.STATE, { id: job.id, date: job.date, status: "queued", queuedAt: now.toISOString() });
  await env.JOBS.send(job);
}

/** Run one job. Safe to run twice for the same message: queues deliver at least once. */
export async function processDigest(env: Env, job: DigestJob, attempts: number): Promise<void> {
  const existing = await getJob(env.STATE, job.id);
  if (existing?.status === "done") return;
  const digest = await buildDigest(env.STATE, job.date);
  await env.STATE.put(digestKey(job.date), JSON.stringify(digest));
  await putJob(env.STATE, {
    id: job.id,
    date: job.date,
    status: "done",
    queuedAt: existing?.queuedAt ?? digest.processedAt,
    digest,
    attempts,
  });
}

export async function failJob(env: Env, job: DigestJob, attempts: number, error: unknown): Promise<void> {
  const existing = await getJob(env.STATE, job.id);
  await putJob(env.STATE, {
    id: job.id,
    date: job.date,
    status: "failed",
    queuedAt: existing?.queuedAt ?? new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    attempts,
  });
}
