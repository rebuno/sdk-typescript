import { describe, expect, it, vi } from "vitest";
import { step } from "../src/step.js";
import { fakeKernel, withContext } from "./helpers.js";

describe("step", () => {
  it("records local work and passes args to fn", async () => {
    const k = fakeKernel();
    const fn = vi.fn(({ a, b }: any) => a + b);
    const out = await withContext(k, () => step("sum", fn, { a: 2, b: 3 }));
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
