import { describe, it, expect, vi } from "vitest";
import { Client } from "../src/client.js";
import { NotFoundError } from "../src/errors.js";

function fakeFetch(handler: (url: string, init: any) => Response) {
  return vi.fn(async (url: string, init: any) => handler(url, init));
}

describe("Client", () => {
  it("create posts agent_id + input and parses the execution", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://k/v0/executions");
      expect(init.method).toBe("POST");
      expect((init.headers as any).Authorization).toBe("Bearer key");
      expect(JSON.parse(init.body)).toEqual({ agent_id: "a1", input: { p: 1 } });
      return new Response(JSON.stringify({ id: "e1", status: "pending" }), { status: 200 });
    });
    const c = new Client({ baseUrl: "http://k", apiKey: "key", fetch: f });
    const e = await c.create("a1", { p: 1 });
    expect(e.id).toBe("e1");
  });

  it("get maps 404 to NotFoundError", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ code: "not_found", message: "gone" }), { status: 404 }));
    const c = new Client({ baseUrl: "http://k", apiKey: "key", fetch: f });
    await expect(c.get("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listApprovals passes status and parses the list", async () => {
    const f = fakeFetch((url) => {
      expect(url).toBe("http://k/v0/approvals?status=pending");
      return new Response(JSON.stringify([{ id: "ap1", step_id: "s1" }]), { status: 200 });
    });
    const c = new Client({ baseUrl: "http://k", apiKey: "key", fetch: f });
    const list = await c.listApprovals();
    expect(list[0].id).toBe("ap1");
    expect(list[0].stepId).toBe("s1");
  });

  it("grantApproval posts decided_by + rationale", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("http://k/v0/approvals/ap1/grant");
      expect(JSON.parse(init.body)).toEqual({ decided_by: "alice", rationale: "ok" });
      return new Response(null, { status: 200 });
    });
    const c = new Client({ baseUrl: "http://k", apiKey: "key", fetch: f });
    await c.grantApproval("ap1", { decidedBy: "alice", rationale: "ok" });
  });
});
