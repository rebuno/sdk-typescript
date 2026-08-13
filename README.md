# Rebuno TypeScript SDK

Rebuno gives your agents durable execution (crash and resume without re-running side effects), an event-sourced record of everything they did, and optional governance over what they're allowed to do.

Durability works by recording every non-deterministic effect your handler
produces, so a resumed run replays the recorded result instead of doing the work
again. The SDK gives you three ways to record an effect:

- `defineTool(...)` — mark an async function as a durable tool call
- `rebunoFetch` — a `fetch` function that records LLM calls as durable steps (drop it
  into your OpenAI/Anthropic client)
- `step(...)` — record non-deterministic local work (time, randomness, ids) so
  it replays identically

## Installation

```bash
npm install rebuno
```

## Building an agent

```ts
import { Agent, defineTool } from "rebuno";

const search = defineTool({
  name: "search",
  execute: async ({ query }) => [`result for ${query}`],
});

async function process(input: { prompt: string }) {
  const hits = await search({ query: input.prompt });
  return { answer: hits };
}

const agent = new Agent("dev-agent", { secret: "dev-secret", baseUrl: "http://localhost:8080" });
await agent.serve({ port: 5000 }, process);
```

The handler receives the execution's input object unchanged. Pass an optional
`inputSchema` (any Standard Schema validator) to `new Agent(...)` to validate
input before dispatch.

`agent.serve({ port }, process)` binds `process` and serves the webhook endpoint
with `node:http` (this call resolves when the server closes). The kernel calls
that webhook to dispatch each execution; the agent runs `process` and records
every tool call durably, so crashes and pending approvals resume transparently
on the next dispatch — your handler code doesn't need to know the difference.

To mount the agent into an existing service or an edge runtime, use
`agent.fetch` — a Web-standard `(Request) => Promise<Response>` handler — instead
of `agent.serve(...)`:

```ts
app.post("/webhook", agent.fetch);
export const POST = agent.fetch;
```

## Tools

```ts
const search = defineTool({
  name: "search",
  execute: async ({ query }: { query: string }) => [`result for ${query}`],
});
```

`defineTool` returns an async function that routes through the kernel. Call
`search({ query })` yourself, or give it to your agent framework as the function
its tool calls:

```ts
import { tool } from "ai";
import { z } from "zod";

const searchTool = tool({
  description: "Search the web",
  inputSchema: z.object({ query: z.string() }),
  execute: search,
});
```

The framework owns the description and schema it shows the model; `search.name`
is the tool id the kernel records, so use it as the framework's id to keep policy
rules in sync.

Use `idempotency: "at_most_once"` for destructive operations that must not be
retried automatically (e.g. sending an email or charging a card).

If a tool does blocking or CPU-bound work, offload it (e.g. a worker thread) so
it doesn't block the event loop.

## Durable LLM calls

LLM calls are the most expensive and least deterministic thing an agent does, so
Rebuno records them too — without you rewriting how you call the model.
`rebunoFetch` is a `fetch`-compatible function you hand to your provider's client
(or the Vercel AI SDK):

```ts
import { rebunoFetch } from "rebuno";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ fetch: rebunoFetch });
```

It sits under the provider SDK: on the first run it forwards the request to the
provider and records the response as a durable step (`kind=llm_call`, the same
machinery as tool calls); on resume it replays the recorded response instead of
calling — and paying for — the model again. The request's `model` field is used
as the step target.

Streaming works the same way: `rebunoFetch` tees the provider's event stream to
your code while assembling it, records the assembled whole, and replays it as a
stream so `stream: true` still yields a stream on resume.

Recording only happens inside an execution — outside one, `rebunoFetch` is a
plain passthrough. One current limit: non-JSON request bodies aren't recognized
as LLM calls.

## Durable local work

Wrap non-deterministic local computation — the current time, random choices,
fresh ids — so its result is recorded once and replays identically on resume:

```ts
import { step } from "rebuno";

const chosen = await step("pick_winner", ({ candidates }) => candidates[0], { candidates });
```

## Building a client

Clients are used to create executions and inspect what they did. It talks to the
kernel's client/admin routes with Bearer auth.

```ts
import { Client } from "rebuno";

const client = new Client({ baseUrl: "http://localhost:8080", apiKey: "..." });
```

`baseUrl` and `apiKey` fall back to the `REBUNO_URL` and `REBUNO_API_KEY`
environment variables when omitted; `baseUrl` is required one way or the other.
Pass `timeout` (ms) to override the default 35s.

What you can do with it:

```ts
// executions
let execution = await client.create("dev-agent", { prompt: "hello" });
execution = await client.get(execution.id);
await client.cancel(execution.id);

// what an execution did (event log)
const events = await client.events(execution.id, { afterSeq: 0, limit: 100 });
```

Failed requests raise typed errors (`NotFoundError`, `UnauthorizedError`,
`PolicyError`, `NetworkError`, …) — all subclasses of `RebunoError`.

## Human-in-the-loop / approvals

Approvals are inspected and resolved through `Client`:

```ts
const pending = await client.listApprovals();
await client.grantApproval(pending[0].id, { decidedBy: "alice" });
```

## License

MIT
