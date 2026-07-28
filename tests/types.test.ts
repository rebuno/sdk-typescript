import { describe, expect, it } from "vitest";
import {
  parseApproval,
  parseEvent,
  parseExecution,
  parseStep,
  parseStepDecision,
} from "../src/types.js";

describe("parseExecution", () => {
  it("maps snake_case fields and passes input/output verbatim", () => {
    const e = parseExecution({
      id: "e1",
      agent_id: "a",
      agent_version: "v1",
      input: { prompt: "hi" },
      status: "running",
      output: null,
      failure_reason: "",
    });
    expect(e).toEqual({
      id: "e1",
      agentId: "a",
      agentVersion: "v1",
      input: { prompt: "hi" },
      status: "running",
      output: null,
      failureReason: "",
    });
  });
  it("defaults missing fields", () => {
    const e = parseExecution({ id: "e1" });
    expect(e.agentId).toBe("");
    expect(e.status).toBe("pending");
    expect(e.input).toBeNull();
  });
});

describe("parseStep", () => {
  it("maps fields, passes args/result/error verbatim", () => {
    const s = parseStep({
      step_id: "s1",
      execution_id: "e1",
      kind: "tool_call",
      target: "search",
      status: "succeeded",
      idempotency: "safe_to_retry",
      args: { q: "x" },
      result: [1, 2],
      error: null,
    });
    expect(s.stepId).toBe("s1");
    expect(s.executionId).toBe("e1");
    expect(s.result).toEqual([1, 2]);
  });
});

describe("parseStepDecision", () => {
  it("maps decision fields", () => {
    const d = parseStepDecision({
      decision: "replay",
      step_id: "s1",
      result: 5,
      approval_id: null,
      reason: "",
    });
    expect(d).toEqual({
      decision: "replay",
      stepId: "s1",
      result: 5,
      error: null,
      approvalId: null,
      reason: "",
    });
  });
});

describe("parseEvent / parseApproval", () => {
  it("maps event", () => {
    const ev = parseEvent({
      execution_id: "e1",
      event_seq: 3,
      type: "x",
      payload: { a: 1 },
      occurred_at: "t",
    });
    expect(ev).toEqual({
      executionId: "e1",
      eventSeq: 3,
      type: "x",
      payload: { a: 1 },
      occurredAt: "t",
    });
  });
  it("maps approval", () => {
    const ap = parseApproval({
      id: "ap1",
      step_id: "s1",
      execution_id: "e1",
      status: "pending",
      message: "m",
      decided_by: "",
      rationale: "",
    });
    expect(ap.stepId).toBe("s1");
    expect(ap.decidedBy).toBe("");
  });
});
