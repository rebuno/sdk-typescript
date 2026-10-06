import { runInStep } from "./context.js";
import {
  Blocked,
  LeaseSuperseded,
  PolicyError,
  RateLimited,
  RebunoError,
  Terminated,
  ToolError,
} from "./errors.js";
import {
  type CheckpointRecords,
  type DispatchLease,
  heartbeatIntervalMs,
  type KernelClient,
  type ResourceRegistration,
} from "./kernel.js";
import type { ResourceOptions } from "./resource.js";
import type { StepDecision, StepResource } from "./types.js";

type Idempotency = "safe_to_retry" | "at_most_once";
type StepKind = "tool_call" | "llm_call" | "local";

export class Result<TOutput = unknown, TState = unknown> {
  readonly output: TOutput;
  readonly state?: TState;

  constructor(o: { output: TOutput; state?: TState }) {
    this.output = o.output;
    this.state = o.state;
  }
}

export interface ExecutionContextOptions {
  kernel: KernelClient;
  executionId: string;
  lease: DispatchLease;
  agentId: string;
  input: unknown;
  status?: string;
  controller?: AbortController;
}

/** One per dispatch. Submits effects to the kernel and applies its decisions. */
export class ExecutionContext {
  readonly id: string;
  readonly dispatchId: string;
  readonly dispatchAttempt: number;
  readonly agentId: string;
  readonly input: unknown;
  status: string;
  suspension: Blocked | Terminated | null = null;
  private kernel: KernelClient;
  private lease: DispatchLease;
  private ctrl: AbortController;
  private resources = new Map<
    string,
    {
      handle: unknown;
      checkpoint?: () => string | Promise<string>;
      registration: ResourceRegistration;
    }
  >();
  private effectsHeld = false;
  private effectsQueue: (() => void)[] = [];
  private effectsHolder: string | undefined;
  private inFlight = 0;
  private waiting: {
    resolve: (suspended: boolean) => void;
    reject: (e: unknown) => void;
  }[] = [];

  constructor(o: ExecutionContextOptions) {
    this.kernel = o.kernel;
    this.id = o.executionId;
    this.lease = o.lease;
    this.dispatchId = o.lease.dispatchId;
    this.dispatchAttempt = o.lease.attempt;
    this.agentId = o.agentId;
    this.input = o.input;
    this.ctrl = o.controller ?? new AbortController();
    this.status = o.status ?? "running";
  }

  previous(): Promise<unknown> {
    return this.kernel.previousState(this.id);
  }

  /** Aborted once a newer dispatch for this execution supersedes this run. */
  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  private async exclusive<T>(run: () => Promise<T>, needed = true): Promise<T> {
    if (!needed) return run();
    await this.acquireEffects();
    try {
      return await run();
    } finally {
      this.releaseEffects();
    }
  }

  private acquireEffects(): Promise<void> {
    if (!this.effectsHeld) {
      this.effectsHeld = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.effectsQueue.push(resolve));
  }

  private releaseEffects(): void {
    this.effectsHolder = undefined;
    const next = this.effectsQueue.shift();
    if (next) next();
    else this.effectsHeld = false;
  }

  async registerResource<THandle, TBinding>(
    key: string,
    opts: ResourceOptions<THandle, TBinding>,
  ): Promise<THandle> {
    return this.exclusive(async () => {
      const cached = this.resources.get(key);
      if (cached) return cached.handle as THandle;
      const { driver, checkpoints } = opts;
      const everySteps = checkpoints ? (checkpoints.everySteps ?? 1) : 0;
      if (checkpoints && (!Number.isInteger(everySteps) || everySteps < 1))
        throw new RangeError("everySteps must be a positive integer");
      const registration = {
        key,
        driverId: driver.driverId,
        configuration: driver.configuration ?? null,
        coverageReuse: driver.coverageReuse ?? false,
        everySteps,
        onCompletion: checkpoints ? (checkpoints.onCompletion ?? true) : false,
      };
      const view = await this.kernel.registerResource(
        this.id,
        registration,
        this.lease,
      );
      if (view.everySteps && !driver.checkpoint)
        throw new RebunoError("checkpoint policy requires driver.checkpoint()");
      let handle: THandle;
      if (view.binding !== null) {
        handle = await driver.open(view.binding as TBinding);
      } else {
        const created = await driver.create(view.checkpointRef || undefined);
        handle = created.handle;
        await this.kernel.bindResource(
          this.id,
          key,
          created.binding,
          this.lease,
        );
      }
      this.resources.set(key, {
        handle,
        checkpoint: driver.checkpoint?.bind(driver, handle),
        registration,
      });
      if (view.everySteps && !view.covered) {
        const records = await this.capture([
          { key, generation: view.generation, due: true },
        ]);
        await this.kernel.publishCheckpoints(this.id, records, this.lease);
      }
      return handle;
    });
  }

  private async capture(due: StepResource[]): Promise<CheckpointRecords> {
    const records: CheckpointRecords = {};
    for (const r of due) {
      try {
        const managed = this.resources.get(r.key);
        if (!managed)
          throw new RebunoError("resource() was not called in this dispatch");
        if (!managed.checkpoint)
          throw new RebunoError(
            "resource driver does not implement checkpoint()",
          );
        const checkpointRef = await managed.checkpoint();
        records.captures ??= [];
        records.captures.push({
          key: r.key,
          generation: r.generation,
          checkpointRef,
        });
      } catch (e) {
        if (
          e instanceof Blocked ||
          e instanceof Terminated ||
          e instanceof PolicyError ||
          e instanceof RateLimited ||
          e instanceof LeaseSuperseded
        )
          throw e;
        console.warn(`rebuno: checkpoint of resource '${r.key}' failed`, e);
        records.captureFailures ??= [];
        records.captureFailures.push({
          key: r.key,
          generation: r.generation,
          error: String(e instanceof Error ? e.message || e.name : e),
        });
      }
    }
    return records;
  }

  async checkpointOnCompletion(): Promise<void> {
    if (!this.resources.size) return;
    try {
      await this.exclusive(async () => {
        const due: StepResource[] = [];
        for (const { registration } of this.resources.values()) {
          const view = await this.kernel.registerResource(
            this.id,
            registration,
            this.lease,
          );
          if (view.onCompletion && !view.covered)
            due.push({ key: view.key, generation: view.generation, due: true });
        }
        if (due.length) {
          const records = await this.capture(due);
          await this.kernel.publishCheckpoints(this.id, records, this.lease);
        }
      });
    } catch (e) {
      if (
        e instanceof Blocked ||
        e instanceof Terminated ||
        e instanceof PolicyError ||
        e instanceof RateLimited ||
        e instanceof LeaseSuperseded
      )
        throw e;
      console.warn("rebuno: checkpoint on completion failed", e);
    }
  }

  /** Resolves once every in-flight call waits, with whether the execution
   * suspended. */
  private awaitIdle(): Promise<boolean> {
    const idle = new Promise<boolean>((resolve, reject) =>
      this.waiting.push({ resolve, reject }),
    );
    void this.suspendIfIdle();
    return idle;
  }

  private async suspendIfIdle(): Promise<void> {
    if (!this.waiting.length || this.waiting.length < this.inFlight) return;
    const waiters = this.waiting;
    this.waiting = [];
    try {
      const suspended =
        this.suspension !== null ||
        (await this.kernel.suspend(this.id, this.lease));
      for (const w of waiters) w.resolve(suspended);
    } catch (e) {
      for (const w of waiters) w.reject(e);
    }
  }

  /** The call's effects lock is released while it waits, so concurrent calls
   * can start their own subagents, and taken back before its step completes. */
  async awaitSubagent(stepId: string): Promise<unknown> {
    const held = this.effectsHolder === stepId;
    if (held) this.releaseEffects();
    try {
      if (await this.awaitIdle()) {
        this.suspension ??= new Blocked();
        throw this.suspension;
      }
    } finally {
      if (held) {
        await this.acquireEffects();
        this.effectsHolder = stepId;
      }
    }
    const step = await this.kernel.getStep(this.id, stepId);
    if (step?.error != null)
      throw new ToolError(errorMessage(step.error), {
        toolId: step.target,
        stepId,
      });
    return step?.result ?? null;
  }

  /**
   * The kernel counts occurrences of this effect under its own lock, so
   * concurrent identical calls get distinct step ids without coordination here.
   */
  private async submit(p: {
    kind: string;
    target: string;
    args: unknown;
    idempotency: string;
    resources?: string[];
  }): Promise<{ stepId: string; dec: StepDecision }> {
    const dec = await this.kernel.submitStep(this.id, p, this.lease);
    return { stepId: dec.stepId, dec };
  }

  private raiseForDecision(dec: StepDecision): void {
    switch (dec.decision) {
      case "denied":
        throw new PolicyError(dec.reason, dec.ruleId);
      case "rate_limited":
        throw new RateLimited(dec.reason);
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
   * Renew the dispatch lease until the returned stop function is called. A
   * blocking body starves the heartbeat: it must yield to the event loop, or
   * the kernel reclaims the dispatch mid-handler.
   *
   * Losing the lease aborts this run, so a handler the kernel has replaced is
   * refused at its next kernel call instead of working on.
   */
  startHeartbeat(): () => void {
    const hb = setInterval(() => {
      if (this.ctrl.signal.aborted) {
        clearInterval(hb);
        return;
      }
      void this.kernel.heartbeat(this.id, this.lease).catch((e) => {
        if (e instanceof LeaseSuperseded) {
          clearInterval(hb);
          this.ctrl.abort();
        }
      });
    }, heartbeatIntervalMs(this.lease));
    return () => clearInterval(hb);
  }

  async invokeTool(
    target: string,
    args: Record<string, unknown>,
    opts: {
      idempotency?: Idempotency;
      run?: () => Promise<unknown>;
      kind?: StepKind;
      resources?: string[];
    } = {},
  ): Promise<unknown> {
    this.inFlight++;
    try {
      return await this.runTool(target, args, opts);
    } finally {
      this.inFlight--;
      await this.suspendIfIdle();
    }
  }

  private runTool(
    target: string,
    args: Record<string, unknown>,
    opts: {
      idempotency?: Idempotency;
      run?: () => Promise<unknown>;
      kind?: StepKind;
      resources?: string[];
    },
  ): Promise<unknown> {
    const locked = this.resources.size > 0;
    return this.exclusive(async () => {
      const { stepId, dec } = await this.submit({
        kind: opts.kind ?? "tool_call",
        target,
        args,
        idempotency: opts.idempotency ?? "safe_to_retry",
        resources: opts.resources,
      });
      if (locked) this.effectsHolder = stepId;

      if (dec.decision === "replay") {
        if (dec.error != null)
          throw new ToolError(errorMessage(dec.error), {
            toolId: target,
            stepId,
          });
        return dec.result;
      }
      this.raiseForDecision(dec);
      const due = dec.resources.filter((r) => r.due);
      let result: unknown;
      try {
        result = opts.run ? await runInStep(stepId, opts.run) : null;
      } catch (e) {
        if (
          e instanceof Blocked ||
          e instanceof Terminated ||
          e instanceof PolicyError ||
          e instanceof RateLimited ||
          e instanceof LeaseSuperseded
        )
          throw e;
        const records = await this.capture(due);
        await this.failStepQuietly(stepId, e, records);
        if (e instanceof ToolError) throw e;
        throw new ToolError(String(e instanceof Error ? e.message : e), {
          toolId: target,
          stepId,
        });
      }
      const records = await this.capture(due);
      await this.kernel.completeStep(
        this.id,
        stepId,
        result,
        this.lease,
        records,
      );
      return result;
    }, locked);
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

  /** Publish a live delta for an in-flight streamed step. Best-effort: deltas
   * are advisory, the recorded whole is the durable result. */
  async publishLlmDelta(
    stepId: string,
    seq: number,
    data: string,
  ): Promise<void> {
    try {
      await this.kernel.streamDelta(this.id, stepId, seq, data, this.lease);
    } catch {
      /* best effort */
    }
  }

  async recordLlm(stepId: string, result: unknown): Promise<void> {
    await this.kernel.completeStep(this.id, stepId, result, this.lease);
  }

  async failStepQuietly(
    stepId: string,
    error: unknown,
    records: CheckpointRecords = {},
  ): Promise<void> {
    try {
      await this.kernel.failStep(
        this.id,
        stepId,
        { message: String(error instanceof Error ? error.message : error) },
        this.lease,
        records,
      );
    } catch (e) {
      if (e instanceof LeaseSuperseded) throw e;
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
