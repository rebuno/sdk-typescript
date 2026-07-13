import { argsHash, computeStepId } from "./identity.js";
import {
  Blocked, PolicyError, RateLimited, RebunoError, Terminated, ToolError,
} from "./errors.js";
import type { KernelClient } from "./kernel.js";
import type { Step, StepDecision } from "./types.js";

type Idempotency = "safe_to_retry" | "at_most_once";

export interface ExecutionContextOptions {
  kernel: KernelClient;
  executionId: string;
  agentId: string;
  input: unknown;
  status?: string;
}

/** One per dispatch. Drives effect submission, replay, and occurrence counting. */
export class ExecutionContext {
  readonly id: string;
  readonly agentId: string;
  readonly input: unknown;
  status: string;
  private kernel: KernelClient;
  private occurrences = new Map<string, number>();
  private replay: Map<string, Step> | null = null;

  constructor(o: ExecutionContextOptions) {
    this.kernel = o.kernel;
    this.id = o.executionId;
    this.agentId = o.agentId;
    this.input = o.input;
    this.status = o.status ?? "running";
  }

  /** Preload terminal steps so replay is one bulk read, not a round trip per step. */
  async hydrate(): Promise<void> {
    try {
      const steps = await this.kernel.listTerminalSteps(this.id);
      this.replay = new Map(steps.map((s) => [s.stepId, s]));
    } catch {
      this.replay = null; // fall back to per-step replay
    }
  }

  private async decide(p: { kind: string; target: string; args: unknown; idempotency: string; stepId: string }): Promise<StepDecision> {
    if (this.replay) {
      const hit = this.replay.get(p.stepId);
      if (hit) return decisionFromStep(hit);
    }
    return this.kernel.submitStep(this.id, p);
  }

  private nextOccurrence(kind: string, target: string, ah: string): number {
    const key = `${kind} ${target} ${ah}`;
    const n = this.occurrences.get(key) ?? 0;
    this.occurrences.set(key, n + 1);
    return n;
  }

  private raiseForDecision(dec: StepDecision): void {
    switch (dec.decision) {
      case "denied": throw new PolicyError(dec.reason || "denied by policy");
      case "rate_limited": throw new RateLimited(dec.reason || "rate_limit_exceeded");
      case "blocked":
      case "execution_blocked": throw new Blocked(dec.approvalId);
      case "execution_terminal": throw new Terminated("execution is terminal");
      case "proceed": return;
      default: throw new RebunoError(`unexpected step decision: ${dec.decision}`);
    }
  }

  private async runWithHeartbeat<T>(run: () => Promise<T>, intervalMs = 30000): Promise<T> {
    const hb = setInterval(() => { void this.kernel.heartbeat(this.id).catch(() => {}); }, intervalMs);
    try {
      return await run();
    } finally {
      clearInterval(hb);
    }
  }

  async invokeTool(
    target: string,
    args: Record<string, unknown>,
    opts: { idempotency?: Idempotency; run?: () => Promise<unknown> } = {},
  ): Promise<unknown> {
    const idempotency = opts.idempotency ?? "safe_to_retry";
    const kind = "tool_call";
    const ah = argsHash(args);
    const occ = this.nextOccurrence(kind, target, ah);
    const stepId = computeStepId(this.id, kind, target, ah, occ);

    const dec = await this.decide({ kind, target, args, idempotency, stepId });

    if (dec.decision === "replay") {
      if (dec.error != null) throw new ToolError(errorMessage(dec.error), { toolId: target, stepId });
      return dec.result;
    }
    this.raiseForDecision(dec);

    if (!opts.run) {
      await this.kernel.completeStep(this.id, stepId, null);
      return null;
    }
    let result: unknown;
    try {
      result = await this.runWithHeartbeat(opts.run);
    } catch (e) {
      if (e instanceof Blocked || e instanceof Terminated || e instanceof PolicyError || e instanceof RateLimited) throw e;
      await this.failStepQuietly(stepId, e);
      if (e instanceof ToolError) throw e;
      throw new ToolError(String(e instanceof Error ? e.message : e), { toolId: target, stepId });
    }
    await this.kernel.completeStep(this.id, stepId, result);
    return result;
  }

  async invokeLlm(target: string, request: unknown, opts: { run: () => Promise<unknown> }): Promise<unknown> {
    const kind = "llm_call";
    const ah = argsHash(request);
    const occ = this.nextOccurrence(kind, target, ah);
    const stepId = computeStepId(this.id, kind, target, ah, occ);

    const dec = await this.decide({ kind, target, args: request, idempotency: "safe_to_retry", stepId });

    if (dec.decision === "replay") {
      if (dec.error != null) throw new RebunoError(errorMessage(dec.error));
      return dec.result;
    }
    this.raiseForDecision(dec);

    let result: unknown;
    try {
      result = await this.runWithHeartbeat(opts.run);
    } catch (e) {
      if (e instanceof Blocked || e instanceof Terminated || e instanceof PolicyError || e instanceof RateLimited) throw e;
      await this.failStepQuietly(stepId, e);
      throw e;
    }
    await this.kernel.completeStep(this.id, stepId, result);
    return result;
  }

  private async failStepQuietly(stepId: string, error: unknown): Promise<void> {
    try {
      await this.kernel.failStep(this.id, stepId, { message: String(error instanceof Error ? error.message : error) });
    } catch { /* best effort */ }
  }
}

function decisionFromStep(step: Step): StepDecision {
  if (step.status === "succeeded") return { decision: "replay", result: step.result, error: null, approvalId: null, reason: "" };
  if (step.status === "failed") return { decision: "replay", result: null, error: step.error, approvalId: null, reason: "" };
  if (step.status === "denied") return { decision: "denied", result: null, error: null, approvalId: null, reason: "policy_denied" };
  return { decision: "proceed", result: null, error: null, approvalId: null, reason: "" };
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    return String(o.message ?? o.reason ?? JSON.stringify(o));
  }
  return String(error);
}
