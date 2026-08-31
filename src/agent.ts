import { runWithContext } from "./context.js";
import {
  Blocked,
  failureReason,
  LeaseSuperseded,
  PolicyError,
  RateLimited,
  raiseForRefusal,
  Terminated,
  ToolError,
} from "./errors.js";
import { ExecutionContext } from "./execution.js";
import { type DispatchLease, type FetchFn, KernelClient } from "./kernel.js";

/** Minimal Standard Schema v1 shape we consume for optional input validation. */
interface StandardSchema {
  "~standard": {
    validate: (
      value: unknown,
    ) =>
      | { value: unknown; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string }> }
      | Promise<
          | { value: unknown; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string }> }
        >;
  };
}

export type ProcessFn<TInput = any, TOutput = unknown> = (
  input: TInput,
) => TOutput | Promise<TOutput>;

export interface AgentOptions {
  secret?: string;
  baseUrl?: string;
  webhookPath?: string;
  kernelTimeout?: number;
  inputSchema?: StandardSchema;
  fetch?: FetchFn;
}

export interface ServeOptions {
  host?: string;
  port: number;
}

export class Agent<TInput = any, TOutput = unknown> {
  readonly agentId: string;
  private secret: string;
  private baseUrl: string;
  readonly webhookPath: string;
  private inputSchema?: StandardSchema;
  private kernel: KernelClient;
  private process?: ProcessFn<TInput, TOutput>;
  private tasks = new Map<
    string,
    { lease: DispatchLease; promise: Promise<void>; ctrl: AbortController }
  >();

  constructor(agentId: string, opts: AgentOptions = {}) {
    if (!agentId) throw new Error("agentId must not be empty");
    this.agentId = agentId;
    this.secret = opts.secret ?? process.env.REBUNO_AGENT_SECRET ?? "";
    if (!this.secret)
      throw new Error(
        "secret required (set REBUNO_AGENT_SECRET or pass secret)",
      );
    this.baseUrl = (opts.baseUrl ?? process.env.REBUNO_URL ?? "").replace(
      /\/+$/,
      "",
    );
    if (!this.baseUrl)
      throw new Error("baseUrl required (set REBUNO_URL or pass baseUrl)");
    this.webhookPath = opts.webhookPath ?? "/webhook";
    this.inputSchema = opts.inputSchema;
    this.kernel = new KernelClient({
      agentId,
      secret: this.secret,
      baseUrl: this.baseUrl,
      timeout: opts.kernelTimeout ?? 35000,
      fetch: opts.fetch,
    });
  }

  bind(process: ProcessFn<TInput, TOutput>): void {
    this.process = process;
  }

  fetch = async (request: Request): Promise<Response> => {
    const raw = new Uint8Array(await request.arrayBuffer());
    const sig = request.headers.get("Rebuno-Signature") ?? "";
    const { verifySignature } = await import("./crypto.js");
    if (!(await verifySignature(this.secret, raw, sig)))
      return new Response(null, { status: 401 });
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      payload = null;
    }
    const executionId = payload?.execution_id as string | undefined;
    const lease = leaseFrom(payload);
    if (!executionId || !lease) return new Response(null, { status: 400 });

    const running = this.tasks.get(executionId);
    if (running) {
      // Attempts only order within a dispatch, so a repeat of the one running,
      // or of one the kernel has moved past, is ignored. A different dispatch is
      // fresh work and replaces what came before.
      if (
        lease.dispatchId === running.lease.dispatchId &&
        lease.attempt <= running.lease.attempt
      )
        return new Response(null, { status: 200 });
      running.ctrl.abort();
    }
    const ctrl = new AbortController();
    const entry = {
      lease,
      promise: this.safeHandle(executionId, lease, ctrl),
      ctrl,
    };
    this.tasks.set(executionId, entry);
    void entry.promise.finally(() => {
      if (this.tasks.get(executionId) === entry) this.tasks.delete(executionId);
    });
    return new Response(null, { status: 200 });
  };

  private async safeHandle(
    executionId: string,
    lease: DispatchLease,
    ctrl: AbortController,
  ): Promise<void> {
    try {
      await this.handle(executionId, lease, ctrl);
    } catch (e) {
      if (
        e instanceof Blocked ||
        e instanceof Terminated ||
        e instanceof LeaseSuperseded
      )
        return;
      console.error(
        `rebuno: unhandled error handling execution ${executionId}`,
        e,
      );
    }
  }

  private async handle(
    executionId: string,
    lease: DispatchLease,
    ctrl: AbortController,
  ): Promise<void> {
    if (!this.process) throw new Error("Agent.bind(process) was not called");
    // Scoped to this run: once superseded, its kernel calls are refused, so it
    // can neither renew the lease nor write for a dispatch it no longer owns.
    const kernel = this.kernel.withSignal(ctrl.signal);
    const exec = await kernel.getExecution(executionId);
    if (
      exec.status === "completed" ||
      exec.status === "failed" ||
      exec.status === "cancelled"
    )
      return;

    const ctx = new ExecutionContext({
      kernel,
      executionId,
      lease,
      agentId: this.agentId,
      input: exec.input,
      status: exec.status,
      controller: ctrl,
    });

    await runWithContext(ctx, async () => {
      let input = exec.input;
      if (this.inputSchema) {
        const res = await this.inputSchema["~standard"].validate(input);
        if ("issues" in res && res.issues) {
          const msg = res.issues.map((i) => i.message).join("; ");
          await kernel.failExecution(
            executionId,
            `input_invalid: ${msg}`,
            lease,
          );
          return;
        }
        input = (res as { value: unknown }).value;
      }
      let output: unknown;
      const stopLease = ctx.startHeartbeat();
      try {
        output = await this.process!(input as TInput);
        if (ctx.suspension) throw ctx.suspension;
      } catch (e) {
        if (
          e instanceof Blocked ||
          e instanceof Terminated ||
          e instanceof LeaseSuperseded
        )
          throw e;
        if (ctx.suspension) throw ctx.suspension;
        // Blocked and Terminated propagate; a denial or rate limit is rebound
        // onto e and fails the execution below.
        try {
          raiseForRefusal(e);
        } catch (refused) {
          if (
            refused instanceof Blocked ||
            refused instanceof Terminated ||
            refused instanceof LeaseSuperseded
          )
            throw refused;
          e = refused;
        }
        if (
          !(
            e instanceof PolicyError ||
            e instanceof ToolError ||
            e instanceof RateLimited
          )
        )
          console.error(`rebuno: process error execution_id=${executionId}`, e);
        await kernel.failExecution(executionId, failureReason(e), lease);
        return;
      } finally {
        stopLease();
      }
      await kernel.completeExecution(executionId, output, lease);
    });
  }

  /** Wait for all in-flight execution handlers to finish (best-effort). */
  async join(): Promise<void> {
    await Promise.allSettled([...this.tasks.values()].map((t) => t.promise));
  }

  async close(): Promise<void> {
    await this.join();
  }

  /** Bind the process and serve the webhook app with node:http (blocking-ish; resolves on server close). */
  async serve(
    opts: ServeOptions,
    process?: ProcessFn<TInput, TOutput>,
  ): Promise<void> {
    if (process) this.bind(process);
    const { createServer } = await import("node:http");
    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== this.webhookPath) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const request = new Request(`http://localhost${req.url}`, {
        method: "POST",
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          v == null
            ? []
            : Array.isArray(v)
              ? v.map((vv) => [k, vv] as [string, string])
              : [[k, v] as [string, string]],
        ),
        body,
      });
      const response = await this.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) =>
      server.listen(opts.port, opts.host ?? "0.0.0.0", resolve),
    );
    console.log(
      `rebuno agent '${this.agentId}' listening on ${opts.host ?? "0.0.0.0"}:${opts.port}${this.webhookPath}`,
    );
    await new Promise<void>((resolve) => server.on("close", resolve));
  }
}

/** The lease a webhook carries, or null if it is unusable. */
function leaseFrom(
  payload: Record<string, unknown> | null,
): DispatchLease | null {
  const dispatchId = payload?.dispatch_id;
  const attempt = payload?.dispatch_attempt;
  if (typeof dispatchId !== "string" || !dispatchId) return null;
  if (!Number.isInteger(attempt) || (attempt as number) <= 0) return null;
  return { dispatchId, attempt: attempt as number };
}
