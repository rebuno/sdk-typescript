import { KernelClient, type FetchFn } from "./kernel.js";
import { ExecutionContext } from "./execution.js";
import { runWithContext } from "./context.js";
import { Blocked, PolicyError, RateLimited, Terminated, ToolError } from "./errors.js";

/** Minimal Standard Schema v1 shape we consume for optional input validation. */
interface StandardSchema {
  "~standard": {
    validate: (value: unknown) =>
      | { value: unknown; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string }> }
      | Promise<{ value: unknown; issues?: undefined } | { issues: ReadonlyArray<{ message: string }> }>;
  };
}

export type ProcessFn<TInput = any, TOutput = unknown> = (input: TInput) => TOutput | Promise<TOutput>;

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
  private tasks = new Set<Promise<void>>();

  constructor(agentId: string, opts: AgentOptions = {}) {
    if (!agentId) throw new Error("agentId must not be empty");
    this.agentId = agentId;
    this.secret = opts.secret ?? process.env.REBUNO_AGENT_SECRET ?? "";
    if (!this.secret) throw new Error("secret required (set REBUNO_AGENT_SECRET or pass secret)");
    this.baseUrl = (opts.baseUrl ?? process.env.REBUNO_URL ?? "").replace(/\/+$/, "");
    if (!this.baseUrl) throw new Error("baseUrl required (set REBUNO_URL or pass baseUrl)");
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
    if (!(await verifySignature(this.secret, raw, sig))) return new Response(null, { status: 401 });
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { payload = null; }
    const executionId = payload?.execution_id as string | undefined;
    const dispatchId = payload?.dispatch_id as string | undefined;
    if (!executionId || !dispatchId) return new Response(null, { status: 400 });
    const task = this.safeHandle(executionId, dispatchId);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return new Response(null, { status: 200 });
  };

  private async safeHandle(executionId: string, dispatchId: string): Promise<void> {
    try {
      await this.handle(executionId, dispatchId);
    } catch (e) {
      if (e instanceof Blocked || e instanceof Terminated) return;
      console.error(`rebuno: unhandled error handling execution ${executionId}`, e);
    }
  }

  private async handle(executionId: string, dispatchId: string): Promise<void> {
    if (!this.process) throw new Error("Agent.bind(process) was not called");
    const exec = await this.kernel.getExecution(executionId);
    if (exec.status === "completed" || exec.status === "failed" || exec.status === "cancelled") return;

    const ctx = new ExecutionContext({
      kernel: this.kernel,
      executionId,
      dispatchId,
      agentId: this.agentId,
      input: exec.input,
      status: exec.status,
    });

    await runWithContext(ctx, async () => {
      let input = exec.input;
      if (this.inputSchema) {
        const res = await this.inputSchema["~standard"].validate(input);
        if ("issues" in res && res.issues) {
          const msg = res.issues.map((i) => i.message).join("; ");
          await this.kernel.failExecution(executionId, `input validation failed: ${msg}`);
          return;
        }
        input = (res as { value: unknown }).value;
      }
      let output: unknown;
      try {
        output = await this.process!(input as TInput);
      } catch (e) {
        if (e instanceof Blocked || e instanceof Terminated) throw e;
        if (e instanceof PolicyError || e instanceof ToolError || e instanceof RateLimited) {
          await this.kernel.failExecution(executionId, String(e instanceof Error ? e.message : e));
          return;
        }
        console.error(`rebuno: process error execution_id=${executionId}`, e);
        await this.kernel.failExecution(executionId, String(e instanceof Error ? e.message : e));
        return;
      }
      await this.kernel.completeExecution(executionId, output);
    });
  }

  /** Wait for all in-flight execution handlers to finish (best-effort). */
  async join(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }

  async close(): Promise<void> {
    await this.join();
  }

  /** Bind the process and serve the webhook app with node:http (blocking-ish; resolves on server close). */
  async serve(opts: ServeOptions, process?: ProcessFn<TInput, TOutput>): Promise<void> {
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
          v == null ? [] : Array.isArray(v) ? v.map((vv) => [k, vv] as [string, string]) : [[k, v] as [string, string]],
        ),
        body,
      });
      const response = await this.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "0.0.0.0", resolve));
    console.log(`rebuno agent '${this.agentId}' listening on ${opts.host ?? "0.0.0.0"}:${opts.port}${this.webhookPath}`);
    await new Promise<void>((resolve) => server.on("close", resolve));
  }
}
