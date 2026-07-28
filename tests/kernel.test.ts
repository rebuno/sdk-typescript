import { describe, expect, it, vi } from "vitest";
import { KernelClient } from "../src/kernel.js";

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  return vi.fn(async (url: string, init: RequestInit) => handler(url, init));
}

const opts = (fetchImpl: any) => ({
  agentId: "agent-1",
  secret: "sec",
  baseUrl: "http://kernel",
  timeout: 1000,
  fetch: fetchImpl,
});

describe("KernelClient", () => {
  it("getExecution signs the request and parses the response", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://kernel/v0/executions/e1");
      const headers = init.headers as Record<string, string>;
      expect(headers["Rebuno-Agent-Id"]).toBe("agent-1");
      expect(headers["Rebuno-Signature"]).toMatch(/^sha256=/);
      return new Response(JSON.stringify({ id: "e1", status: "running" }), {
        status: 200,
      });
    });
    const k = new KernelClient(opts(f));
    const e = await k.getExecution("e1");
    expect(e.id).toBe("e1");
    expect(e.status).toBe("running");
  });

  it("submitStep sends the effect and Rebuno-Dispatch-Id, returns the assigned id", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://kernel/v0/executions/e1/steps");
      const headers = init.headers as Record<string, string>;
      expect(headers["Rebuno-Dispatch-Id"]).toBe("d1");
      expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(
        '{"kind":"tool_call","target":"search","args":{"z":2,"a":1},"idempotency":"safe_to_retry"}',
      );
      return new Response(
        JSON.stringify({ decision: "proceed", step_id: "s9" }),
        { status: 200 },
      );
    });
    const k = new KernelClient(opts(f));
    const d = await k.submitStep("e1", {
      kind: "tool_call",
      target: "search",
      args: { z: 2, a: 1 },
      idempotency: "safe_to_retry",
      dispatchId: "d1",
    });
    expect(d.decision).toBe("proceed");
    expect(d.stepId).toBe("s9");
  });

  it("streamDelta posts seq and data to the stream endpoint", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://kernel/v0/executions/e1/steps/sid123/stream");
      expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(
        '{"seq":4,"data":"tok"}',
      );
      expect(
        (init.headers as Record<string, string>)["Rebuno-Signature"],
      ).toMatch(/^sha256=/);
      return new Response("", { status: 200 });
    });
    const k = new KernelClient(opts(f));
    await k.streamDelta("e1", "sid123", 4, "tok");
    expect(f).toHaveBeenCalledOnce();
  });

  it("getStep returns null on 404", async () => {
    const f = fakeFetch(
      () =>
        new Response(JSON.stringify({ code: "not_found", message: "x" }), {
          status: 404,
        }),
    );
    const k = new KernelClient(opts(f));
    expect(await k.getStep("e1", "s1")).toBeNull();
  });
});
