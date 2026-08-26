import {
  Blocked,
  PolicyError,
  RateLimited,
  RebunoError,
  Terminated,
  ToolError,
} from "./errors.js";
import type { KernelClient } from "./kernel.js";
import type { StepDecision } from "./types.js";

type Idempotency = "safe_to_retry" | "at_most_once";
type StepKind = "tool_call" | "llm_call" | "local";

export interface ExecutionContextOptions {
  kernel: KernelClient;
  executionId: string;
  dispatchId: string;
  agentId: string;
  input: unknown;
  status?: string;
  signal?: AbortSignal;
}

/** One per dispatch. Submits effects to the kernel and applies its decisions. */
export class ExecutionContext {
  readonly id: string;
  readonly dispatchId: string;
  readonly agentId: string;
  readonly input: unknown;
  /** Aborted once a newer dispatch for this execution supersedes this run. */
  readonly signal: AbortSignal;
  status: string;
  /** The Blocked or Terminated this context threw, if any. */
  suspension: Blocked | Terminated | null = null;
  private kernel: KernelClient;

  constructor(o: ExecutionContextOptions) {
    this.kernel = o.kernel;
    this.id = o.executionId;
    this.dispatchId = o.dispatchId;
    this.agentId = o.agentId;
    this.input = o.input;
    this.signal = o.signal ?? new AbortController().signal;
    this.status = o.status ?? "running";
  }

  /**
   * Ask the kernel to decide this effect, and return `(stepId, decision)`.
   *
   * The kernel assigns the step id: it counts occurrences of this effect within
   * the dispatch under its own lock, so concurrent identical calls get distinct
   * steps without any coordination here. `stepId` is empty for decisions that
   * recorded no step (`rate_limited`, `execution_*`), which
   * {@link raiseForDecision} turns into an exception before it is used.
   */
  private async submit(p: {
    kind: string;
    target: string;
    args: unknown;
    idempotency: string;
  }): Promise<{ stepId: string; dec: StepDecision }> {
    const dec = await this.kernel.submitStep(this.id, {
      ...p,
      dispatchId: this.dispatchId,
    });
    return { stepId: dec.stepId, dec };
  }

  private raiseForDecision(dec: StepDecision): void {
    switch (dec.decision) {
      case "denied":
        throw new PolicyError(dec.reason || "policy_denied");
      case "rate_limited":
        throw new RateLimited(dec.reason || "rate_limit_exceeded");
      case "blocked":
      case "execution_blocked":
        this.suspension = new Blocked();
        throw this.suspension;
      case "execution_terminal":
        this.suspension = new Terminated("execution is terminal");
        throw this.suspension;
      case "proceed":
        return;
      default:
        throw new RebunoError(`unexpected step decision: ${dec.decision}`);
    }
  }

  /**
   * Renew the dispatch lease until the returned stop function is called, so the
   * kernel doesn't reclaim the dispatch and re-deliver it to a second handler.
   *
   * The renewed body must yield to the event loop for the heartbeat to fire — a
   * fully blocking body starves it. Everything long in a handler (LLM/provider
   * calls, MCP tools, kernel round-trips) is I/O-bound and async, so this holds.
   * A superseded run stops renewing: the lease belongs to the newer dispatch.
   */
  startHeartbeat(intervalMs = 30000): () => void {
    const hb = setInterval(() => {
      if (this.signal.aborted) {
        clearInterval(hb);
        return;
      }
      void this.kernel.heartbeat(this.id).catch(() => {});
    }, intervalMs);
    return () => clearInterval(hb);
  }

  async invokeTool(
    target: string,
    args: Record<string, unknown>,
    opts: {
      idempotency?: Idempotency;
      run?: () => Promise<unknown>;
      kind?: StepKind;
    } = {},
  ): Promise<unknown> {
    const idempotency = opts.idempotency ?? "safe_to_retry";
    const kind = opts.kind ?? "tool_call";
    const { stepId, dec } = await this.submit({
      kind,
      target,
      args,
      idempotency,
    });

    if (dec.decision === "replay") {
      if (dec.error != null)
        throw new ToolError(errorMessage(dec.error), {
          toolId: target,
          stepId,
        });
      return dec.result;
    }
    this.raiseForDecision(dec);

    if (!opts.run) {
      await this.kernel.completeStep(this.id, stepId, null);
      return null;
    }
    let result: unknown;
    try {
      result = await opts.run();
    } catch (e) {
      if (
        e instanceof Blocked ||
        e instanceof Terminated ||
        e instanceof PolicyError ||
        e instanceof RateLimited
      )
        throw e;
      await this.failStepQuietly(stepId, e);
      if (e instanceof ToolError) throw e;
      throw new ToolError(String(e instanceof Error ? e.message : e), {
        toolId: target,
        stepId,
      });
    }
    await this.kernel.completeStep(this.id, stepId, result);
    return result;
  }

  /** Submit an `llm_call` step. Returns `(stepId, decision)`: `proceed` (run the
   * provider call, then record it via {@link recordLlm}) or `replay` (rebuild the
   * response from `decision.result`). Other decisions raise the matching error. */
  async beginLlm(
    target: string,
    request: unknown,
  ): Promise<{ stepId: string; dec: StepDecision }> {
    const { stepId, dec } = await this.submit({
      kind: "llm_call",
      target,
      args: request,
      idempotency: "safe_to_retry",
    });
    if (dec.decision === "replay") {
      if (dec.error != null) throw new RebunoError(errorMessage(dec.error));
      return { stepId, dec };
    }
    this.raiseForDecision(dec);
    return { stepId, dec };
  }

  /** Publish a live delta for an in-flight streamed step. Best-effort: deltas are
   * advisory, so failures are swallowed — the recorded whole is the durable result. */
  async publishLlmDelta(
    stepId: string,
    seq: number,
    data: string,
  ): Promise<void> {
    try {
      await this.kernel.streamDelta(this.id, stepId, seq, data);
    } catch {
      /* best effort */
    }
  }

  /** Record the assembled (streamed or whole) response as the step's durable result. */
  async recordLlm(stepId: string, result: unknown): Promise<void> {
    await this.kernel.completeStep(this.id, stepId, result);
  }

  async failStepQuietly(stepId: string, error: unknown): Promise<void> {
    try {
      await this.kernel.failStep(this.id, stepId, {
        message: String(error instanceof Error ? error.message : error),
      });
    } catch {
      /* best effort */
    }
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    return String(o.message ?? o.reason ?? JSON.stringify(o));
  }
  return String(error);
}
