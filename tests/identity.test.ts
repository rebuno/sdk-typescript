import { describe, it, expect } from "vitest";
import { canonicalJson, argsHash, computeStepId } from "../src/identity.js";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("canonicalJson", () => {
  it("sorts keys, no whitespace", () => {
    expect(dec(canonicalJson({ z: 1, a: "hi" }))).toBe('{"a":"hi","z":1}');
  });
  it("escapes < > & and line/paragraph separators, Go-style", () => {
    expect(dec(canonicalJson("a<b>c&d"))).toBe('"a\\u003cb\\u003ec\\u0026d"');
    expect(dec(canonicalJson("  "))).toBe('"\\u2028\\u2029"');
  });
  it("encodes control chars, quote, backslash, tab, newline", () => {
    expect(dec(canonicalJson("\n\t\"\\"))).toBe('"\\n\\t\\"\\\\"');
  });
  it("nested + arrays", () => {
    expect(dec(canonicalJson({ nested: { b: 2, a: [1, 2, 3] }, s: "x" })))
      .toBe('{"nested":{"a":[1,2,3],"b":2},"s":"x"}');
  });
  it("empty object and array", () => {
    expect(dec(canonicalJson({}))).toBe("{}");
    expect(dec(canonicalJson([]))).toBe("[]");
  });
  it("matches Python golden vectors byte-for-byte", () => {
    // From: cd ../sdk-python && .venv/bin/python -c '...' (see Task 3 plan step 1)
    expect(dec(canonicalJson({ z: 1, a: "hi" }))).toBe('{"a":"hi","z":1}');
    expect(dec(canonicalJson({ nums: [0, -1, 1.5, 100] }))).toBe('{"nums":[0,-1,1.5,100]}');
  });
});

describe("argsHash", () => {
  it("matches Python golden hash", () => {
    expect(argsHash({ z: 1, a: "hi" })).toBe(
      "83956a3d49828a2674d6529c111779943608633dc7ac73657b465ababc6fcc36",
    );
  });
});

describe("computeStepId", () => {
  it("matches Python golden step id", () => {
    expect(computeStepId("exec-1", "tool_call", "search", argsHash({ q: "x" }), 0))
      .toBe("771a510883a622976244b5fb4ea7288842db75dea8ef5d90037b89256fae6658");
  });
});
