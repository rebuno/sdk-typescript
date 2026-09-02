import { describe, expect, it, vi } from "vitest";
import { runWithContext } from "../src/context.js";
import { ExecutionContext } from "../src/execution.js";
import { defineTool, wrapTool } from "../src/tool.js";

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
    lease: { dispatchId: "d1", attempt: 1, timeoutMs: 120000 },
    agentId: "a",
    input: {},
  });

describe("defineTool", () => {
  it("returns a callable carrying name/description/inputSchema and a durable execute", async () => {
    const schema = { type: "object" };
    const t = defineTool({
      name: "search",
      description: "d",
      inputSchema: schema,
      execute: async ({ q }: any) => [q],
    });
    expect(t.name).toBe("search");
    expect(t.description).toBe("d");
    expect(t.inputSchema).toBe(schema);

    const k = fakeKernel();
    const out = await runWithContext(ctx(k), () => t.execute({ q: "hi" }));
    expect(out).toEqual(["hi"]);
    expect(k.submitStep).toHaveBeenCalledOnce();
    expect(k.submitStep.mock.calls[0][1].target).toBe("search");
  });

  it("routes through the kernel when the tool itself is called", async () => {
    const t = defineTool({
      name: "search",
      execute: async ({ q }: { q: string }) => [q],
    });
    const k = fakeKernel();
    const out = await runWithContext(ctx(k), () => t({ q: "hi" }));
    expect(out).toEqual(["hi"]);
    expect(k.submitStep.mock.calls[0][1].target).toBe("search");
  });

  it("keeps name enumerable so spreading the tool preserves it", () => {
    const t = defineTool({ name: "search", execute: async () => 1 });
    expect(t.name).toBe("search");
    expect({ ...t }.name).toBe("search");
  });

  it("execute throws when called outside an execution", async () => {
    const t = defineTool({ name: "x", execute: async () => 1 });
    await expect(t.execute({})).rejects.toThrow(/outside an active execution/);
  });

  it("passes idempotency through to the step", async () => {
    const t = defineTool({
      name: "charge",
      idempotency: "at_most_once",
      execute: async () => "ok",
    });
    const k = fakeKernel();
    await runWithContext(ctx(k), () => t.execute({}));
    expect(k.submitStep.mock.calls[0][1].idempotency).toBe("at_most_once");
  });
});

describe("wrapTool", () => {
  it("routes invoke through the kernel and applies toResult/transformArgs", async () => {
    const invoke = vi.fn(async (args: any) => ({ raw: args }));
    const t = wrapTool({
      name: "mcp_x",
      invoke,
      description: "desc",
      inputSchema: { type: "object" },
      toResult: (r: any) => r.raw,
      transformArgs: (a: any) => ({ ...a, injected: true }),
    });
    const k = fakeKernel();
    const out = await runWithContext(ctx(k), () => t.execute({ a: 1 }));
    expect(invoke).toHaveBeenCalledWith({ a: 1, injected: true });
    expect(out).toEqual({ a: 1, injected: true });
    expect(k.submitStep.mock.calls[0][1].args).toEqual({
      a: 1,
      injected: true,
    });
  });
});
