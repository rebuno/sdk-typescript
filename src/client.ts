import { errorFromResponse, NetworkError } from "./errors.js";
import type { FetchFn } from "./kernel.js";
import { parseApproval, parseEvent, parseExecution, parseStep, type Approval, type Event, type Execution, type Step } from "./types.js";

const USER_AGENT = "rebuno-typescript-sdk";

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  fetch?: FetchFn;
}

export class Client {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;
  private fetchImpl: FetchFn;

  constructor(opts: ClientOptions = {}) {
    const url = opts.baseUrl ?? process.env.REBUNO_URL ?? "";
    if (!url) throw new Error("Client baseUrl is required (set REBUNO_URL or pass baseUrl)");
    this.baseUrl = url.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.REBUNO_API_KEY ?? "";
    this.timeout = opts.timeout ?? 35000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | number> } = {}): Promise<Response> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let url = this.baseUrl + path;
    if (opts.query) {
      const qs = new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)]));
      url += `?${qs.toString()}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method, headers, body, signal: ctrl.signal });
    } catch (e) {
      throw new NetworkError(String(e));
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 400) {
      const text = await resp.text();
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
      throw errorFromResponse(
        (data.code as string) ?? "internal_error",
        (data.message as string) ?? (text || "request failed"),
        resp.status,
        (data.rule_id as string) ?? "",
      );
    }
    return resp;
  }

  async create(agentId: string, input?: unknown, opts: { agentVersion?: string } = {}): Promise<Execution> {
    const body: Record<string, unknown> = { agent_id: agentId };
    if (input !== undefined) body.input = input;
    if (opts.agentVersion) body.agent_version = opts.agentVersion;
    const r = await this.request("POST", "/v0/executions", { body });
    return parseExecution(await r.json());
  }

  async get(executionId: string): Promise<Execution> {
    const r = await this.request("GET", `/v0/executions/${executionId}`);
    return parseExecution(await r.json());
  }

  async events(executionId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<Event[]> {
    const query: Record<string, string | number> = { limit: opts.limit ?? 100 };
    if (opts.afterSeq) query.after_seq = opts.afterSeq;
    const r = await this.request("GET", `/v0/executions/${executionId}/events`, { query });
    return ((await r.json()) as unknown[] ?? []).map((e) => parseEvent(e as Record<string, unknown>));
  }

  async cancel(executionId: string): Promise<void> {
    await this.request("POST", `/v0/executions/${executionId}/cancel`);
  }

  async listSteps(executionId: string, opts: { status?: string } = {}): Promise<Step[]> {
    const query = opts.status ? { status: opts.status } : undefined;
    const r = await this.request("GET", `/v0/executions/${executionId}/steps`, { query });
    return ((await r.json()) as unknown[] ?? []).map((s) => parseStep(s as Record<string, unknown>));
  }

  async getStep(executionId: string, stepId: string): Promise<Step> {
    const r = await this.request("GET", `/v0/executions/${executionId}/steps/${stepId}`);
    return parseStep(await r.json());
  }

  async listApprovals(opts: { status?: string } = {}): Promise<Approval[]> {
    const r = await this.request("GET", "/v0/approvals", { query: { status: opts.status ?? "pending" } });
    return ((await r.json()) as unknown[] ?? []).map((a) => parseApproval(a as Record<string, unknown>));
  }

  async getApproval(approvalId: string): Promise<Approval> {
    const r = await this.request("GET", `/v0/approvals/${approvalId}`);
    return parseApproval(await r.json());
  }

  async grantApproval(approvalId: string, opts: { decidedBy: string; rationale?: string }): Promise<void> {
    await this.request("POST", `/v0/approvals/${approvalId}/grant`, { body: { decided_by: opts.decidedBy, rationale: opts.rationale ?? "" } });
  }

  async denyApproval(approvalId: string, opts: { decidedBy: string; rationale?: string }): Promise<void> {
    await this.request("POST", `/v0/approvals/${approvalId}/deny`, { body: { decided_by: opts.decidedBy, rationale: opts.rationale ?? "" } });
  }
}
