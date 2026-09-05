import { vi } from "vitest";
import { runWithContext } from "../src/context.js";
import { ExecutionContext } from "../src/execution.js";

export function fakeKernel(decision: Record<string, unknown> = {}) {
  return {
    submitStep: vi.fn(async () => ({
      decision: "proceed",
      stepId: "s1",
      result: null,
      error: null,
      approvalId: null,
      reason: "",
      ...decision,
    })),
    completeStep: vi.fn(async () => {}),
    failStep: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
  };
}

export function withContext<T>(kernel: unknown, fn: () => T): T {
  return runWithContext(
    new ExecutionContext({
      kernel: kernel as any,
      executionId: "e1",
      lease: { dispatchId: "d1", attempt: 1, timeoutMs: 120000 },
      agentId: "a",
      input: {},
    }),
    fn,
  );
}
