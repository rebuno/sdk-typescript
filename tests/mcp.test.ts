import { describe, expect, it, vi } from "vitest";
import { runWithContext } from "../src/context.js";
import { ExecutionContext } from "../src/execution.js";
import { wrapMcpTool, wrapMcpTools } from "../src/mcp.js";

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

describe("wrapMcpTool", () => {
  it("prefixes the tool id but calls with the bare name; strips null args", async () => {
    const descriptor = {
      name: "read_file",
      description: "reads",
      inputSchema: { type: "object" },
    };
    const call = vi.fn(async (_name: string, _args: any) => ({
      content: [{ type: "text", text: "hi" }],
    }));
    const t = wrapMcpTool(descriptor, { call, prefix: "fs" });
    expect(t.name).toBe("fs_read_file");

    const k = fakeKernel();
    const out = await runWithContext(ctx(k), () =>
      t.execute({ path: "/x", extra: null }),
    );
    expect(call).toHaveBeenCalledWith("read_file", { path: "/x" }); // bare name, null stripped
    expect(out).toBe("hi"); // flattened text block
  });

  it("prefers structured content when present", async () => {
    const call = vi.fn(async () => ({ structuredContent: { ok: true } }));
    const t = wrapMcpTool({ name: "q" }, { call });
    const out = await runWithContext(ctx(fakeKernel()), () => t.execute({}));
    expect(out).toEqual({ ok: true });
  });

  it("wrapMcpTools maps a list", () => {
    const call = vi.fn(async () => ({}));
    const tools = wrapMcpTools([{ name: "a" }, { name: "b" }], {
      call,
      prefix: "p",
    });
    expect(tools.map((t) => t.name)).toEqual(["p_a", "p_b"]);
  });
});
