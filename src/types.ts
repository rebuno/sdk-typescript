export type ExecutionStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface Execution {
  id: string;
  agentId: string;
  agentVersion: string;
  input: unknown;
  status: ExecutionStatus;
  output: unknown;
  failureReason: string;
}

export interface Step {
  stepId: string;
  executionId: string;
  kind: string;
  target: string;
  argsHash: string;
  occurrence: number;
  status: string;
  idempotency: string;
  args: unknown;
  result: unknown;
  error: unknown;
}

export interface StepDecision {
  decision: string;
  stepId: string;
  result: unknown;
  error: unknown;
  approvalId: string | null;
  reason: string;
}

export interface Event {
  executionId: string;
  eventSeq: number;
  type: string;
  payload: unknown;
  occurredAt: string;
}

export interface Approval {
  id: string;
  stepId: string;
  executionId: string;
  status: string;
  message: string;
  decidedBy: string;
  rationale: string;
}

type Raw = Record<string, unknown>;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);

export function parseExecution(r: Raw): Execution {
  return {
    id: str(r.id),
    agentId: str(r.agent_id),
    agentVersion: str(r.agent_version),
    input: r.input ?? null,
    status: str(r.status, "pending") as ExecutionStatus,
    output: r.output ?? null,
    failureReason: str(r.failure_reason),
  };
}

export function parseStep(r: Raw): Step {
  return {
    stepId: str(r.step_id),
    executionId: str(r.execution_id),
    kind: str(r.kind),
    target: str(r.target),
    argsHash: str(r.args_hash),
    occurrence: num(r.occurrence),
    status: str(r.status),
    idempotency: str(r.idempotency),
    args: r.args ?? null,
    result: r.result ?? null,
    error: r.error ?? null,
  };
}

export function parseStepDecision(r: Raw): StepDecision {
  return {
    decision: str(r.decision),
    stepId: str(r.step_id),
    result: r.result ?? null,
    error: r.error ?? null,
    approvalId: (r.approval_id ?? null) as string | null,
    reason: str(r.reason),
  };
}

export function parseEvent(r: Raw): Event {
  return {
    executionId: str(r.execution_id),
    eventSeq: num(r.event_seq),
    type: str(r.type),
    payload: r.payload ?? null,
    occurredAt: str(r.occurred_at),
  };
}

export function parseApproval(r: Raw): Approval {
  return {
    id: str(r.id),
    stepId: str(r.step_id),
    executionId: str(r.execution_id),
    status: str(r.status),
    message: str(r.message),
    decidedBy: str(r.decided_by),
    rationale: str(r.rationale),
  };
}
