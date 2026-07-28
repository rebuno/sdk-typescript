import { describe, expect, it } from "vitest";
import {
  APIError,
  Blocked,
  errorFromResponse,
  ForbiddenError,
  NotFoundError,
  PolicyError,
  RateLimited,
  RebunoError,
  Terminated,
  ToolError,
  UnauthorizedError,
  ValidationError,
} from "../src/errors.js";

describe("errorFromResponse", () => {
  it("maps policy_denied to PolicyError with ruleId", () => {
    const e = errorFromResponse("policy_denied", "nope", 403, "rule-7");
    expect(e).toBeInstanceOf(PolicyError);
    expect((e as PolicyError).ruleId).toBe("rule-7");
    expect((e as PolicyError).code).toBe("policy_denied");
  });
  it("maps not_found to NotFoundError", () => {
    expect(errorFromResponse("not_found", "x", 404)).toBeInstanceOf(
      NotFoundError,
    );
  });
  it("maps validation_error to ValidationError", () => {
    expect(errorFromResponse("validation_error", "x", 400)).toBeInstanceOf(
      ValidationError,
    );
  });
  it("maps unauthorized to UnauthorizedError", () => {
    expect(errorFromResponse("unauthorized", "x", 401)).toBeInstanceOf(
      UnauthorizedError,
    );
  });
  it("maps forbidden to ForbiddenError", () => {
    const e = errorFromResponse("forbidden", "not an approver", 403);
    expect(e).toBeInstanceOf(ForbiddenError);
    expect((e as ForbiddenError).code).toBe("forbidden");
    expect((e as ForbiddenError).statusCode).toBe(403);
  });
  it("falls back to APIError for unknown codes", () => {
    const e = errorFromResponse("weird", "x", 500);
    expect(e).toBeInstanceOf(APIError);
    expect((e as APIError).code).toBe("weird");
  });
});

describe("error classes", () => {
  it("ToolError carries toolId/stepId", () => {
    const e = new ToolError("boom", { toolId: "t", stepId: "s" });
    expect(e.toolId).toBe("t");
    expect(e.stepId).toBe("s");
    expect(e).toBeInstanceOf(RebunoError);
  });
  it("Blocked carries approvalId", () => {
    expect(new Blocked("ap1").approvalId).toBe("ap1");
  });
  it("RateLimited and Terminated are RebunoErrors", () => {
    expect(new RateLimited()).toBeInstanceOf(RebunoError);
    expect(new Terminated("done")).toBeInstanceOf(RebunoError);
  });
});
