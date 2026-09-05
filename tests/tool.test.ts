import { describe, expect, it, vi } from "vitest";
import { defineTool, wrapTool } from "../src/tool.js";
import { fakeKernel, withContext } from "./helpers.js";

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
    const out = await withContext(k, () => t.execute({ q: "hi" }));
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
    const out = await withContext(k, () => t({ q: "hi" }));
    expect(out).toEqual(["hi"]);
    expect(k.submitStep.mock.calls[0][1].target).toBe("search");
  });

  it("keeps name enumerable so spreading the tool preserves it", () => {
    const t = defineTool({ name: "search", execute: async () => 1 });
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
    await withContext(k, () => t.execute({}));
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
    const out = await withContext(k, () => t.execute({ a: 1 }));
    expect(invoke).toHaveBeenCalledWith({ a: 1, injected: true });
    expect(out).toEqual({ a: 1, injected: true });
    expect(k.submitStep.mock.calls[0][1].args).toEqual({
      a: 1,
      injected: true,
    });
  });
});
