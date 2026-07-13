import { getExecution } from "./context.js";
import type { Idempotency } from "./tool.js";

/** Record non-deterministic local work as a durable step, replayed identically on resume. */
export async function step<T = unknown>(
  name: string,
  fn: (args: Record<string, unknown>) => T | Promise<T>,
  args: Record<string, unknown> = {},
  idempotency: Idempotency = "safe_to_retry",
): Promise<T> {
  const ctx = getExecution();
  if (!ctx) throw new Error(`rebuno step('${name}') called outside an active execution.`);
  return (await ctx.invokeTool(name, args, { idempotency, run: async () => fn(args) })) as T;
}
