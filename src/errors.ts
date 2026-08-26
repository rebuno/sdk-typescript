export class RebunoError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details ?? {};
  }
}

export class NetworkError extends RebunoError {}

export class APIError extends RebunoError {
  code: string;
  statusCode: number;
  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends APIError {}
export class UnauthorizedError extends APIError {}
export class ForbiddenError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}

export class PolicyError extends APIError {
  ruleId: string;
  constructor(message: string, ruleId = "") {
    super(message, "policy_denied", 403);
    this.ruleId = ruleId;
  }
}

export class ToolError extends RebunoError {
  toolId: string;
  stepId: string;
  retryable: boolean;
  constructor(
    message: string,
    opts: { toolId?: string; stepId?: string; retryable?: boolean } = {},
  ) {
    super(opts.toolId ? `${opts.toolId}: ${message}` : message);
    this.toolId = opts.toolId ?? "";
    this.stepId = opts.stepId ?? "";
    this.retryable = opts.retryable ?? false;
  }
}

export class RateLimited extends RebunoError {
  reason: string;
  constructor(reason = "rate_limit_exceeded") {
    super(reason);
    this.reason = reason;
  }
}

/** Control-flow signal: a step is awaiting human approval. */
export class Blocked extends RebunoError {
  constructor() {
    super("execution blocked awaiting approval");
  }
}

/** Control-flow signal: the execution is terminal (e.g. cancelled). */
export class Terminated extends RebunoError {}

export const REFUSAL_TYPE = "rebuno_refusal";

const REFUSAL_RE = new RegExp(`${REFUSAL_TYPE}: (\\w+)(?: reason=(.*))?`);
const TOKEN_RE = /^[a-z0-9_]+$/;
const DEFAULT_REASON: Record<string, string> = {
  denied: "policy_denied",
  rate_limited: "rate_limit_exceeded",
};

/** The marker a refused LLM call carries in its HTTP error body. */
export function refusalMessage(decision: string, reason = ""): string {
  let msg = `${REFUSAL_TYPE}: ${decision}`;
  if (reason) msg += ` reason=${reason}`;
  return msg;
}

/**
 * Re-throw a Rebuno refusal carried in a provider error as its control-flow error.
 *
 * A step the kernel refuses (approval pending, policy denial, rate limit) reaches
 * an LLM call as an HTTP error. Call this on the error the provider threw to get
 * `Blocked`, `PolicyError`, `RateLimited` or `Terminated` back, so the dispatch
 * unwinds. Returns silently for any other error.
 */
export function raiseForRefusal(err: unknown): void {
  // err and the errors it was thrown from.
  for (let e = err, i = 0; e != null && i < 10; i++, e = (e as Error).cause) {
    const message = String((e as Error).message ?? e);
    const m = REFUSAL_RE.exec(message);
    if (!m) continue;
    const [, decision, captured] = m;
    const reason =
      (captured ?? "").replace(/["'} \n]+$/, "") ||
      DEFAULT_REASON[decision] ||
      decision;
    if (decision === "blocked" || decision === "execution_blocked")
      throw new Blocked();
    if (decision === "execution_terminal") throw new Terminated(reason);
    if (decision === "denied") throw new PolicyError(reason);
    if (decision === "rate_limited") throw new RateLimited(reason);
    return;
  }
}

const ERROR_BY_CODE: Record<
  string,
  new (
    m: string,
    c: string,
    s: number,
  ) => APIError
> = {
  not_found: NotFoundError,
  validation_error: ValidationError,
  unauthorized: UnauthorizedError,
  forbidden: ForbiddenError,
  conflict: APIError,
};

export function errorFromResponse(
  code: string,
  message: string,
  statusCode: number,
  ruleId = "",
): RebunoError {
  if (code === "policy_denied") return new PolicyError(message, ruleId);
  const Cls = ERROR_BY_CODE[code] ?? APIError;
  return new Cls(message, code, statusCode);
}

/**
 * The text an execution's `failure_reason` records for `err`.
 *
 * Everything before the first colon is a stable token: a kernel reason
 * (`policy_denied`, `execution_token_budget_exceeded`, `approval_timeout`,
 * `indeterminate`, `rate_limit_exceeded`, `rate_limiter_unavailable`) or one of
 * `tool_error`, `agent_error`, `input_invalid`. A rule's own prose reason is not
 * a token, so it follows `policy_denied:`.
 */
export function failureReason(err: unknown): string {
  if (err instanceof PolicyError)
    return TOKEN_RE.test(err.message)
      ? err.message
      : `policy_denied: ${err.message}`;
  if (err instanceof RateLimited) return err.message;
  if (err instanceof ToolError) return `tool_error: ${err.message}`;
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const detail = err instanceof Error ? err.message : String(err);
  return `agent_error: ${name}: ${detail}`;
}
