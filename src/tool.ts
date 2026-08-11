import { getExecution } from "./context.js";
import { PolicyError } from "./errors.js";

export type Idempotency = "safe_to_retry" | "at_most_once";

async function routeTool<TResult>(
  name: string,
  call: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    return `${name} not allowed. reason: ${err.message}` as TResult;
  }
}

export interface RebunoTool<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  name: string;
  description: string;
  inputSchema: unknown;
  idempotency: Idempotency;
  execute: (args: TArgs) => Promise<TResult>;
}

export interface DefineToolOptions<TArgs, TResult> {
  name: string;
  description?: string;
  inputSchema?: unknown;
  idempotency?: Idempotency;
  execute: (args: TArgs) => TResult | Promise<TResult>;
}

/** Register a durable tool. The returned `execute` routes through the kernel. */
export function defineTool<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
>(opts: DefineToolOptions<TArgs, TResult>): RebunoTool<TArgs, TResult> {
  const idempotency = opts.idempotency ?? "safe_to_retry";
  const execute = async (args: TArgs): Promise<TResult> => {
    const ctx = getExecution();
    if (!ctx) {
      throw new Error(
        `tool '${opts.name}' called outside an active execution. ` +
          `Tools run inside a handler under agent.serve()/agent.fetch (or a test context).`,
      );
    }
    return routeTool(opts.name, async () =>
      (await ctx.invokeTool(opts.name, args, {
        idempotency,
        run: async () => opts.execute(args),
      })) as TResult,
    );
  };
  return {
    name: opts.name,
    description: opts.description ?? "",
    inputSchema: opts.inputSchema ?? null,
    idempotency,
    execute,
  };
}

export interface WrapToolOptions<TResult> {
  name: string;
  invoke: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  description?: string;
  inputSchema?: unknown;
  idempotency?: Idempotency;
  toResult?: (raw: unknown) => TResult;
  transformArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
}

/** Wrap an arbitrary tool (framework object, schema-only) as a durable RebunoTool. */
export function wrapTool<TResult = unknown>(
  opts: WrapToolOptions<TResult>,
): RebunoTool<Record<string, unknown>, TResult> {
  const idempotency = opts.idempotency ?? "safe_to_retry";
  const execute = async (kwargs: Record<string, unknown>): Promise<TResult> => {
    const ctx = getExecution();
    if (!ctx) {
      throw new Error(
        `tool '${opts.name}' called outside an active execution.`,
      );
    }
    const args = opts.transformArgs
      ? opts.transformArgs(kwargs)
      : { ...kwargs };
    const run = async (): Promise<unknown> => {
      const result = await opts.invoke(args);
      return opts.toResult ? opts.toResult(result) : result;
    };
    return routeTool(
      opts.name,
      async () =>
        (await ctx.invokeTool(opts.name, args, {
          idempotency,
          run,
        })) as TResult,
    );
  };
  return {
    name: opts.name,
    description: opts.description ?? "",
    inputSchema: opts.inputSchema ?? null,
    idempotency,
    execute,
  };
}
