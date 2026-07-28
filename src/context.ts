import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "./execution.js";

const storage = new AsyncLocalStorage<ExecutionContext>();

/** Run `fn` with `ctx` as the current execution context. */
export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Current execution context, or null. Internal. */
export function getExecution(): ExecutionContext | null {
  return storage.getStore() ?? null;
}

/** Current execution context; throws if accessed with no active execution. Public accessor. */
export function execution(): ExecutionContext {
  const ctx = storage.getStore();
  if (!ctx)
    throw new Error("execution() accessed without an active execution context");
  return ctx;
}
