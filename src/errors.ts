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
  constructor(message: string, code: string, statusCode: number, details?: Record<string, unknown>) {
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
  constructor(message: string, opts: { toolId?: string; stepId?: string; retryable?: boolean } = {}) {
    super(message);
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
  approvalId: string | null;
  constructor(approvalId: string | null = null) {
    super("execution blocked awaiting approval");
    this.approvalId = approvalId;
  }
}

/** Control-flow signal: the execution is terminal (e.g. cancelled). */
export class Terminated extends RebunoError {}

const ERROR_BY_CODE: Record<string, new (m: string, c: string, s: number) => APIError> = {
  not_found: NotFoundError,
  validation_error: ValidationError,
  unauthorized: UnauthorizedError,
  forbidden: ForbiddenError,
  conflict: APIError,
};

export function errorFromResponse(code: string, message: string, statusCode: number, ruleId = ""): RebunoError {
  if (code === "policy_denied") return new PolicyError(message, ruleId);
  const Cls = ERROR_BY_CODE[code] ?? APIError;
  return new Cls(message, code, statusCode);
}
