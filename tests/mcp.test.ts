import { describe, expect, it, vi } from "vitest";
import { wrapMcpTool, wrapMcpTools } from "../src/mcp.js";
import { fakeKernel, withContext } from "./helpers.js";

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

    const out = await withContext(fakeKernel(), () =>
      t.execute({ path: "/x", extra: null }),
    );
    expect(call).toHaveBeenCalledWith("read_file", { path: "/x" });
    expect(out).toBe("hi");
  });

  it("prefers structured content when present", async () => {
    const call = vi.fn(async () => ({ structuredContent: { ok: true } }));
    const t = wrapMcpTool({ name: "q" }, { call });
    const out = await withContext(fakeKernel(), () => t.execute({}));
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
