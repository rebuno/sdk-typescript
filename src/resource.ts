import { execution } from "./context.js";

export interface CheckpointPolicy {
  everySteps?: number;
  onCompletion?: boolean;
}

export interface ResourceDriver<THandle, TBinding = unknown> {
  driverId: string;
  configuration?: unknown;
  coverageReuse?: boolean;
  create(
    checkpointRef?: string,
  ):
    | { handle: THandle; binding: TBinding }
    | Promise<{ handle: THandle; binding: TBinding }>;
  open(binding: TBinding): THandle | Promise<THandle>;
  checkpoint?(handle: THandle): string | Promise<string>;
}

export interface ResourceOptions<THandle, TBinding = unknown> {
  driver: ResourceDriver<THandle, TBinding>;
  checkpoints?: CheckpointPolicy;
}

/** Register external state with the current execution and return its handle. */
export async function resource<THandle, TBinding = unknown>(
  key: string,
  opts: ResourceOptions<THandle, TBinding>,
): Promise<THandle> {
  return execution().registerResource(key, opts);
}
