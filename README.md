# Rebuno TypeScript SDK

TypeScript SDK for [Rebuno](https://github.com/rebuno/rebuno), an open-source
execution runtime for production agents.

## Install

```bash
npm install rebuno
```

Requires Node 22 or later. The SDK is ESM-only and has no runtime dependencies.

## An agent

```ts
import { Agent, defineTool } from "rebuno";

const search = defineTool({
  name: "search",
  execute: async ({ query }: { query: string }) => [`result for ${query}`],
});

async function process(input: { prompt: string }) {
  const hits = await search({ query: input.prompt });
  return { answer: hits };
}

const agent = new Agent("dev-agent", { secret: "dev-secret", baseUrl: "http://localhost:8080" });
await agent.serve({ port: 5000 }, process);
```

Every effect goes to the kernel as a step before it runs. On a re-dispatch the
handler runs again from the top, and any step with a recorded result replays it
instead of running a second time.

## Documentation

- [Getting started](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/getting-started.md): install, configuration, the dispatch loop, and a complete example.
- [Agents](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/agents.md): the `Agent` host, input validation, `serve` vs `fetch`, dispatch and resume, lifecycle.
- [Tools](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/tools.md): `defineTool`, `wrapTool`, idempotency, blocking work, and wrapping MCP tools.
- [LLM calls](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/llm-calls.md): `rebunoFetch` and `createRebunoFetch`.
- [Steps](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/steps.md): `step()` for durable local work.
- [Clients](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/client.md): creating and inspecting executions, and approvals.
- [Errors](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/errors.md): the error class hierarchy.
- [How it works](https://github.com/rebuno/rebuno/blob/main/docs/sdk/typescript/internals.md): step identity, replay, heartbeats, and the kernel protocol.

## License

[MIT](LICENSE)
