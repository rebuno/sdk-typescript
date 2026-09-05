import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "./execution.js";

const storage = new AsyncLocalStorage<ExecutionContext>();

export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getExecution(): ExecutionContext | null {
  return storage.getStore() ?? null;
}

export function execution(): ExecutionContext {
  const ctx = storage.getStore();
  if (!ctx)
    throw new Error("execution() accessed without an active execution context");
  return ctx;
}
