import { describe, it, expect, vi } from "vitest";
import { createRebunoFetch } from "../src/fetch.js";
import { ExecutionContext } from "../src/execution.js";
import { runWithContext } from "../src/context.js";

function fakeKernel(decision: any = { decision: "proceed", result: null, error: null, approvalId: null, reason: "" }) {
  return {
    listTerminalSteps: vi.fn(async () => []),
    submitStep: vi.fn(async () => decision),
    completeStep: vi.fn(async () => {}),
    failStep: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
  };
}
const ctx = (k: any) => new ExecutionContext({ kernel: k, executionId: "e1", agentId: "a", input: {} });

describe("rebunoFetch", () => {
  it("passes through when there is no active execution", async () => {
    const inner = vi.fn(async () => new Response("ok", { status: 200 }));
    const rf = createRebunoFetch({ fetch: inner as any });
    const resp = await rf("http://llm/v1/chat", { method: "POST", body: JSON.stringify({ model: "gpt", messages: [] }) });
    expect(await resp.text()).toBe("ok");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("records the call as an llm_call step inside an execution", async () => {
    const inner = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const k = fakeKernel();
    const rf = createRebunoFetch({ fetch: inner as any });
    const resp = await runWithContext(ctx(k), () =>
      rf("http://llm/v1/chat", { method: "POST", body: JSON.stringify({ model: "gpt-4", messages: [] }) }),
    );
    expect(resp.status).toBe(200);
    expect(k.submitStep).toHaveBeenCalledOnce();
    expect(k.submitStep.mock.calls[0][1].kind).toBe("llm_call");
    expect(k.submitStep.mock.calls[0][1].target).toBe("gpt-4");
    expect(k.completeStep).toHaveBeenCalledOnce();
  });

  it("replays a recorded response without calling the provider", async () => {
    const inner = vi.fn(async () => new Response("should not be called", { status: 500 }));
    const k = fakeKernel({
      decision: "replay",
      result: { status: 200, headers: { "content-type": "application/json" }, body: '{"replayed":true}' },
      error: null, approvalId: null, reason: "",
    });
    const rf = createRebunoFetch({ fetch: inner as any });
    const resp = await runWithContext(ctx(k), () =>
      rf("http://llm/v1/chat", { method: "POST", body: JSON.stringify({ model: "gpt-4", messages: [] }) }),
    );
    expect(inner).not.toHaveBeenCalled();
    expect(await resp.json()).toEqual({ replayed: true });
  });

  it("passes streaming requests through with no recording", async () => {
    const inner = vi.fn(async () => new Response("stream", { status: 200 }));
    const k = fakeKernel();
    const rf = createRebunoFetch({ fetch: inner as any });
    await runWithContext(ctx(k), () =>
      rf("http://llm/v1/chat", { method: "POST", body: JSON.stringify({ model: "gpt-4", stream: true }) }),
    );
    expect(k.submitStep).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledOnce();
  });
});
