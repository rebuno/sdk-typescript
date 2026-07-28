import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/crypto.js";

const SECRET = "dev-secret";

describe("signBody", () => {
  it("produces sha256=<hex> matching node:crypto", async () => {
    const body = new TextEncoder().encode('{"x":1}');
    const sig = await signBody(SECRET, body);
    const expected = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    expect(sig).toBe(expected);
  });
});

describe("verifySignature", () => {
  it("accepts a valid signature", async () => {
    const body = new TextEncoder().encode("hello");
    const sig = await signBody(SECRET, body);
    expect(await verifySignature(SECRET, body, sig)).toBe(true);
  });
  it("rejects a bad signature", async () => {
    const body = new TextEncoder().encode("hello");
    expect(await verifySignature(SECRET, body, "sha256=deadbeef")).toBe(false);
  });
  it("rejects a header without sha256= prefix", async () => {
    const body = new TextEncoder().encode("hello");
    expect(await verifySignature(SECRET, body, "nope")).toBe(false);
  });
});
