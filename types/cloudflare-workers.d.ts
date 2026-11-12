/**
 * The `cloudflare:workers` module, as the runtime provides it: the base classes Workers code extends and the
 * `env` import. A script file on purpose: an ambient `declare module` is only a declaration here, not an
 * augmentation. `sproutboat.d.ts` references it, so the one reference a project's generated file carries is enough.
 *
 * `Cloudflare.Env` is declared by the project's `worker-configuration.d.ts`.
 */
/// <reference path="./sproutboat.d.ts" />

declare module "cloudflare:workers" {
  /** The bindings of this project, same object as the second handler argument. */
  export const env: Cloudflare.Env;

  /**
   * A Durable Object class, from compatibility date 2026-10-29 (2026-10-28 for the Promise storage): `this.ctx` and
   * `this.env` are set, and any method is callable as `await stub.method()`.
   */
  export abstract class DurableObject<Bindings = Cloudflare.Env> {
    constructor(ctx: DurableObjectStateAsync, env: Bindings);
    protected ctx: DurableObjectStateAsync;
    protected env: Bindings;
    fetch?(request: Request): Response | Promise<Response>;
    /** Runs after `storage.setAlarm`, with no request in flight. */
    alarm?(info?: { retryCount: number; isRetry: boolean }): void | Promise<void>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
  }

  /**
   * A Worker as a class: `export default class extends WorkerEntrypoint<Env>`. Its methods are what a service
   * binding calls over RPC (from compatibility date 2026-11-18).
   */
  export abstract class WorkerEntrypoint<Bindings = Cloudflare.Env> {
    constructor(ctx: ExecutionContext, env: Bindings);
    protected ctx: ExecutionContext;
    protected env: Bindings;
    fetch?(request: Request): Response | Promise<Response>;
    scheduled?(controller: ScheduledController): void | Promise<void>;
    queue?(batch: MessageBatch): void | Promise<void>;
  }

  export class RpcTarget {}
}
