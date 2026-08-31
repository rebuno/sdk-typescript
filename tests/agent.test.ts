import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { execution } from "../src/context.js";
import { signBody } from "../src/crypto.js";
import { ToolError } from "../src/errors.js";
import { createRebunoFetch } from "../src/fetch.js";
import { step } from "../src/step.js";
import { defineTool } from "../src/tool.js";

const SECRET = "sec";
const KERNEL = "http://kernel";

// Build a fetch that emulates the kernel for a given execution.
function kernelFetch(exec: any, steps: any[] = [], decision: any = null) {
  const calls: { url: string; body: any }[] = [];
  const f = vi.fn(async (url: string, init: any) => {
    const bodyText = init?.body ? new TextDecoder().decode(init.body) : "";
    calls.push({ url, body: bodyText ? JSON.parse(bodyText) : null });
    if (url.endsWith(`/v0/executions/${exec.id}`) && init.method === "GET") {
      return new Response(JSON.stringify(exec), { status: 200 });
    }
    if (url.includes("/steps?status=terminal")) {
      return new Response(JSON.stringify(steps), { status: 200 });
    }
    if (url.endsWith("/steps") && init.method === "POST") {
      return new Response(JSON.stringify(decision ?? { decision: "proceed" }), {
        status: 200,
      });
    }
    if (url.endsWith("/complete")) return new Response(null, { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return { f, calls };
}

async function webhookRequest(
  secret: string,
  executionId: string,
  dispatchId = "d1",
  attempt = 1,
) {
  const raw = new TextEncoder().encode(
    JSON.stringify({
      execution_id: executionId,
      dispatch_id: dispatchId,
      dispatch_attempt: attempt,
    }),
  );
  const sig = await signBody(secret, raw);
  return new Request(`${KERNEL}/webhook`, {
    method: "POST",
    headers: { "Rebuno-Signature": sig, "Content-Type": "application/json" },
    body: raw,
  });
}

describe("Agent.fetch", () => {
  it("rejects a bad signature with 401", async () => {
    const { f } = kernelFetch({ id: "e1", status: "running", input: {} });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    agent.bind(async () => ({ ok: true }));
    const raw = new TextEncoder().encode(
      JSON.stringify({
        execution_id: "e1",
        dispatch_id: "d1",
        dispatch_attempt: 1,
      }),
    );
    const req = new Request(`${KERNEL}/webhook`, {
      method: "POST",
      headers: { "Rebuno-Signature": "sha256=bad" },
      body: raw,
    });
    const resp = await agent.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("400 when execution_id is missing", async () => {
    const { f } = kernelFetch({ id: "e1", status: "running", input: {} });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    agent.bind(async () => ({}));
    const raw = new TextEncoder().encode(
      JSON.stringify({ dispatch_id: "d1", dispatch_attempt: 1 }),
    );
    const sig = await signBody(SECRET, raw);
    const req = new Request(`${KERNEL}/webhook`, {
      method: "POST",
      headers: { "Rebuno-Signature": sig },
      body: raw,
    });
    expect((await agent.fetch(req)).status).toBe(400);
  });

  // Every mutation this run makes must carry the attempt it was sent under, so a
  // payload the kernel cannot fence is unusable rather than silently degraded.
  it.each([
    ["no lease at all", {}],
    ["no attempt", { dispatch_id: "d1" }],
    ["attempt zero", { dispatch_id: "d1", dispatch_attempt: 0 }],
    ["a non-integer attempt", { dispatch_id: "d1", dispatch_attempt: 1.5 }],
    ["a boolean attempt", { dispatch_id: "d1", dispatch_attempt: true }],
  ])("400 on a webhook with %s", async (_name, lease) => {
    const { f } = kernelFetch({ id: "e1", status: "running", input: {} });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    agent.bind(async () => ({}));
    const raw = new TextEncoder().encode(
      JSON.stringify({ execution_id: "e1", ...lease }),
    );
    const sig = await signBody(SECRET, raw);
    const req = new Request(`${KERNEL}/webhook`, {
      method: "POST",
      headers: { "Rebuno-Signature": sig },
      body: raw,
    });
    expect((await agent.fetch(req)).status).toBe(400);
  });

  it("dispatches: runs process and completes the execution", async () => {
    const { f, calls } = kernelFetch({
      id: "e1",
      status: "running",
      input: { prompt: "hi" },
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    const process = vi.fn(async (input: any) => ({ echo: input.prompt }));
    agent.bind(process);
    const resp = await agent.fetch(await webhookRequest(SECRET, "e1"));
    expect(resp.status).toBe(200);
    await agent.join();
    expect(process).toHaveBeenCalledWith({ prompt: "hi" });
    const complete = calls.find((c) =>
      c.url.endsWith("/v0/executions/e1/complete"),
    );
    expect(complete?.body).toEqual({ output: { echo: "hi" } });
  });

  it("the lease reaches the execution context", async () => {
    const { f } = kernelFetch({
      id: "e1",
      status: "running",
      input: { prompt: "hi" },
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    let seen: [string, number] = ["", 0];
    agent.bind(async () => {
      seen = [execution().dispatchId, execution().dispatchAttempt];
      return {};
    });
    await agent.fetch(await webhookRequest(SECRET, "e1", "d-42", 7));
    await agent.join();
    expect(seen).toEqual(["d-42", 7]);
  });

  it("skips terminal executions without running process", async () => {
    const { f } = kernelFetch({ id: "e1", status: "completed", input: {} });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    const process = vi.fn(async () => ({}));
    agent.bind(process);
    await agent.fetch(await webhookRequest(SECRET, "e1"));
    await agent.join();
    expect(process).not.toHaveBeenCalled();
  });

  it("validates input via inputSchema and fails the execution on error", async () => {
    const { f, calls } = kernelFetch({
      id: "e1",
      status: "running",
      input: {},
    });
    const schema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v: any) =>
          v && v.prompt
            ? { value: v }
            : { issues: [{ message: "prompt required" }] },
      },
    };
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
      inputSchema: schema,
    });
    agent.bind(async () => ({}));
    await agent.fetch(await webhookRequest(SECRET, "e1"));
    await agent.join();
    const fail = calls.find((c) => c.url.endsWith("/v0/executions/e1/fail"));
    expect(fail?.body.error).toBe("input_invalid: prompt required");
  });

  it("names the tool in the recorded failure reason", async () => {
    const { f, calls } = kernelFetch({
      id: "e1",
      status: "running",
      input: {},
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    agent.bind(async () => {
      throw new ToolError("indeterminate", { toolId: "send_email" });
    });
    await agent.fetch(await webhookRequest(SECRET, "e1"));
    await agent.join();
    const fail = calls.find((c) => c.url.endsWith("/v0/executions/e1/fail"));
    expect(fail?.body.error).toBe("tool_error: send_email: indeterminate");
  });

  it("prefixes an uncaught error with agent_error", async () => {
    const { f, calls } = kernelFetch({
      id: "e1",
      status: "running",
      input: {},
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    agent.bind(async () => {
      throw new TypeError("boom");
    });
    await agent.fetch(await webhookRequest(SECRET, "e1"));
    await agent.join();
    const fail = calls.find((c) => c.url.endsWith("/v0/executions/e1/fail"));
    expect(fail?.body.error).toBe("agent_error: TypeError: boom");
  });

  it("records the kernel reason for a denied llm call", async () => {
    const REASON = "fs_write not allowed outside /tmp";
    const { f, calls } = kernelFetch(
      { id: "e1", status: "running", input: {} },
      [],
      { decision: "denied", reason: REASON },
    );
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    agent.bind(async () => {
      const llm = createRebunoFetch({
        fetch: async () => new Response("{}", { status: 200 }),
      });
      const r = await llm("http://llm/v1/chat", {
        method: "POST",
        body: JSON.stringify({ model: "m" }),
      });
      throw new Error(`Error code: 403 - ${await r.text()}`);
    });
    await agent.fetch(await webhookRequest(SECRET, "e1"));
    await agent.join();
    const fail = calls.find((c) => c.url.endsWith("/v0/executions/e1/fail"));
    expect(fail?.body.error).toBe(`policy_denied: ${REASON}`);
  });

  it.each([
    ["another dispatch", "d2", 1],
    ["a higher attempt of the same dispatch", "d1", 2],
  ])("%s supersedes the running one", async (_name, dispatchId, attempt) => {
    const { f, calls } = kernelFetch({
      id: "e1",
      status: "running",
      input: { prompt: "hi" },
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    let runs = 0;
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    agent.bind(async () => {
      runs++;
      const mine = runs;
      if (mine === 1) {
        started();
        await gate;
        await step("late", async () => "from the superseded run");
      }
      return { run: mine };
    });

    await agent.fetch(await webhookRequest(SECRET, "e1", "d1", 1));
    await firstStarted;
    await agent.fetch(await webhookRequest(SECRET, "e1", dispatchId, attempt));
    expect((agent as any).tasks.size).toBe(1);
    await agent.join();
    release();
    await new Promise((r) => setTimeout(r, 0));

    const completes = calls.filter((c) =>
      c.url.endsWith("/v0/executions/e1/complete"),
    );
    expect(completes.map((c) => c.body)).toEqual([{ output: { run: 2 } }]);
    // The superseded run must not have written at all — neither the execution
    // nor a step it was still mid-flight on: the new run owns both.
    expect(calls.some((c) => c.url.endsWith("/v0/executions/e1/fail"))).toBe(
      false,
    );
    expect(calls.some((c) => c.url.includes("/steps"))).toBe(false);
  });

  // Attempts only order within a dispatch: a delivery the kernel has already
  // moved past must not disturb the handler that replaced it.
  it.each([
    ["an identical redelivery", 1, 1],
    ["an attempt the kernel has moved past", 2, 1],
  ])("ignores %s", async (_name, first, second) => {
    const { f } = kernelFetch({ id: "e1", status: "running", input: {} });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    let runs = 0;
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    agent.bind(async () => {
      runs++;
      started();
      await gate;
      return {};
    });

    await agent.fetch(await webhookRequest(SECRET, "e1", "d1", first));
    await firstStarted;
    const running = (agent as any).tasks.get("e1");
    const resp = await agent.fetch(
      await webhookRequest(SECRET, "e1", "d1", second),
    );
    expect(resp.status).toBe(200);
    expect((agent as any).tasks.get("e1")).toBe(running);
    release();
    await agent.join();
    expect(runs).toBe(1);
  });

  it("runs distinct executions concurrently", async () => {
    const completed: string[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      const id = url.match(/\/v0\/executions\/([^/]+)/)![1];
      if (init.method === "GET")
        return new Response(
          JSON.stringify({ id, status: "running", input: {} }),
          { status: 200 },
        );
      if (url.endsWith(`/v0/executions/${id}/complete`)) completed.push(id);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f as any,
    });
    agent.bind(async () => ({ ok: true }));
    for (const id of ["e1", "e2"]) {
      const resp = await agent.fetch(await webhookRequest(SECRET, id));
      expect(resp.status).toBe(200);
    }
    await agent.join();
    expect(completed.sort()).toEqual(["e1", "e2"]);
  });
});

describe("Agent suspension handling", () => {
  // Holds every step for approval, the way a require_approval policy does.
  function blockingKernelFetch(id: string) {
    const calls: { url: string }[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      calls.push({ url });
      if (init?.method === "GET")
        return new Response(
          JSON.stringify({ id, status: "running", input: {} }),
          { status: 200 },
        );
      if (url.endsWith("/steps") && init?.method === "POST")
        return new Response(
          JSON.stringify({
            decision: "blocked",
            step_id: "s1",
            approval_id: "ap1",
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const settled = () => ({
      completed: calls.some((c) =>
        c.url.endsWith(`/v0/executions/${id}/complete`),
      ),
      failed: calls.some((c) => c.url.endsWith(`/v0/executions/${id}/fail`)),
    });
    return { f, settled };
  }

  const sendEmail = defineTool({
    name: "send_email",
    idempotency: "at_most_once",
    execute: async () => ({ sent: true }),
  });

  // Frameworks catch what a tool throws and hand it to the model, so the handler
  // can return an answer for work the kernel never allowed to run.
  it("does not complete when the handler swallows a blocked tool", async () => {
    const { f, settled } = blockingKernelFetch("e1");
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f as any,
    });
    agent.bind(async () => {
      try {
        await sendEmail.execute({});
      } catch {
        // swallowed, as a framework would
      }
      return { answer: "emailed" };
    });
    expect((await agent.fetch(await webhookRequest(SECRET, "e1"))).status).toBe(
      200,
    );
    await agent.join();
    expect(settled()).toEqual({ completed: false, failed: false });
  });

  // After swallowing the block a framework calls the model again, and that refusal
  // surfaces as the provider's own error rather than Blocked.
  it("does not fail when a later error follows a swallowed block", async () => {
    const { f, settled } = blockingKernelFetch("e1");
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f as any,
    });
    agent.bind(async () => {
      try {
        await sendEmail.execute({});
      } catch {
        // swallowed, as a framework would
      }
      throw new Error("Error code: 403 - provider rejected the call");
    });
    expect((await agent.fetch(await webhookRequest(SECRET, "e1"))).status).toBe(
      200,
    );
    await agent.join();
    expect(settled()).toEqual({ completed: false, failed: false });
  });

  // A step a gateway refused is never thrown in this process; the decision only
  // exists inside the provider's error.
  it("parks on a gateway refusal carrying the marker", async () => {
    const { f, calls } = kernelFetch({
      id: "e1",
      status: "running",
      input: {},
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f as any,
    });
    agent.bind(async () => {
      throw new Error("Error code: 403 - rebuno_refusal: execution_blocked");
    });
    expect((await agent.fetch(await webhookRequest(SECRET, "e1"))).status).toBe(
      200,
    );
    await agent.join();
    expect(
      calls.some((c) => c.url.endsWith("/v0/executions/e1/complete")),
    ).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/v0/executions/e1/fail"))).toBe(
      false,
    );
  });

  it("still fails on a gateway denial", async () => {
    const { f, calls } = kernelFetch({
      id: "e1",
      status: "running",
      input: {},
    });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f as any,
    });
    agent.bind(async () => {
      throw new Error("Error code: 403 - rebuno_refusal: denied");
    });
    expect((await agent.fetch(await webhookRequest(SECRET, "e1"))).status).toBe(
      200,
    );
    await agent.join();
    expect(calls.some((c) => c.url.endsWith("/v0/executions/e1/fail"))).toBe(
      true,
    );
  });
});
