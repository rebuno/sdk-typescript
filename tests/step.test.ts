import { describe, expect, it, vi } from "vitest";
import { runWithContext } from "../src/context.js";
import { ExecutionContext } from "../src/execution.js";
import { step } from "../src/step.js";

function fakeKernel() {
  return {
    listTerminalSteps: vi.fn(async () => []),
    submitStep: vi.fn(async () => ({
      decision: "proceed",
      result: null,
      error: null,
      approvalId: null,
      reason: "",
    })),
    completeStep: vi.fn(async () => {}),
    failStep: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
  };
}
const ctx = (k: any) =>
  new ExecutionContext({
    kernel: k,
    executionId: "e1",
    lease: { dispatchId: "d1", attempt: 1 },
    agentId: "a",
    input: {},
  });

describe("step", () => {
  it("records local work and passes args to fn", async () => {
    const k = fakeKernel();
    const fn = vi.fn(({ a, b }: any) => a + b);
    const out = await runWithContext(ctx(k), () =>
      step("sum", fn, { a: 2, b: 3 }),
    );
    expect(out).toBe(5);
    expect(fn).toHaveBeenCalledWith({ a: 2, b: 3 });
    expect(k.submitStep.mock.calls[0][1].target).toBe("sum");
    expect(k.submitStep.mock.calls[0][1].kind).toBe("local");
  });
  it("throws outside a context", async () => {
    await expect(step("x", () => 1)).rejects.toThrow(
      /outside an active execution/,
    );
  });
});
