import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { signRequest } from "../src/crypto.js";
import { APIError } from "../src/errors.js";
import { KernelClient } from "../src/kernel.js";

interface Vector {
  name: string;
  secret: string;
  method: string;
  target: string;
  body: string;
  timestamp: string;
  dispatch_id: string;
  dispatch_attempt: string;
  signature: string;
}
const vectors: Vector[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/request-signatures.json", import.meta.url),
    "utf8",
  ),
);

describe("request signatures", () => {
  it.each(vectors)("$name matches the protocol vector", async (v) => {
    expect(
      await signRequest(
        v.secret,
        v.method,
        v.target,
        new TextEncoder().encode(v.body),
        {
          "Rebuno-Timestamp": v.timestamp,
          "Rebuno-Dispatch-Id": v.dispatch_id,
          "Rebuno-Dispatch-Attempt": v.dispatch_attempt,
        },
      ),
    ).toBe(v.signature);
  });

  it("signs the final URL and refreshes signatures on retries", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    try {
      const client = new KernelClient({
        agentId: "agent",
        secret: "secret",
        baseUrl: "http://kernel/prefix",
        fetch: (async (url: string, init: RequestInit) => {
          requests.push({ url, init });
          return new Response("{}", {
            status: requests.length === 1 ? 503 : 200,
          });
        }) as typeof fetch,
      });
      const lease = { dispatchId: "dispatch", attempt: 3, timeoutMs: 120000 };
      await expect(client.heartbeat("a%2Fb", lease)).rejects.toBeInstanceOf(
        APIError,
      );
      clock.mockReturnValue(1700000030000);
      await client.heartbeat("a%2Fb", lease);
      const [first, second] = requests;
      if (!first || !second) throw new Error("Expected two requests");
      expect(second.url).toBe(
        "http://kernel/prefix/v0/executions/a%2Fb/heartbeat",
      );
      const headers = second.init.headers as Record<string, string>;
      const canonical =
        "rebuno-request-v1\nPOST\n/prefix/v0/executions/a%2Fb/heartbeat\n1700000030\ndispatch\n3\n";
      expect(headers["Rebuno-Signature"]).toBe(
        `v1=${createHmac("sha256", "secret").update(canonical).digest("hex")}`,
      );
      expect(headers["Rebuno-Signature"]).not.toBe(
        (first.init.headers as Record<string, string>)["Rebuno-Signature"],
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("does not follow redirects with a signed request", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return new Response(null, {
        status: 307,
        headers: { Location: "http://other/path" },
      });
    });
    const client = new KernelClient({
      agentId: "agent",
      secret: "secret",
      baseUrl: "http://kernel",
      fetch: f as typeof fetch,
    });
    await expect(client.getExecution("e1")).rejects.toBeInstanceOf(APIError);
    expect(f).toHaveBeenCalledOnce();
  });
});
