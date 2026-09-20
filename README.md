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

- [Getting started](https://docs.rebuno.io/sdk/typescript/getting-started): install, configuration, the dispatch loop, and a complete example.
- [Agents](https://docs.rebuno.io/sdk/typescript/agents): the `Agent` host, input validation, `serve` vs `fetch`, dispatch and resume, lifecycle.
- [Tools](https://docs.rebuno.io/sdk/typescript/tools): `defineTool`, `wrapTool`, idempotency, blocking work, and wrapping MCP tools.
- [LLM calls](https://docs.rebuno.io/sdk/typescript/llm-calls): `rebunoFetch` and `createRebunoFetch`.
- [Steps](https://docs.rebuno.io/sdk/typescript/steps): `step()` for durable local work.
- [Clients](https://docs.rebuno.io/sdk/typescript/client): creating and inspecting executions, and approvals.
- [Errors](https://docs.rebuno.io/sdk/typescript/errors): the error class hierarchy.
- [How it works](https://docs.rebuno.io/sdk/typescript/internals): step identity, replay, heartbeats, and the kernel protocol.

## License

[MIT](LICENSE)
