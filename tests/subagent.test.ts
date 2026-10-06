import { describe, expect, it, vi } from "vitest";
import type { Client } from "../src/client.js";
import { runWithContext } from "../src/context.js";
import { Blocked, ToolError } from "../src/errors.js";
import { ExecutionContext } from "../src/execution.js";
import { subagent } from "../src/subagent.js";

function fakeKernel(suspended: boolean, steps: Record<string, unknown> = {}) {
  let n = 0;
  return {
    submitStep: vi.fn(async () => {
      const stepId = `step-${++n}`;
      await Promise.resolve();
      return { decision: "proceed", stepId, resources: [] };
    }),
    suspend: vi.fn(async () => suspended),
    getStep: vi.fn(async (_: string, stepId: string) => steps[stepId]),
    completeStep: vi.fn(async () => {}),
    failStep: vi.fn(async () => {}),
  };
}

function fakeClient() {
  return { create: vi.fn(async () => ({})) } as unknown as Client & {
    create: ReturnType<typeof vi.fn>;
  };
}

function ctxWith(kernel: unknown) {
  return new ExecutionContext({
    kernel: kernel as any,
    executionId: "e1",
    lease: { dispatchId: "d1", attempt: 1, timeoutMs: 120000 },
    agentId: "a",
    input: {},
  });
}

describe("subagent", () => {
  it("suspends once after every in-flight call waits", async () => {
    const kernel = fakeKernel(true);
    const client = fakeClient();
    const ctx = ctxWith(kernel);
    let suspendsSeenByOther = -1;
    const results = await runWithContext(ctx, () =>
      Promise.allSettled([
        ctx.invokeTool(
          "research",
          { q: 1 },
          { run: () => subagent("r", null, { client }) },
        ),
        ctx.invokeTool(
          "research",
          { q: 2 },
          { run: () => subagent("r", null, { client }) },
        ),
        ctx.invokeTool(
          "lookup",
          {},
          {
            run: async () => {
              await new Promise((r) => setTimeout(r, 0));
              suspendsSeenByOther = kernel.suspend.mock.calls.length;
              return "ok";
            },
          },
        ),
      ]),
    );

    expect(suspendsSeenByOther).toBe(0);
    expect(kernel.suspend).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
      "fulfilled",
    ]);
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      Blocked,
    );
    expect(
      client.create.mock.calls
        .map((c: any[]) => c[2].spawnedBy)
        .sort((a: any, b: any) => a.stepId.localeCompare(b.stepId)),
    ).toEqual([
      { executionId: "e1", stepId: "step-1" },
      { executionId: "e1", stepId: "step-2" },
    ]);
    expect(kernel.completeStep).toHaveBeenCalledTimes(1);
    expect(kernel.failStep).not.toHaveBeenCalled();
    expect(ctx.suspension).toBeInstanceOf(Blocked);
  });

  it("returns the recorded outcome once settled", async () => {
    const kernel = fakeKernel(false, {
      "step-1": { target: "research", result: { a: 1 }, error: null },
      "step-2": {
        target: "research",
        result: null,
        error: { reason: "subagent_failed" },
      },
    });
    const client = fakeClient();
    const ctx = ctxWith(kernel);
    const [ok, failed] = await runWithContext(ctx, () =>
      Promise.allSettled([
        ctx.invokeTool(
          "research",
          { q: 1 },
          { run: () => subagent("r", null, { client }) },
        ),
        ctx.invokeTool(
          "research",
          { q: 2 },
          { run: () => subagent("r", null, { client }) },
        ),
      ]),
    );

    expect(ok).toEqual({ status: "fulfilled", value: { a: 1 } });
    const reason = (failed as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ToolError);
    expect(reason.message).toContain("subagent_failed");
    expect(ctx.suspension).toBeNull();
  });

  it("refuses to run outside a tool body", async () => {
    const ctx = ctxWith(fakeKernel(true));
    await expect(
      runWithContext(ctx, () => subagent("r", null, { client: fakeClient() })),
    ).rejects.toThrow("outside a tool body");
  });
});
