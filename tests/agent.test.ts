import { describe, it, expect, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { signBody } from "../src/crypto.js";

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
      return new Response(JSON.stringify({ decision: "proceed" }), { status: 200 });
    }
    if (url.endsWith("/complete")) return new Response(null, { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return { f, calls };
}

async function webhookRequest(secret: string, executionId: string) {
  const raw = new TextEncoder().encode(JSON.stringify({ execution_id: executionId }));
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
    const agent = new Agent("a1", { secret: SECRET, kernelUrl: KERNEL, fetch: f });
    agent.bind(async () => ({ ok: true }));
    const raw = new TextEncoder().encode(JSON.stringify({ execution_id: "e1" }));
    const req = new Request(`${KERNEL}/webhook`, { method: "POST", headers: { "Rebuno-Signature": "sha256=bad" }, body: raw });
    const resp = await agent.fetch(req);
    expect(resp.status).toBe(401);
  });

  it("400 when execution_id is missing", async () => {
    const { f } = kernelFetch({ id: "e1", status: "running", input: {} });
    const agent = new Agent("a1", { secret: SECRET, kernelUrl: KERNEL, fetch: f });
    agent.bind(async () => ({}));
    const raw = new TextEncoder().encode(JSON.stringify({}));
    const sig = await signBody(SECRET, raw);
    const req = new Request(`${KERNEL}/webhook`, { method: "POST", headers: { "Rebuno-Signature": sig }, body: raw });
    expect((await agent.fetch(req)).status).toBe(400);
  });

  it("dispatches: runs process and completes the execution", async () => {
    const { f, calls } = kernelFetch({ id: "e1", status: "running", input: { prompt: "hi" } });
    const agent = new Agent("a1", { secret: SECRET, kernelUrl: KERNEL, fetch: f });
    const process = vi.fn(async (input: any) => ({ echo: input.prompt }));
    agent.bind(process);
    const resp = await agent.fetch(await webhookRequest(SECRET, "e1"));
    expect(resp.status).toBe(200);
    await agent.join();
    expect(process).toHaveBeenCalledWith({ prompt: "hi" });
    const complete = calls.find((c) => c.url.endsWith("/v0/executions/e1/complete"));
    expect(complete?.body).toEqual({ output: { echo: "hi" } });
  });

  it("skips terminal executions without running process", async () => {
    const { f } = kernelFetch({ id: "e1", status: "completed", input: {} });
    const agent = new Agent("a1", { secret: SECRET, kernelUrl: KERNEL, fetch: f });
    const process = vi.fn(async () => ({}));
    agent.bind(process);
    await agent.fetch(await webhookRequest(SECRET, "e1"));
    await agent.join();
    expect(process).not.toHaveBeenCalled();
  });

  it("validates input via inputSchema and fails the execution on error", async () => {
    const { f, calls } = kernelFetch({ id: "e1", status: "running", input: {} });
    const schema = {
      "~standard": {
        version: 1, vendor: "test",
        validate: (v: any) => (v && v.prompt ? { value: v } : { issues: [{ message: "prompt required" }] }),
      },
    };
    const agent = new Agent("a1", { secret: SECRET, kernelUrl: KERNEL, fetch: f, inputSchema: schema });
    agent.bind(async () => ({}));
    await agent.fetch(await webhookRequest(SECRET, "e1"));
    await agent.join();
    const fail = calls.find((c) => c.url.endsWith("/v0/executions/e1/fail"));
    expect(fail?.body.error).toMatch(/prompt required/);
  });
});
