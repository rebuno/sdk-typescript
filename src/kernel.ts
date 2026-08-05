import { signBody } from "./crypto.js";
import {
  errorFromResponse,
  NetworkError,
  NotFoundError,
  Terminated,
} from "./errors.js";
import {
  type Execution,
  parseExecution,
  parseStep,
  parseStepDecision,
  type Step,
  type StepDecision,
} from "./types.js";

export type FetchFn = typeof fetch;

export interface KernelClientOptions {
  agentId: string;
  secret: string;
  baseUrl: string;
  timeout?: number;
  fetch?: FetchFn;
  signal?: AbortSignal;
}

const enc = (s: string) => new TextEncoder().encode(s);
const EMPTY = new Uint8Array(0);

export class KernelClient {
  private agentId: string;
  private secret: string;
  private baseUrl: string;
  private timeout: number;
  private fetchImpl: FetchFn;
  private signal?: AbortSignal;

  constructor(opts: KernelClientOptions) {
    this.agentId = opts.agentId;
    this.secret = opts.secret;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeout = opts.timeout ?? 35000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.signal = opts.signal;
  }

  /** A view of this client scoped to one run: once `signal` aborts, the run no
   * longer owns its dispatch and every kernel call it makes is refused. */
  withSignal(signal: AbortSignal): KernelClient {
    return new KernelClient({
      agentId: this.agentId,
      secret: this.secret,
      baseUrl: this.baseUrl,
      timeout: this.timeout,
      fetch: this.fetchImpl,
      signal,
    });
  }

  private async send(
    method: string,
    path: string,
    body: Uint8Array,
    extra?: Record<string, string>,
  ): Promise<Response> {
    if (this.signal?.aborted)
      throw new Terminated("superseded by a newer dispatch");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Rebuno-Agent-Id": this.agentId,
      "Rebuno-Signature": await signBody(this.secret, body),
      ...extra,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: method === "GET" ? undefined : (body as BodyInit),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new NetworkError(String(e));
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 400) throw await errorFromResp(resp);
    return resp;
  }

  async getExecution(executionId: string): Promise<Execution> {
    const r = await this.send("GET", `/v0/executions/${executionId}`, EMPTY);
    return parseExecution(await r.json());
  }

  async getStep(executionId: string, stepId: string): Promise<Step | null> {
    try {
      const r = await this.send(
        "GET",
        `/v0/executions/${executionId}/steps/${stepId}`,
        EMPTY,
      );
      return parseStep(await r.json());
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  async submitStep(
    executionId: string,
    p: {
      kind: string;
      target: string;
      args: unknown;
      idempotency: string;
      dispatchId: string;
    },
  ): Promise<StepDecision> {
    const body = enc(
      JSON.stringify({
        kind: p.kind,
        target: p.target,
        args: p.args,
        idempotency: p.idempotency,
      }),
    );
    const r = await this.send(
      "POST",
      `/v0/executions/${executionId}/steps`,
      body,
      {
        "Rebuno-Dispatch-Id": p.dispatchId,
      },
    );
    return parseStepDecision(await r.json());
  }

  async completeStep(
    executionId: string,
    stepId: string,
    result: unknown,
  ): Promise<void> {
    await this.send(
      "POST",
      `/v0/executions/${executionId}/steps/${stepId}/complete`,
      enc(JSON.stringify({ result })),
    );
  }

  async failStep(
    executionId: string,
    stepId: string,
    error: unknown,
  ): Promise<void> {
    await this.send(
      "POST",
      `/v0/executions/${executionId}/steps/${stepId}/fail`,
      enc(JSON.stringify({ error })),
    );
  }

  async streamDelta(
    executionId: string,
    stepId: string,
    seq: number,
    data: string,
  ): Promise<void> {
    await this.send(
      "POST",
      `/v0/executions/${executionId}/steps/${stepId}/stream`,
      enc(JSON.stringify({ seq, data })),
    );
  }

  async heartbeat(executionId: string): Promise<void> {
    await this.send("POST", `/v0/executions/${executionId}/heartbeat`, EMPTY);
  }

  async completeExecution(executionId: string, output: unknown): Promise<void> {
    await this.send(
      "POST",
      `/v0/executions/${executionId}/complete`,
      enc(JSON.stringify({ output })),
    );
  }

  async failExecution(executionId: string, error: string): Promise<void> {
    await this.send(
      "POST",
      `/v0/executions/${executionId}/fail`,
      enc(JSON.stringify({ error })),
    );
  }
}

async function errorFromResp(resp: Response): Promise<Error> {
  const text = await resp.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  const code = (data.code as string) ?? "internal_error";
  const message = (data.message as string) ?? (text || "request failed");
  return errorFromResponse(
    code,
    message,
    resp.status,
    (data.rule_id as string) ?? "",
  );
}
