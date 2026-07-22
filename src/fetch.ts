import { getExecution } from "./context.js";
import type { ExecutionContext } from "./execution.js";
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

const DELTA_FLUSH_CHARS = 2000;
const DELTA_FLUSH_INTERVAL_MS = 50;
const DELTA_MAX_CHARS = 6000;

/** A `fetch`-compatible function that records LLM calls as durable steps. */
export function createRebunoFetch(opts: RebunoFetchOptions = {}): FetchFn {
  const modelField = opts.modelField ?? "model";
  const inner = opts.fetch ?? fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctx = getExecution();
    if (!ctx) return inner(input, init);

    const payload = jsonBody(init);
    if (!payload) return inner(input, init);

    const target = String(payload[modelField] ?? "");
    const { stepId, dec } = await ctx.beginLlm(target, payload);
    if (dec.decision === "replay") return responseFromRecord(dec.result as ResponseRecord);

    const resp = await inner(input, init);
    const contentType = resp.headers.get("content-type") ?? "";
    if (resp.status < 400 && isEventStream(contentType) && resp.body) {
      // Tee the live stream to the caller while recording the assembled whole.
      return teeResponse(ctx, stepId, resp);
    }

    // Whole response (including error statuses): read under a lease, record it,
    // and hand back a reconstructed response.
    const stopHb = ctx.startHeartbeat();
    let body: string;
    try {
      body = await resp.text();
    } catch (e) {
      await ctx.failStepQuietly(stepId, e);
      throw e;
    } finally {
      stopHb();
    }
    const record: ResponseRecord = {
      status: resp.status,
      headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
      body,
    };
    await ctx.recordLlm(stepId, record);
    return responseFromRecord(record);
  }) as FetchFn;
}

/** Default rebunoFetch (model field `"model"`, global fetch). */
export const rebunoFetch: FetchFn = createRebunoFetch();

/**
 * Stream the provider's bytes to the caller while accumulating the whole and
 * publishing live deltas, then record the assembled response as the step result
 * when the stream ends. Recording fires once, from whichever comes first: the
 * source reaching EOF, or the consumer cancelling. A mid-stream error fails the step.
 */
function teeResponse(ctx: ExecutionContext, stepId: string, resp: Response): Response {
  const contentType = resp.headers.get("content-type") ?? "text/event-stream";
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder("utf-8"); // incremental: never splits a UTF-8 char
  const chunks: string[] = [];
  let pending = "";
  let seq = 0;
  let done = false;
  let lastFlush = Date.now();
  const stopHb = ctx.startHeartbeat(); // renew the lease while streaming

  const flush = async () => {
    for (let i = 0; i < pending.length; i += DELTA_MAX_CHARS) {
      await ctx.publishLlmDelta(stepId, seq, pending.slice(i, i + DELTA_MAX_CHARS));
      seq++;
    }
    pending = "";
  };

  // Record the assembled response, or fail the step, exactly once.
  const finish = async (error?: unknown) => {
    if (done) return;
    done = true;
    try {
      if (error !== undefined) {
        await ctx.failStepQuietly(stepId, error);
        return;
      }
      const tail = decoder.decode();
      if (tail) { chunks.push(tail); pending += tail; }
      if (pending) await flush();
      await ctx.recordLlm(stepId, { status: resp.status, headers: { "content-type": contentType }, body: chunks.join("") });
    } finally {
      stopHb();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: srcDone } = await reader.read();
        if (srcDone) {
          await finish();
          controller.close();
          return;
        }
        // Accumulate before enqueuing: a consumer that breaks right after
        // receiving a chunk never resumes us, so recording after would drop it.
        const text = decoder.decode(value, { stream: true });
        if (text) { chunks.push(text); pending += text; }
        controller.enqueue(value);
        const now = Date.now();
        if (pending.length >= DELTA_FLUSH_CHARS || now - lastFlush >= DELTA_FLUSH_INTERVAL_MS) {
          await flush();
          lastFlush = now;
        }
      } catch (e) {
        await finish(e);
        controller.error(e);
      }
    },
    async cancel() {
      // Consumer closed without draining to EOF: record here too. finish is idempotent.
      await finish();
      await reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, { status: resp.status, headers: { "content-type": contentType } });
}

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

/** True for a Server-Sent-Events content type. */
function isEventStream(contentType: string): boolean {
  return contentType.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
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
