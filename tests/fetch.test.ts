import { describe, expect, it, vi } from "vitest";
import { runWithContext } from "../src/context.js";
import {
  Blocked,
  PolicyError,
  RateLimited,
  raiseForRefusal,
} from "../src/errors.js";
import { ExecutionContext } from "../src/execution.js";
import { createRebunoFetch } from "../src/fetch.js";

function fakeKernel(
  decision: any = {
    decision: "proceed",
    result: null,
    error: null,
    approvalId: null,
    reason: "",
  },
) {
  return {
    listTerminalSteps: vi.fn(async () => []),
    submitStep: vi.fn(async () => decision),
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

describe("rebunoFetch", () => {
  it("passes through when there is no active execution", async () => {
    const inner = vi.fn(async () => new Response("ok", { status: 200 }));
    const rf = createRebunoFetch({ fetch: inner as any });
    const resp = await rf("http://llm/v1/chat", {
      method: "POST",
      body: JSON.stringify({ model: "gpt", messages: [] }),
    });
    expect(await resp.text()).toBe("ok");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("records the call as an llm_call step inside an execution", async () => {
    const inner = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const k = fakeKernel();
    const rf = createRebunoFetch({ fetch: inner as any });
    const resp = await runWithContext(ctx(k), () =>
      rf("http://llm/v1/chat", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(k.submitStep).toHaveBeenCalledOnce();
    expect(k.submitStep.mock.calls[0][1].kind).toBe("llm_call");
    expect(k.submitStep.mock.calls[0][1].target).toBe("gpt-4");
    expect(k.completeStep).toHaveBeenCalledOnce();
  });

  it("replays a recorded response without calling the provider", async () => {
    const inner = vi.fn(
      async () => new Response("should not be called", { status: 500 }),
    );
    const k = fakeKernel({
      decision: "replay",
      result: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"replayed":true}',
      },
      error: null,
      approvalId: null,
      reason: "",
    });
    const rf = createRebunoFetch({ fetch: inner as any });
    const resp = await runWithContext(ctx(k), () =>
      rf("http://llm/v1/chat", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      }),
    );
    expect(inner).not.toHaveBeenCalled();
    expect(await resp.json()).toEqual({ replayed: true });
  });

  it.each([
    ["denied", 403, PolicyError, "rebuno_refusal: denied reason=nope"],
    ["blocked", 403, Blocked, "rebuno_refusal: blocked"],
    [
      "rate_limited",
      429,
      RateLimited,
      "rebuno_refusal: rate_limited reason=nope",
    ],
  ])(
    "refuses %s over HTTP for the caller to map back",
    async (decision, status, expected, message) => {
      const inner = vi.fn(async () => new Response("", { status: 500 }));
      const k = fakeKernel({
        decision,
        result: null,
        error: null,
        approvalId: null,
        reason: "nope",
      });
      const rf = createRebunoFetch({ fetch: inner as any });
      const resp = await runWithContext(ctx(k), () =>
        rf("http://llm/v1/chat", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-4", messages: [] }),
        }),
      );

      expect(inner).not.toHaveBeenCalled();
      expect(resp.status).toBe(status);
      const body = await resp.json();
      expect(body.error).toEqual({ type: "rebuno_refusal", message });

      const err = new Error(`${status} ${JSON.stringify(body)}`);
      expect(() => raiseForRefusal(err)).toThrow(expected as any);
    },
  );

  it("maps a refusal a framework wrapped in its own error", () => {
    const cause = new Error(
      `403 {"error":{"message":"rebuno_refusal: blocked"}}`,
    );
    try {
      raiseForRefusal(new Error("node failed", { cause }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Blocked);
    }
  });
});

// A streamed provider response: a >2KB payload so the delta batcher emits
// multiple deltas, exercising size-based flushing and monotonic seq numbering.
const SSE = `data: {"delta":"${"x".repeat(5000)}"}\n\ndata: [DONE]\n\n`;
const SSE_BYTES = new TextEncoder().encode(SSE);

/** Minimal kernel: proceed for new step ids, replay for completed ones. */
function stepKernel() {
  const steps = new Map<string, unknown>();
  const deltas: [string, number, string][] = [];
  const completed: string[] = [];
  return {
    listTerminalSteps: vi.fn(async () => []),
    submitStep: vi.fn(async (_e: string, p: any) =>
      steps.has(p.stepId)
        ? {
            decision: "replay",
            result: steps.get(p.stepId),
            error: null,
            approvalId: null,
            reason: "",
          }
        : {
            decision: "proceed",
            result: null,
            error: null,
            approvalId: null,
            reason: "",
          },
    ),
    completeStep: vi.fn(async (_e: string, stepId: string, result: unknown) => {
      steps.set(stepId, result);
      completed.push(stepId);
    }),
    failStep: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    streamDelta: vi.fn(
      async (_e: string, stepId: string, seq: number, data: string) => {
        deltas.push([stepId, seq, data]);
      },
    ),
    deltas,
    completed,
  };
}

function sseResponse(chunks: (Uint8Array | Error)[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next === undefined) return controller.close();
      if (next instanceof Error) throw next;
      controller.enqueue(next);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size)
    out.push(bytes.slice(i, i + size));
  return out;
}

async function drainStream(resp: Response): Promise<string> {
  let got = "";
  const dec = new TextDecoder();
  for await (const chunk of resp.body as any)
    got += dec.decode(chunk, { stream: true });
  return got + dec.decode();
}

describe("rebunoFetch streaming", () => {
  const req = JSON.stringify({ model: "claude", stream: true });

  it("tees the stream, records the whole, then replays as a stream", async () => {
    const k = stepKernel();
    let calls = 0;
    const inner = vi.fn(async () => {
      calls++;
      return sseResponse(chunked(SSE_BYTES, 512));
    });
    const rf = createRebunoFetch({ fetch: inner as any });

    const got = await runWithContext(ctx(k), async () =>
      drainStream(
        await rf("http://llm/v1/chat", { method: "POST", body: req }),
      ),
    );
    expect(got).toBe(SSE);
    expect(calls).toBe(1);
    expect(k.submitStep.mock.calls[0][1].kind).toBe("llm_call");
    expect(k.completed.length).toBe(1);
    expect(k.deltas.length).toBeGreaterThanOrEqual(2);
    expect(k.deltas.map((d) => d[2]).join("")).toBe(SSE);
    expect(k.deltas.map((d) => d[1])).toEqual(k.deltas.map((_, i) => i));

    const nDeltas = k.deltas.length;
    const replayed = await runWithContext(ctx(k), async () =>
      drainStream(
        await rf("http://llm/v1/chat", { method: "POST", body: req }),
      ),
    );
    expect(replayed).toBe(SSE);
    expect(calls).toBe(1); // the provider was not called again
    expect(k.deltas.length).toBe(nDeltas);
  });

  it("records when the consumer stops at [DONE] without draining to EOF", async () => {
    const k = stepKernel();
    const inner = vi.fn(async () => sseResponse(chunked(SSE_BYTES, 512)));
    const rf = createRebunoFetch({ fetch: inner as any });
    await runWithContext(ctx(k), async () => {
      const resp = await rf("http://llm/v1/chat", {
        method: "POST",
        body: req,
      });
      let got = "";
      const dec = new TextDecoder();
      for await (const chunk of resp.body as any) {
        got += dec.decode(chunk, { stream: true });
        if (got.includes("[DONE]")) break;
      }
    });
    expect(k.completed.length).toBe(1);
    expect(k.deltas.map((d) => d[2]).join("")).toBe(SSE);
  });

  it("fails the step on a mid-stream error instead of recording a partial", async () => {
    const k = stepKernel();
    const inner = vi.fn(async () =>
      sseResponse([
        SSE_BYTES.slice(0, 512),
        new Error("connection dropped mid-stream"),
      ]),
    );
    const rf = createRebunoFetch({ fetch: inner as any });
    await runWithContext(ctx(k), async () => {
      const resp = await rf("http://llm/v1/chat", {
        method: "POST",
        body: req,
      });
      await expect(drainStream(resp)).rejects.toThrow(/connection dropped/);
    });
    expect(k.completed).toEqual([]);
    expect(k.failStep).toHaveBeenCalledOnce();
  });

  it("records an error status like a non-stream response", async () => {
    const k = stepKernel();
    const inner = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const rf = createRebunoFetch({ fetch: inner as any });
    const resp = await runWithContext(ctx(k), () =>
      rf("http://llm/v1/chat", { method: "POST", body: req }),
    );
    expect(resp.status).toBe(429);
    expect(k.completed.length).toBe(1);
    expect(k.deltas).toEqual([]);
  });
});
