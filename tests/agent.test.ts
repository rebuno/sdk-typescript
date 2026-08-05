import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { execution } from "../src/context.js";
import { signBody } from "../src/crypto.js";
import { step } from "../src/step.js";

const SECRET = "sec";
const KERNEL = "http://kernel";

// Build a fetch that emulates the kernel for a given execution.
function kernelFetch(exec: any, steps: any[] = []) {
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
      return new Response(JSON.stringify({ decision: "proceed" }), {
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
) {
  const raw = new TextEncoder().encode(
    JSON.stringify({ execution_id: executionId, dispatch_id: dispatchId }),
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
      JSON.stringify({ execution_id: "e1", dispatch_id: "d1" }),
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
    const raw = new TextEncoder().encode(JSON.stringify({ dispatch_id: "d1" }));
    const sig = await signBody(SECRET, raw);
    const req = new Request(`${KERNEL}/webhook`, {
      method: "POST",
      headers: { "Rebuno-Signature": sig },
      body: raw,
    });
    expect((await agent.fetch(req)).status).toBe(400);
  });

  it("400 when dispatch_id is missing", async () => {
    // Every effect this run submits must carry the dispatch it was sent under, so
    // a payload missing one is unusable rather than silently degraded.
    const { f } = kernelFetch({ id: "e1", status: "running", input: {} });
    const agent = new Agent("a1", {
      secret: SECRET,
      baseUrl: KERNEL,
      fetch: f,
    });
    agent.bind(async () => ({}));
    const raw = new TextEncoder().encode(
      JSON.stringify({ execution_id: "e1" }),
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

  it("the dispatch id reaches the execution context", async () => {
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
    let seen = "";
    agent.bind(async () => {
      seen = execution().dispatchId;
      return {};
    });
    await agent.fetch(await webhookRequest(SECRET, "e1", "d-42"));
    await agent.join();
    expect(seen).toBe("d-42");
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
    expect(fail?.body.error).toMatch(/prompt required/);
  });

  it("a redelivery supersedes the previous run", async () => {
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

    await agent.fetch(await webhookRequest(SECRET, "e1", "d1"));
    await firstStarted;
    await agent.fetch(await webhookRequest(SECRET, "e1", "d2"));
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
