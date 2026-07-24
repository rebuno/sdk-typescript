import { describe, it, expect, vi } from "vitest";
import { ExecutionContext } from "../src/execution.js";
import { runWithContext, getExecution, execution } from "../src/context.js";
import { PolicyError, RateLimited, Blocked, Terminated, ToolError } from "../src/errors.js";

/** Stands in for the kernel: assigns each submitted step an id, the way the real
 * one does, so decisions carry the id the SDK must use to complete them. */
function fakeKernel(overrides: Partial<Record<string, any>> = {}) {
  let n = 0;
  const decide = overrides.decide ?? (() => ({ decision: "proceed", result: null, error: null, approvalId: null, reason: "" }));
  delete overrides.decide;
  return {
    submitStep: vi.fn(async () => ({ stepId: `step-${++n}`, ...decide() })),
    completeStep: vi.fn(async () => {}),
    failStep: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    ...overrides,
  };
}

function ctxWith(kernel: any) {
  return new ExecutionContext({ kernel, executionId: "e1", dispatchId: "d1", agentId: "a", input: { p: 1 }, status: "running" });
}

describe("ambient context", () => {
  it("execution() throws with no active context", () => {
    expect(() => execution()).toThrow(/without an active execution/);
    expect(getExecution()).toBeNull();
  });
  it("runWithContext exposes the context", async () => {
    const ctx = ctxWith(fakeKernel());
    await runWithContext(ctx, async () => {
      expect(execution().id).toBe("e1");
      expect(execution().input).toEqual({ p: 1 });
    });
  });
});

describe("invokeTool", () => {
  it("proceed runs the body and completes the step", async () => {
    const kernel = fakeKernel();
    const ctx = ctxWith(kernel);
    const out = await ctx.invokeTool("search", { q: "x" }, { run: async () => [1, 2] });
    expect(out).toEqual([1, 2]);
    expect(kernel.completeStep).toHaveBeenCalledOnce();
  });

  it("replays a recorded terminal step without running the body", async () => {
    const kernel = fakeKernel({
      decide: () => ({ decision: "replay", result: "cached", error: null, approvalId: null, reason: "" }),
    });
    const ctx = ctxWith(kernel);
    const body = vi.fn(async () => "fresh");
    const out = await ctx.invokeTool("search", { q: "x" }, { run: body });
    expect(out).toBe("cached");
    expect(body).not.toHaveBeenCalled();
  });

  it("forwards the dispatch id on every submit", async () => {
    const kernel = fakeKernel();
    const ctx = ctxWith(kernel);
    await ctx.invokeTool("search", { q: "x" }, { run: async () => "fresh" });
    expect(kernel.submitStep.mock.calls[0][1].dispatchId).toBe("d1");
  });

  it("completes the step under the id the kernel assigned", async () => {
    const kernel = fakeKernel();
    const ctx = ctxWith(kernel);
    await ctx.invokeTool("search", { q: "x" }, { run: async () => "fresh" });
    expect(kernel.completeStep).toHaveBeenCalledWith("e1", "step-1", "fresh");
  });

  it("maps denied decision to PolicyError", async () => {
    const kernel = fakeKernel({
      decide: () => ({ decision: "denied", result: null, error: null, approvalId: null, reason: "no" }),
    });
    const ctx = ctxWith(kernel);
    await expect(ctx.invokeTool("t", {}, { run: async () => 1 })).rejects.toBeInstanceOf(PolicyError);
  });

  it("maps blocked decision to Blocked", async () => {
    const kernel = fakeKernel({
      decide: () => ({ decision: "blocked", result: null, error: null, approvalId: "ap1", reason: "" }),
    });
    const ctx = ctxWith(kernel);
    await expect(ctx.invokeTool("t", {}, { run: async () => 1 })).rejects.toBeInstanceOf(Blocked);
  });

  it("body throwing yields ToolError and records a step failure", async () => {
    const kernel = fakeKernel();
    const ctx = ctxWith(kernel);
    await expect(ctx.invokeTool("t", {}, { run: async () => { throw new Error("boom"); } }))
      .rejects.toBeInstanceOf(ToolError);
    expect(kernel.failStep).toHaveBeenCalledOnce();
  });

  it("identical calls take the kernel's distinct ids", async () => {
    const kernel = fakeKernel();
    const ctx = ctxWith(kernel);
    await ctx.invokeTool("t", { a: 1 }, { run: async () => 1 });
    await ctx.invokeTool("t", { a: 1 }, { run: async () => 2 });
    expect(kernel.completeStep.mock.calls.map((c: any[]) => c[1])).toEqual(["step-1", "step-2"]);
  });
});
