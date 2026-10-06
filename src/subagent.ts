import { Client } from "./client.js";
import { currentStepId, getExecution } from "./context.js";

/** Run `agentId` as a subagent of the calling tool and return its output.
 *
 * Return the result from the tool body: the kernel records the subagent's
 * outcome as the tool's step. Once every in-flight call of the execution waits,
 * the execution suspends, and the handler reruns after they settle.
 *
 * `client` needs the `executions:write` scope. Defaults to `new Client()`. */
export async function subagent<T = unknown>(
  agentId: string,
  input?: unknown,
  opts: { client?: Client } = {},
): Promise<T> {
  const ctx = getExecution();
  const stepId = currentStepId();
  if (!ctx || !stepId)
    throw new Error(`subagent('${agentId}') called outside a tool body.`);
  await (opts.client ?? new Client()).create(agentId, input, {
    spawnedBy: { executionId: ctx.id, stepId },
  });
  return (await ctx.awaitSubagent(stepId)) as T;
}
