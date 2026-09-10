/**
 * Ambient types for a Sproutboat handler.
 *
 * Shipped with the CLI rather than as a separate package, so the types always
 * describe the runtime that the installed CLI compiles. `sproutboat types`
 * generates a project's `sproutboat-env.d.ts`, which references this file and
 * declares `env` with that project's bindings.
 *
 * Two things differ from Cloudflare Workers and are the reason these exist:
 * `env` is a global rather than a parameter, so nothing is inferable from a
 * signature, and every binding call is synchronous.
 */

declare global {
  // ---------------------------------------------------------------- KV

  interface KVNamespace {
    /** The stored string, or `null`. Synchronous: no `await`. */
    get(key: string): string | null;
    put(key: string, value: string): void;
    delete(key: string): void;
    /** Keys under `prefix` (all keys when omitted). */
    list(prefix?: string): string[];
  }

  // ---------------------------------------------------------------- D1

  interface D1Meta {
    /** `INSERT` only. The autoincrement id of the row just written. */
    last_row_id: number;
    changes: number;
  }

  interface D1Result<T = Record<string, unknown>> {
    results: T[];
    success: boolean;
    meta: D1Meta;
  }

  interface D1PreparedStatement {
    /** Positional `?` parameters, in order. */
    bind(...values: Array<string | number | boolean | null>): D1PreparedStatement;
    all<T = Record<string, unknown>>(): D1Result<T>;
    run(): D1Result;
    /** The first row, or one column of it when named. `null` if there are none. */
    first<T = Record<string, unknown>>(): T | null;
    first<T = unknown>(column: string): T | null;
  }

  interface D1Database {
    prepare(sql: string): D1PreparedStatement;
    batch(statements: D1PreparedStatement[]): D1Result[];
    /** Runs a whole script. Use this for multi-statement DDL. */
    exec(sql: string): void;
  }

  // ---------------------------------------------------------------- R2

  interface R2Object {
    key: string;
    size: number;
    etag: string;
    uploaded: string;
    customMetadata?: Record<string, string>;
    /**
     * The object as a string. An object is held whole in memory on the way in
     * and on the way out, so keep them small.
     */
    body: string;
  }

  type R2ObjectHead = Omit<R2Object, "body">;

  interface R2Objects {
    objects: R2ObjectHead[];
    truncated: boolean;
    cursor?: string;
  }

  interface R2PutOptions {
    customMetadata?: Record<string, string>;
  }

  interface R2ListOptions {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }

  interface R2Bucket {
    put(key: string, value: string, options?: R2PutOptions): void;
    get(key: string): R2Object | null;
    /** Metadata without the body. */
    head(key: string): R2ObjectHead | null;
    delete(key: string): void;
    list(options?: R2ListOptions): R2Objects;
  }

  // ------------------------------------------------------------ Queues

  interface QueueSendOptions {
    delaySeconds?: number;
  }

  interface Queue<Body = unknown> {
    /** Returns immediately. The batch reaches `queue()` out of band. */
    send(body: Body, options?: QueueSendOptions): void;
    sendBatch(messages: Array<{ body: Body }>): void;
  }

  interface QueueMessage<Body = unknown> {
    id: string;
    timestamp: number;
    body: Body;
    /** Mark as handled. Without this the message is redelivered. */
    ack(): void;
    /** Hand it back for another attempt. */
    retry(): void;
  }

  interface MessageBatch<Body = unknown> {
    queue: string;
    messages: Array<QueueMessage<Body>>;
  }

  // --------------------------------------------------- Durable Objects

  interface DurableObjectId {
    toString(): string;
    name?: string;
  }

  interface DurableObjectStub {
    fetch(request: Request): Response;
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    idFromString(hex: string): DurableObjectId;
    newUniqueId(): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  interface DurableObjectStorage {
    get<T = unknown>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
    delete(key: string): void;
    deleteAll(): void;
    /** Stored values under `prefix`, keyed by storage key. */
    list<T = unknown>(options?: { prefix?: string; limit?: number }): Map<string, T>;
    /**
     * At most one alarm is pending per object; a later `setAlarm` replaces it.
     * The handler is the class's `alarm()` method.
     */
    setAlarm(scheduledTime: number): void;
    getAlarm(): number | null;
    deleteAlarm(): void;
  }

  interface DurableObjectState {
    id: DurableObjectId;
    /** Synchronous, like every other binding. */
    storage: DurableObjectStorage;
  }

  // -------------------------------------------------- Analytics Engine

  interface AnalyticsEngineDataPoint {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }

  interface AnalyticsEngineDataset {
    writeDataPoint(event: AnalyticsEngineDataPoint): void;
    query<T = unknown>(options?: { limit?: number }): { count: number; rows: T[] };
  }

  // ------------------------------------ Rate limiting

  /**
   * A rate-limiter binding (#69). `limit` and `period` are fixed in
   * sproutboat.jsonc; `limit({ key })` counts one call against a fixed window
   * and reports whether the key is still under the cap.
   */
  interface RateLimit {
    limit(options: { key: string }): { success: boolean };
  }

  // ------------------------------------ Crypto

  /**
   * `crypto.subtle` covers `digest` (SHA-256/384/512) and HMAC
   * `importKey` / `sign` / `verify`; other algorithms throw.
   *
   * `crypto.scryptVerify` is a Sproutboat extension (#153), not WebCrypto: it
   * re-derives a scrypt hash and compares it in constant time, for migrating
   * password hashes made by Node/Bun `scrypt`. Verify-only on purpose; new
   * credentials should use HMAC/PBKDF2 via `crypto.subtle`.
   */
  interface Crypto {
    scryptVerify(
      password: string | ArrayBuffer | ArrayBufferView,
      salt: string | ArrayBuffer | ArrayBufferView,
      expected: string | ArrayBuffer | ArrayBufferView,
      params?: { N?: number; r?: number; p?: number },
    ): boolean;
  }

  // ------------------------------------ Fetchers: services and assets

  /** A service binding, and the shape of the static-asset binding. */
  interface Fetcher {
    fetch(request: Request): Response;
  }

  // --------------------------------------------------------- Handlers

  interface ScheduledEvent {
    /** The expression that fired, as written in `triggers.crons`. */
    cron: string;
    scheduledTime: number;
  }

  /**
   * The default export.
   *
   * `fetch` takes only a request: `env` is a global, and there is no `ctx`, so
   * there is no `ctx.waitUntil`. Use a queue for work that outlives a response.
   */
  interface SproutboatHandler<QueueBody = unknown> {
    fetch(request: Request): Response | Promise<Response>;
    scheduled?(event: ScheduledEvent): void | Promise<void>;
    queue?(batch: MessageBatch<QueueBody>): void | Promise<void>;
  }

  /**
   * What a Durable Object class implements. Declare it above the default
   * export and name it in `durable_objects`.
   */
  interface DurableObject {
    fetch(request: Request): Response | Promise<Response>;
    /** Runs after `storage.setAlarm`, with no request in flight. */
    alarm?(): void | Promise<void>;
  }
}

export {};
