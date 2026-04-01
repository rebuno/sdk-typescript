# Rebuno TypeScript SDK

TypeScript client library for the [Rebuno](https://github.com/rebuno/rebuno) agent execution runtime.

## Installation

```bash
npm install rebuno
```

## Quick Start

```typescript
import { RebunoClient } from "rebuno";

const client = new RebunoClient({ baseUrl: "http://localhost:8080" });

const execution = await client.createExecution({
  agentId: "my-agent",
  input: { task: "hello" },
});
console.log(execution.executionId);
```

## Building an Agent

```typescript
import { BaseAgent, AgentContext } from "rebuno";

class MyAgent extends BaseAgent {
  async process(ctx: AgentContext): Promise<Record<string, unknown>> {
    const result = await ctx.invokeTool("web.search", { query: "hello" });
    return { answer: result };
  }
}

const agent = new MyAgent({
  agentId: "my-agent",
  kernelUrl: "http://localhost:8080",
});
await agent.run();
```

## Building a Runner

```typescript
import { BaseRunner } from "rebuno";

class MyRunner extends BaseRunner {
  async execute(toolId: string, args: Record<string, unknown>) {
    if (toolId === "web.search") {
      return { results: ["..."] };
    }
    throw new Error(`Unknown tool: ${toolId}`);
  }
}

const runner = new MyRunner({
  runnerId: "my-runner",
  kernelUrl: "http://localhost:8080",
  capabilities: ["web.search"],
});
await runner.run();
```

## Tool Adapters

The SDK includes adapters for popular AI frameworks. Install the framework as a peer dependency and import the adapter:

```typescript
// Vercel AI SDK
import { toVercelTools } from "rebuno/tools/adapters/vercel";

// LangChain
import { toLangChainTools } from "rebuno/tools/adapters/langchain";

// Mastra
import { toMastraTools } from "rebuno/tools/adapters/mastra";
```

## MCP Support

Connect to MCP servers to expose their tools through the kernel:

```typescript
const runner = new MyRunner({
  runnerId: "mcp-tools",
  kernelUrl: "http://localhost:8080",
});
runner.mcpServer("filesystem", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
});
await runner.run();
```

## Documentation

See the [full documentation](https://github.com/rebuno/rebuno/tree/main/docs).

## License

MIT
