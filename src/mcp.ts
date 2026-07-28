import { type Idempotency, type RebunoTool, wrapTool } from "./tool.js";

type CallFn = (
  toolName: string,
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;
type ToResult = (raw: unknown) => unknown;

export interface WrapMcpOptions {
  call: CallFn;
  prefix?: string;
  idempotency?: Idempotency;
  toResult?: ToResult;
}

export function wrapMcpTools(
  descriptors: Iterable<unknown>,
  opts: WrapMcpOptions,
): RebunoTool[] {
  return [...descriptors].map((d) => wrapMcpTool(d, opts));
}

export function wrapMcpTool(
  descriptor: unknown,
  opts: WrapMcpOptions,
): RebunoTool {
  const name = field<string>(descriptor, "name") ?? "";
  const description = field<string>(descriptor, "description") ?? "";
  const schema = field<unknown>(descriptor, "inputSchema") ?? null;
  const toolId = opts.prefix ? `${opts.prefix}_${name}` : name;

  return wrapTool({
    name: toolId,
    invoke: (args) => opts.call(name, args), // wire call uses the bare name
    description,
    inputSchema: schema,
    idempotency: opts.idempotency ?? "safe_to_retry",
    toResult: opts.toResult ?? defaultFlatten,
    transformArgs: stripNull,
  });
}

function field<T>(descriptor: unknown, key: string): T | undefined {
  if (descriptor && typeof descriptor === "object")
    return (descriptor as Record<string, unknown>)[key] as T | undefined;
  return undefined;
}

function stripNull(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v != null));
}

/** Flatten a standard MCP CallToolResult: structured content, else joined text blocks. */
function defaultFlatten(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const structured = o.structuredContent ?? o.structured_content;
  if (structured != null) return structured;
  const content = o.content;
  if (Array.isArray(content)) {
    const texts = content.map((b) => {
      const blk = b as Record<string, unknown>;
      return blk.type === "text" ? String(blk.text) : JSON.stringify(blk);
    });
    return texts.length === 1 ? texts[0] : texts.join("\n");
  }
  return raw;
}
