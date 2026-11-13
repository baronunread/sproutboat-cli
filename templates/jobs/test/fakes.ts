// Just enough KV and Queue for the handlers' unit tests: a Map, and an array of what was sent.
export function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    store,
    async get(key: string, type?: string) {
      const value = store.get(key) ?? null;
      return type === "json" && value !== null ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
  return kv;
}

export function fakeEnv() {
  const STATE = fakeKv();
  const sent: unknown[] = [];
  const JOBS = {
    async send(message: unknown) {
      sent.push(message);
    },
  };
  // SAFETY: only the methods the handlers call exist on the fakes.
  return { env: { STATE, JOBS } as unknown as Env, state: STATE, sent };
}

/** A queue message that records what the consumer did with it. */
export function fakeMessage<Body>(body: Body, attempts = 1) {
  const calls: string[] = [];
  return {
    calls,
    message: {
      body,
      attempts,
      ack: () => calls.push("ack"),
      retry: (options?: { delaySeconds?: number }) => calls.push(`retry:${options?.delaySeconds ?? 0}`),
    },
  };
}
