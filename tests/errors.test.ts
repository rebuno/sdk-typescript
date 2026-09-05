import { describe, expect, it } from "vitest";
import {
  APIError,
  Blocked,
  ConflictError,
  errorFromResponse,
  ForbiddenError,
  NotFoundError,
  PolicyError,
  RateLimited,
  RebunoError,
  raiseForRefusal,
  refusalMessage,
  Terminated,
  ToolError,
  UnauthorizedError,
  ValidationError,
} from "../src/errors.js";

const envelope = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status });

describe("errorFromResponse", () => {
  it.each([
    [400, "validation_error", ValidationError],
    [401, "unauthorized", UnauthorizedError],
    [403, "forbidden", ForbiddenError],
    [404, "not_found", NotFoundError],
    [409, "conflict", ConflictError],
  ])("maps %i %s", async (status, code, cls) => {
    const e = await errorFromResponse(envelope(status, { code, message: "x" }));
    expect(e).toBeInstanceOf(cls);
    expect((e as APIError).code).toBe(code);
    expect((e as APIError).statusCode).toBe(status);
  });

  it("maps policy_denied to PolicyError with ruleId", async () => {
    const e = await errorFromResponse(
      envelope(403, { code: "policy_denied", message: "nope", rule_id: "r1" }),
    );
    expect(e).toBeInstanceOf(PolicyError);
    expect((e as PolicyError).ruleId).toBe("r1");
  });

  it("maps execution_terminal to its control-flow error", async () => {
    const e = await errorFromResponse(
      envelope(409, { code: "execution_terminal", message: "gone" }),
    );
    expect(e).toBeInstanceOf(Terminated);
  });

  it("falls back to APIError for unknown codes", async () => {
    const e = await errorFromResponse(
      envelope(500, { code: "something_new", message: "weird" }),
    );
    expect(e).toBeInstanceOf(APIError);
    expect(e).not.toBeInstanceOf(NotFoundError);
    expect((e as APIError).code).toBe("something_new");
  });

  it("falls back to the body without an envelope", async () => {
    const e = await errorFromResponse(
      new Response("upstream is down", { status: 502 }),
    );
    expect(e).toBeInstanceOf(APIError);
    expect((e as APIError).code).toBe("internal_error");
    expect(e.message).toBe("upstream is down");
  });
});

describe("error classes", () => {
  it("ToolError carries toolId/stepId", () => {
    const e = new ToolError("boom", { toolId: "t", stepId: "s" });
    expect(e.toolId).toBe("t");
    expect(e.stepId).toBe("s");
    expect(e).toBeInstanceOf(RebunoError);
  });
  it("Blocked, RateLimited and Terminated are RebunoErrors", () => {
    expect(new Blocked()).toBeInstanceOf(RebunoError);
    expect(new RateLimited()).toBeInstanceOf(RebunoError);
    expect(new Terminated("done")).toBeInstanceOf(RebunoError);
  });
});

it("stops the reason at the marker line", () => {
  const body = JSON.stringify({
    error: {
      type: "rebuno_refusal",
      message: refusalMessage("denied", "budget_gone"),
    },
  });
  const provider = new Error(
    `Error code: 403 - ${body}\n\nRequest ID: req_abc123`,
  );
  expect(() => raiseForRefusal(provider)).toThrow(PolicyError);
  try {
    raiseForRefusal(provider);
  } catch (e) {
    expect((e as Error).message).toBe("budget_gone");
  }
});
