/**
 * Ambient types for a Sproutboat handler.
 *
 * Shipped with the CLI rather than as a separate package, so the types always
 * describe the runtime that the installed CLI compiles. `sproutboat types`
 * generates a project's `sproutboat-env.d.ts`, which references this file and
 * declares `env` with that project's bindings.
 *
 * Bindings are synchronous in these declarations, which describe the behaviour before the
 * compatibility date that makes each one return a Promise (D1 2026-10-24, KV 2026-10-25,
 * R2 2026-10-26); from that date, `await` the call, as on Workers. `await` works at every
 * date. Before compatibility date 2026-09-28, `env` is a
 * global only and `ctx` is the second handler argument. From that date, `env`
 * is also passed as the second argument and `ctx` as the third.
 */

declare global {
  // ---------------------------------------------------------------- KV

  interface KVPutOptions {
    /** Seconds from now until the key expires. Must be at least 60, matching Cloudflare. */
    expirationTtl?: number;
    /** Absolute expiration as unix seconds. */
    expiration?: number;
  }

  interface KVNamespace {
    /** The stored string, or `null`. Synchronous before 2026-10-25 (a Promise from then). An expired key reads as absent. */
    get(key: string): string | null;
    put(key: string, value: string, options?: KVPutOptions): void;
    delete(key: string): void;
    /** Keys under `prefix` (all keys when omitted). Expired keys are omitted. */
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
    /** Rows as arrays of column values. */
    raw<T = unknown[]>(): T[];
  }

  interface D1Database {
    prepare(sql: string): D1PreparedStatement;
    batch(statements: D1PreparedStatement[]): D1Result[];
    /** Runs a whole script. Use this for multi-statement DDL. */
    exec(sql: string): void;
  }

  // ---------------------------------------------------------------- R2

  interface R2HttpMetadata {
    contentType?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
    cacheControl?: string;
  }

  interface R2Object {
    key: string;
    size: number;
    etag: string;
    /** `etag`, quoted, ready for an `ETag` response header. */
    httpEtag: string;
    uploaded: string;
    httpMetadata: R2HttpMetadata;
    customMetadata?: Record<string, string>;
    /**
     * The object as a string. A get holds the object whole in memory, so serve
     * large objects with `createDownloadUrl` instead.
     *
     * `new Response(obj.body, ...)` corrupts any non-ASCII/binary content: the
     * runtime cannot tell these bytes apart from a string a handler built, so
     * it UTF-8-encodes them a second time (baronunread/sproutboat#177). Use
     * `obj.toResponse()` instead for binary content — it serves the bytes
     * unmodified.
     */
    body: string;
    text(): string;
    json(): unknown;
    /**
     * A `Response` that serves `body` byte-for-byte, unlike `new
     * Response(obj.body, ...)` (see `body` above). `init.headers`/`.status`
     * merge in as usual; `content-type` defaults from `httpMetadata` and
     * `etag` from `httpEtag` when not set.
     */
    toResponse(init?: { status?: number; headers?: HeadersInit }): Response;
  }

  type R2ObjectHead = Omit<R2Object, "body" | "text" | "json" | "toResponse">;

  interface R2Objects {
    objects: R2ObjectHead[];
    truncated: boolean;
    cursor?: string;
  }

  interface R2PutOptions {
    httpMetadata?: R2HttpMetadata;
    customMetadata?: Record<string, string>;
  }

  interface R2ListOptions {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }

  interface R2UploadedPart {
    partNumber: number;
    etag: string;
  }

  interface R2MultipartUpload {
    key: string;
    uploadId: string;
    uploadPart(partNumber: number, value: string): R2UploadedPart;
    complete(parts: R2UploadedPart[]): R2ObjectHead;
    abort(): void;
  }

  interface R2TransferTicket {
    /** Same-origin reserved path. Send the file directly to this URL. */
    url: string;
    expiresAt: string;
  }

  interface R2UploadTicketOptions extends R2PutOptions {
    /** Maximum accepted body size in bytes. Default 100 MiB. */
    maxBytes?: number;
    /** Ticket lifetime in seconds, clamped to 30-3600. */
    expiresIn?: number;
    /** Optional lowercase hexadecimal SHA-256 checksum. */
    sha256?: string;
  }

  interface R2DownloadTicketOptions {
    expiresIn?: number;
  }

  interface R2Bucket {
    put(key: string, value: string, options?: R2PutOptions): void;
    /** Starts a resumable upload whose individual parts stay memory-bounded. */
    createMultipartUpload(key: string, options?: R2PutOptions): R2MultipartUpload;
    /** Reconstructs a multipart handle after storing its key and upload id. */
    resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
    /** Direct PUT to a one-use URL, streamed to storage without passing through the handler. */
    createUploadUrl(key: string, options?: R2UploadTicketOptions): R2TransferTicket;
    /** Direct GET or HEAD from a one-use URL, including Range. */
    createDownloadUrl(key: string, options?: R2DownloadTicketOptions): R2TransferTicket;
    get(key: string): R2Object | null;
    /** Metadata without the body. */
    head(key: string): R2ObjectHead | null;
    delete(key: string): void;
    list(options?: R2ListOptions): R2Objects;
  }

  // ------------------------------------------------------------ Queues

  type QueuesContentType = "json" | "text" | "bytes" | "v8";

  interface QueueSendOptions {
    delaySeconds?: number;
    /** From compatibility date 2026-10-31. */
    contentType?: QueuesContentType;
  }

  /** Cloudflare's QueueMetrics; `oldestMessageTimestamp` in ms since the epoch. */
  interface QueueMetrics {
    backlogCount: number;
    backlogBytes: number;
    oldestMessageTimestamp?: number;
  }

  interface QueueSendResult {
    metadata: { metrics: QueueMetrics };
  }

  /**
   * From compatibility date 2026-10-31, send() and sendBatch() return Promises of the queue's
   * backlog after the send, as on Workers; earlier dates return nothing at once.
   */
  interface Queue<Body = unknown> {
    send(body: Body, options?: QueueSendOptions): Promise<QueueSendResult>;
    sendBatch(
      messages: Iterable<{ body: Body; delaySeconds?: number; contentType?: QueuesContentType }>,
      options?: { delaySeconds?: number },
    ): Promise<QueueSendResult>;
    /** From compatibility date 2026-10-31. */
    metrics(): Promise<QueueMetrics>;
  }

  interface QueueRetryOptions {
    delaySeconds?: number;
  }

  interface QueueMessage<Body = unknown> {
    readonly id: string;
    /** When it was sent: a Date from compatibility date 2026-10-31, epoch ms before. */
    readonly timestamp: Date;
    readonly body: Body;
    /** 1 on the first delivery. */
    readonly attempts: number;
    /** Mark as handled. A message neither acked nor retried counts as acked (retried if queue() throws). */
    ack(): void;
    /** Hand it back for another attempt. The first of ack() and retry() wins. */
    retry(options?: QueueRetryOptions): void;
  }

  interface MessageBatch<Body = unknown> {
    /** The queue's name (`queue` in sproutboat.jsonc, else the binding name). */
    readonly queue: string;
    readonly messages: ReadonlyArray<QueueMessage<Body>>;
    /** From compatibility date 2026-10-31. */
    readonly metadata: { metrics: QueueMetrics };
    ackAll(): void;
    retryAll(options?: QueueRetryOptions): void;
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
    /**
     * The WebSocket hibernation API, from compatibility date 2026-10-30. Messages and
     * closes on an accepted socket go to the class's `webSocketMessage` and
     * `webSocketClose`. On sproutd an open socket keeps the app's worker running before
     * compatibility date 2026-11-01; from it the worker is reaped while the socket idles and
     * the object is constructed again (with `getWebSockets()` as it was) when a message or
     * close arrives.
     */
    acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
    getTags(ws: WebSocket): string[];
    setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
    getWebSocketAutoResponse(): WebSocketRequestResponsePair | null;
  }

  // ---------------------------------------------------------- WebSockets

  /**
   * From compatibility date 2026-10-30, as in workerd. Return the client end in a
   * `new Response(null, { status: 101, webSocket: client })` and talk on the server end.
   * Client sockets are carried by sproutd, and from compatibility date 2026-11-01 by
   * standalone and platform sprouts too (before it they answer a 101 with 501). Inbound
   * messages are capped at 32 MiB (1009 above it). From 2026-11-01 `new WebSocket(url,
   * protocols)` and `fetch(url, { headers: { Upgrade: "websocket" } })` connect out; the
   * Response's `webSocket` needs `accept()`, and returning it from a handler relays the client.
   * Outbound sockets need the embedded transport (standalone, sproutd), not `sproutboat dev`.
   */
  class WebSocketPair {
    0: WebSocket;
    1: WebSocket;
  }
  class WebSocketRequestResponsePair {
    constructor(request: string, response: string);
    readonly request: string;
    readonly response: string;
  }
  interface ResponseInit {
    webSocket?: WebSocket | null;
  }
  interface Response {
    readonly webSocket: WebSocket | null;
  }
  interface WebSocket {
    accept(): void;
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
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
   *
   * `resetAt` is epoch milliseconds for when the window rolls and the count
   * clears — the same for a hit or a miss. Turn a rejection into a header with
   * `Retry-After: Math.ceil((resetAt - Date.now()) / 1000)`.
   */
  interface RateLimit {
    limit(options: { key: string }): { success: boolean; resetAt: number };
  }

  // ------------------------------------ Crypto

  /**
   * `crypto.subtle` covers `digest` (SHA-256/384/512) and HMAC
   * `importKey` / `sign` / `verify`; other algorithms throw.
   *
   * `crypto.scryptVerify` is a Sproutboat extension (#153), not WebCrypto: it
   * re-derives a scrypt hash and compares it in constant time, for migrating
   * password hashes made by Node/Bun `scrypt`. Verify-only on purpose; derive
   * new credentials with HMAC via `crypto.subtle`.
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

  /** Work that outlives the response, drained in-process and capped at 25s. */
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
  }

  /**
   * The default export.
   */
  interface SproutboatHandler<QueueBody = unknown> {
    fetch(request: Request, ctx: ExecutionContext): Response | Promise<Response>;
    scheduled?(event: ScheduledEvent, ctx: ExecutionContext): void | Promise<void>;
    queue?(batch: MessageBatch<QueueBody>, ctx: ExecutionContext): void | Promise<void>;
  }

  /** Handler signature for compatibility dates from 2026-09-28. */
  interface WorkersHandler<Bindings = Record<string, unknown>, QueueBody = unknown> {
    fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response>;
    scheduled?(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): void | Promise<void>;
    queue?(batch: MessageBatch<QueueBody>, env: Bindings, ctx: ExecutionContext): void | Promise<void>;
  }

  /**
   * What a Durable Object class implements. Declare it above the default
   * export and name it in `durable_objects`.
   */
  interface DurableObject {
    fetch(request: Request): Response | Promise<Response>;
    /** Runs after `storage.setAlarm`, with no request in flight. */
    alarm?(): void | Promise<void>;
    /** A message on a socket taken with `state.acceptWebSocket` (from 2026-10-30). */
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
  }

  // ------------------------------------------------------- Version metadata

  /**
   * #126 — named by `version_metadata` in `sproutboat.jsonc`. Baked into the
   * binary at build time from the artifact's own digest: `id` matches the
   * `artifact` field `sproutboat versions list` prints for this build, `tag`
   * is the project name, `timestamp` is when it was built.
   */
  interface VersionMetadata {
    id: string;
    tag: string;
    timestamp: string;
  }
}

export {};
