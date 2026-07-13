import { getExecution } from "./context.js";
import type { FetchFn } from "./kernel.js";

export interface RebunoFetchOptions {
  modelField?: string;
  fetch?: FetchFn;
}

interface ResponseRecord {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A `fetch`-compatible function that records LLM calls as durable steps. */
export function createRebunoFetch(opts: RebunoFetchOptions = {}): FetchFn {
  const modelField = opts.modelField ?? "model";
  const inner = opts.fetch ?? fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctx = getExecution();
    if (!ctx) return inner(input, init);

    const payload = jsonBody(init);
    if (!payload) return inner(input, init);
    if (payload.stream) {
      console.warn("rebuno: streaming LLM call is not durable; passing through");
      return inner(input, init);
    }

    const target = String(payload[modelField] ?? "");
    const forward = async (): Promise<ResponseRecord> => {
      const resp = await inner(input, init);
      const body = await resp.text();
      return {
        status: resp.status,
        headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
        body,
      };
    };

    const record = (await ctx.invokeLlm(target, payload, { run: forward })) as ResponseRecord;
    return responseFromRecord(record);
  }) as FetchFn;
}

/** Default rebunoFetch (model field `"model"`, global fetch). */
export const rebunoFetch: FetchFn = createRebunoFetch();

function jsonBody(init?: RequestInit): Record<string, unknown> | null {
  const body = init?.body;
  if (typeof body !== "string") return null; // only string JSON bodies are identifiable LLM calls
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function responseFromRecord(record: ResponseRecord): Response {
  if (!record || typeof record !== "object") {
    return new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(record.body ?? "", {
    status: record.status ?? 200,
    headers: record.headers ?? { "content-type": "application/json" },
  });
}
