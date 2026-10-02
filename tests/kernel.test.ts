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

const REGISTRATION = {
  key: "workspace",
  driverId: "test.v1",
  configuration: { template: "base" },
  coverageReuse: true,
  everySteps: 5,
  onCompletion: false,
};

const CAPTURES = {
  captures: [{ key: "workspace", generation: 4, checkpointRef: "snap-1" }],
  captureFailures: [{ key: "database", generation: 2, error: "unavailable" }],
};

describe("KernelClient", () => {
  it("getExecution signs the request and parses the response", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://kernel/v0/executions/e1");
      const headers = init.headers as Record<string, string>;
      expect(headers["Rebuno-Agent-Id"]).toBe("agent-1");
      expect(headers["Rebuno-Signature"]).toMatch(/^v1=/);
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
        '{"kind":"tool_call","target":"search","args":{"z":2,"a":1},"idempotency":"safe_to_retry","resources":[]}',
      );
      return new Response(
        JSON.stringify({
          decision: "proceed",
          step_id: "s9",
          resources: [
            { key: "workspace", generation: 4, due: true },
            { key: "database", generation: 2 },
          ],
        }),
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
    expect(d.resources).toEqual([
      { key: "workspace", generation: 4, due: true },
      { key: "database", generation: 2, due: false },
    ]);
  });

  it.each([undefined, [], ["workspace"]])(
    "preserves resource declarations %j",
    async (resources) => {
      const f = fakeFetch((_url, init) => {
        const body = JSON.parse(
          new TextDecoder().decode(init.body as Uint8Array),
        );
        expect(body.resources).toEqual(resources ?? []);
        return Response.json({ decision: "proceed", step_id: "s1" });
      });
      await new KernelClient(opts(f)).submitStep(
        "e1",
        {
          kind: "tool_call",
          target: "write",
          args: {},
          idempotency: "safe_to_retry",
          resources,
        },
        LEASE,
      );
    },
  );

  it("registers a resource and parses its checkpoint state", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://kernel/v0/executions/e1/resources");
      expect(
        JSON.parse(new TextDecoder().decode(init.body as Uint8Array)),
      ).toEqual({
        key: "workspace",
        driver_id: "test.v1",
        configuration: { template: "base" },
        coverage_reuse: true,
        every_steps: 5,
        on_completion: false,
      });
      return Response.json({
        key: "workspace",
        generation: 4,
        binding: { sandbox_id: "sbx" },
        checkpoint_ref: "snap-1",
        covered: true,
        every_steps: 5,
        on_completion: false,
      });
    });
    expect(
      await new KernelClient(opts(f)).registerResource(
        "e1",
        REGISTRATION,
        LEASE,
      ),
    ).toEqual({
      key: "workspace",
      generation: 4,
      binding: { sandbox_id: "sbx" },
      checkpointRef: "snap-1",
      covered: true,
      everySteps: 5,
      onCompletion: false,
    });
  });

  it("binds the resource's JSON locator", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe(
        "http://kernel/v0/executions/e1/resources/workspace/binding",
      );
      expect(
        JSON.parse(new TextDecoder().decode(init.body as Uint8Array)),
      ).toEqual({ binding: { id: "sbx" } });
      return new Response(null);
    });
    await new KernelClient(opts(f)).bindResource(
      "e1",
      "workspace",
      { id: "sbx" },
      LEASE,
    );
  });

  it.each(["complete", "fail", "checkpoints"])(
    "sends capture metadata with %s",
    async (action) => {
      const f = fakeFetch((url, init) => {
        expect(url).toBe(
          `http://kernel/v0/executions/e1/${action === "checkpoints" ? "resources/checkpoints" : `steps/s1/${action}`}`,
        );
        expect(
          JSON.parse(new TextDecoder().decode(init.body as Uint8Array)),
        ).toEqual({
          ...(action === "complete"
            ? { result: "done" }
            : action === "fail"
              ? { error: { message: "failed" } }
              : {}),
          captures: [
            { key: "workspace", generation: 4, checkpoint_ref: "snap-1" },
          ],
          capture_failures: [
            { key: "database", generation: 2, error: "unavailable" },
          ],
        });
        return new Response(null);
      });
      const k = new KernelClient(opts(f));
      if (action === "complete")
        await k.completeStep("e1", "s1", "done", LEASE, CAPTURES);
      else if (action === "fail")
        await k.failStep("e1", "s1", { message: "failed" }, LEASE, CAPTURES);
      else await k.publishCheckpoints("e1", CAPTURES, LEASE);
    },
  );

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
    [
      "registerResource",
      (k: KernelClient) => k.registerResource("e1", REGISTRATION, LEASE),
    ],
    [
      "bindResource",
      (k: KernelClient) =>
        k.bindResource("e1", "workspace", { id: "sbx" }, LEASE),
    ],
    [
      "publishCheckpoints",
      (k: KernelClient) => k.publishCheckpoints("e1", CAPTURES, LEASE),
    ],
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

  it("streamDelta posts seq and data under the lease", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://kernel/v0/executions/e1/steps/sid123/stream");
      expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(
        '{"seq":4,"data":"tok"}',
      );
      const headers = init.headers as Record<string, string>;
      expect(headers["Rebuno-Signature"]).toMatch(/^v1=/);
      expect(headers["Rebuno-Dispatch-Id"]).toBe("d1");
      expect(headers["Rebuno-Dispatch-Attempt"]).toBe("3");
      return new Response("", { status: 200 });
    });
    const k = new KernelClient(opts(f));
    await k.streamDelta("e1", "sid123", 4, "tok", LEASE);
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
