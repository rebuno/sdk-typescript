import { describe, expect, it, vi } from "vitest";
import { LeaseSuperseded, Terminated } from "../src/errors.js";
import { type DispatchLease, KernelClient } from "../src/kernel.js";

const LEASE: DispatchLease = {
  dispatchId: "d1",
  attempt: 3,
  timeoutMs: 120000,
};

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

  it("submitStep sends the effect and returns the assigned id", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://kernel/v0/executions/e1/steps");
      expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(
        '{"kind":"tool_call","target":"search","args":{"z":2,"a":1},"idempotency":"safe_to_retry"}',
      );
      return new Response(
        JSON.stringify({ decision: "proceed", step_id: "s9" }),
        { status: 200 },
      );
    });
    const k = new KernelClient(opts(f));
    const d = await k.submitStep(
      "e1",
      {
        kind: "tool_call",
        target: "search",
        args: { z: 2, a: 1 },
        idempotency: "safe_to_retry",
      },
      LEASE,
    );
    expect(d.decision).toBe("proceed");
    expect(d.stepId).toBe("s9");
  });

  // The kernel fences every mutation on the attempt it was dispatched under, so
  // one that forgets the headers is refused rather than silently unfenced.
  it.each([
    [
      "submitStep",
      (k: KernelClient) =>
        k.submitStep(
          "e1",
          {
            kind: "local",
            target: "t",
            args: {},
            idempotency: "safe_to_retry",
          },
          LEASE,
        ),
    ],
    ["completeStep", (k: KernelClient) => k.completeStep("e1", "s1", 1, LEASE)],
    ["failStep", (k: KernelClient) => k.failStep("e1", "s1", {}, LEASE)],
    ["heartbeat", (k: KernelClient) => k.heartbeat("e1", LEASE)],
    [
      "completeExecution",
      (k: KernelClient) => k.completeExecution("e1", {}, LEASE),
    ],
    ["failExecution", (k: KernelClient) => k.failExecution("e1", "x", LEASE)],
  ])("%s carries the lease", async (_name, call) => {
    const f = fakeFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Rebuno-Dispatch-Id"]).toBe("d1");
      expect(headers["Rebuno-Dispatch-Attempt"]).toBe("3");
      return new Response(
        JSON.stringify({ decision: "proceed", step_id: "s9" }),
        { status: 200 },
      );
    });
    await call(new KernelClient(opts(f)));
    expect(f).toHaveBeenCalledOnce();
  });

  it("a superseded lease surfaces as LeaseSuperseded", async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ code: "lease_superseded", message: "gone" }),
          { status: 409 },
        ),
    );
    const k = new KernelClient(opts(f));
    await expect(k.heartbeat("e1", LEASE)).rejects.toBeInstanceOf(
      LeaseSuperseded,
    );
  });

  it("a terminal execution surfaces as Terminated", async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            code: "execution_terminal",
            message: "execution terminal",
          }),
          { status: 409 },
        ),
    );
    const k = new KernelClient(opts(f));
    await expect(k.completeExecution("e1", {}, LEASE)).rejects.toBeInstanceOf(
      Terminated,
    );
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
