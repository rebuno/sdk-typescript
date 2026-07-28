import { describe, expect, it } from "vitest";
import * as rebuno from "../src/index.js";

describe("public surface", () => {
  it("exports the documented API", () => {
    for (const name of [
      "Client",
      "Agent",
      "defineTool",
      "wrapTool",
      "step",
      "rebunoFetch",
      "createRebunoFetch",
      "wrapMcpTool",
      "wrapMcpTools",
      "execution",
      "RebunoError",
      "APIError",
      "PolicyError",
      "ToolError",
      "NotFoundError",
      "ValidationError",
      "UnauthorizedError",
      "RateLimited",
      "Blocked",
      "Terminated",
    ]) {
      expect(
        rebuno[name as keyof typeof rebuno],
        `missing export: ${name}`,
      ).toBeDefined();
    }
  });
  it("does not leak internals", () => {
    expect((rebuno as any).canonicalJson).toBeUndefined();
    expect((rebuno as any).KernelClient).toBeUndefined();
  });
});
