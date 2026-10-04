import { afterEach, describe, expect, it, vi } from "vitest";
import { execution } from "../src/context.js";
import {
  Blocked,
  CheckpointUnavailable,
  LeaseSuperseded,
  PolicyError,
  RateLimited,
  Terminated,
  ToolError,
} from "../src/errors.js";
import { type ResourceDriver, resource } from "../src/resource.js";
import { step } from "../src/step.js";
import { defineTool, wrapTool } from "../src/tool.js";
import type { Resource, StepDecision } from "../src/types.js";
import { fakeKernel, withContext } from "./helpers.js";

const LEASE = { dispatchId: "d1", attempt: 1, timeoutMs: 120000 };

function resourceKernel(
  view: Partial<Resource> = {},
  decisions: Partial<StepDecision>[] = [],
) {
  const views: Record<string, Resource> = {};
  const k = {
    ...fakeKernel(),
    registerResource: vi.fn(async (_id: string, registration: any) => {
      let v = views[registration.key];
      if (!v) {
        v = {
          key: registration.key,
          generation: 0,
          binding: null,
          checkpointRef: "",
          covered: false,
          everySteps: registration.everySteps,
          onCompletion: registration.onCompletion,
          ...view,
        };
        views[registration.key] = v;
      }
      if (!v.everySteps && registration.everySteps) {
        v.everySteps = registration.everySteps;
        v.onCompletion = registration.onCompletion;
      }
      return v;
    }),
    bindResource: vi.fn(async (_id: string, key: string, binding: unknown) => {
      views[key].binding = binding;
    }),
    publishCheckpoints: vi.fn(async (_id: string, records: any) => {
      for (const c of records.captures ?? []) views[c.key].covered = true;
    }),
    views,
  };
  for (const decision of decisions) {
    k.submitStep.mockResolvedValueOnce({
      decision: "proceed",
      stepId: "s1",
      result: null,
      error: null,
      approvalId: null,
      reason: "",
      ruleId: "",
      resources: [],
      ...decision,
    });
  }
  return k;
}

function driver() {
  let n = 0;
  return {
    driverId: "test.v1",
    configuration: { size: "small" },
    create: vi.fn(async (_checkpointRef?: string) => ({
      handle: { files: [] as string[] },
      binding: { sandboxId: "sbx-new" },
    })),
    open: vi.fn(async (_binding: { sandboxId: string }) => ({
      files: [] as string[],
    })),
    checkpoint: vi.fn(async (_handle: { files: string[] }) => `snap-${++n}`),
  } satisfies ResourceDriver<{ files: string[] }, { sandboxId: string }>;
}

const due = (key = "workspace", generation = 4) => ({
  key,
  generation,
  due: true,
});

afterEach(() => vi.restoreAllMocks());

describe("resource", () => {
  it.each([true, false])(
    "reuses bindings without captures when checkpoint support is %s",
    async (supportsCheckpoints) => {
      const k = resourceKernel({}, [{ resources: [{ ...due(), due: false }] }]);
      const d = driver();
      const reuse = supportsCheckpoints ? d : { ...d, checkpoint: undefined };
      await withContext(k, async () => {
        const handle = await resource("workspace", { driver: reuse });
        expect(handle.files).toEqual([]);
        expect(
          await step("write", () => "ok", {}, "safe_to_retry", ["workspace"]),
        ).toBe("ok");
        await execution().checkpointOnCompletion();
      });
      await withContext(k, async () => {
        await resource("workspace", { driver: reuse });
        await execution().checkpointOnCompletion();
      });
      expect(d.create).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(d.open).toHaveBeenCalledExactlyOnceWith({ sandboxId: "sbx-new" });
      expect(d.checkpoint).not.toHaveBeenCalled();
      expect(k.publishCheckpoints).not.toHaveBeenCalled();
      expect(k.views.workspace.everySteps).toBe(0);
      expect(k.views.workspace.onCompletion).toBe(false);
    },
  );

  it("enables checkpointing on an existing binding", async () => {
    const k = resourceKernel();
    const d = driver();
    await withContext(k, () => resource("workspace", { driver: d }));
    await withContext(k, () =>
      resource("workspace", { driver: d, checkpoints: { everySteps: 5 } }),
    );
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.open).toHaveBeenCalledExactlyOnceWith({ sandboxId: "sbx-new" });
    expect(d.checkpoint).toHaveBeenCalledTimes(1);
    expect(k.views.workspace.everySteps).toBe(5);
    expect(k.publishCheckpoints).toHaveBeenCalledTimes(1);
  });

  it("requires a checkpoint method when a policy is enabled", async () => {
    const k = resourceKernel();
    const d = { ...driver(), checkpoint: undefined };
    await expect(
      withContext(k, () =>
        resource("workspace", { driver: d, checkpoints: {} }),
      ),
    ).rejects.toThrow("driver.checkpoint");
    expect(d.create).not.toHaveBeenCalled();
  });

  it("creates, binds and captures a baseline once per dispatch", async () => {
    const k = resourceKernel();
    const d = driver();
    await withContext(k, async () => {
      const handle = await resource("workspace", {
        driver: d,
        checkpoints: { everySteps: 5, onCompletion: false },
      });
      expect(await resource("workspace", { driver: d })).toBe(handle);
      expect(d.create).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(k.registerResource).toHaveBeenCalledExactlyOnceWith(
        "e1",
        {
          key: "workspace",
          driverId: "test.v1",
          configuration: { size: "small" },
          coverageReuse: false,
          everySteps: 5,
          onCompletion: false,
        },
        LEASE,
      );
      expect(k.bindResource).toHaveBeenCalledExactlyOnceWith(
        "e1",
        "workspace",
        { sandboxId: "sbx-new" },
        LEASE,
      );
      expect(k.publishCheckpoints).toHaveBeenCalledExactlyOnceWith(
        "e1",
        {
          captures: [
            { key: "workspace", generation: 0, checkpointRef: "snap-1" },
          ],
        },
        LEASE,
      );
    });
  });

  it("opens an existing binding without restoring an older checkpoint", async () => {
    const k = resourceKernel({
      binding: { sandboxId: "sbx-existing" },
      checkpointRef: "older",
      generation: 3,
    });
    const d = driver();
    await withContext(k, () =>
      resource("workspace", { driver: d, checkpoints: {} }),
    );
    expect(d.open).toHaveBeenCalledExactlyOnceWith({
      sandboxId: "sbx-existing",
    });
    expect(d.create).not.toHaveBeenCalled();
    expect(k.bindResource).not.toHaveBeenCalled();
    expect(k.publishCheckpoints.mock.calls[0][1]).toEqual({
      captures: [{ key: "workspace", generation: 3, checkpointRef: "snap-1" }],
    });
  });

  it.each([true, false])(
    "restores the selected checkpoint with covered=%s",
    async (covered) => {
      const k = resourceKernel({
        checkpointRef: "selected",
        covered,
        generation: 7,
      });
      const d = driver();
      await withContext(k, () =>
        resource("workspace", { driver: d, checkpoints: {} }),
      );
      expect(d.create).toHaveBeenCalledExactlyOnceWith("selected");
      expect(d.checkpoint).toHaveBeenCalledTimes(covered ? 0 : 1);
      expect(k.publishCheckpoints).toHaveBeenCalledTimes(covered ? 0 : 1);
    },
  );

  it("stops initialization when the selected checkpoint is missing", async () => {
    const k = resourceKernel({ checkpointRef: "expired" });
    const d = driver();
    d.create.mockRejectedValue(new CheckpointUnavailable("expired"));
    await expect(
      withContext(k, () =>
        resource("workspace", { driver: d, checkpoints: {} }),
      ),
    ).rejects.toThrow(CheckpointUnavailable);
    expect(d.create).toHaveBeenCalledExactlyOnceWith("expired");
    expect(k.bindResource).not.toHaveBeenCalled();
    expect(k.publishCheckpoints).not.toHaveBeenCalled();
  });

  it("captures only when the kernel marks an affecting step due", async () => {
    const k = resourceKernel({ covered: true }, [
      { resources: [{ ...due(), due: false }] },
      { resources: [due()] },
    ]);
    const d = driver();
    await withContext(k, async () => {
      await resource("workspace", { driver: d, checkpoints: {} });
      const write = defineTool({
        name: "write",
        resources: ["workspace"],
        execute: () => "ok",
      });
      await write({});
      expect(d.checkpoint).not.toHaveBeenCalled();
      await write({});
    });
    expect(k.submitStep.mock.calls.map((c: any[]) => c[1].resources)).toEqual([
      ["workspace"],
      ["workspace"],
    ]);
    expect(k.completeStep.mock.calls.map((c: any[]) => [c[2], c[4]])).toEqual([
      ["ok", {}],
      [
        "ok",
        {
          captures: [
            { key: "workspace", generation: 4, checkpointRef: "snap-1" },
          ],
        },
      ],
    ]);
  });

  it("defaults tools and local steps to no resource changes", async () => {
    const k = resourceKernel({ covered: true });
    const d = driver();
    await withContext(k, async () => {
      await resource("workspace", { driver: d, checkpoints: {} });
      await defineTool({ name: "lookup", execute: () => "found" })({});
      await wrapTool({ name: "read", invoke: () => "read" })({});
      await wrapTool({ name: "read", resources: [], invoke: () => "read" })({});
      await wrapTool({
        name: "write",
        resources: ["workspace"],
        invoke: () => "ok",
      })({});
      await step("write", () => "written", {}, "safe_to_retry", ["workspace"]);
      await step("default", () => "ok");
    });
    expect(
      k.submitStep.mock.calls.map((c: any[]) => [
        c[1].kind,
        c[1].resources ?? [],
      ]),
    ).toEqual([
      ["tool_call", []],
      ["tool_call", []],
      ["tool_call", []],
      ["tool_call", ["workspace"]],
      ["local", ["workspace"]],
      ["local", []],
    ]);
    expect(d.checkpoint).not.toHaveBeenCalled();
  });

  it("preserves the outcome and other captures when one resource fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const k = resourceKernel({ covered: true }, [
      { resources: [due(), due("database", 9)] },
    ]);
    const d = driver();
    d.checkpoint.mockRejectedValue(new Error("snapshot failed"));
    await withContext(k, async () => {
      await resource("workspace", { driver: d, checkpoints: {} });
      await resource("database", { driver: driver(), checkpoints: {} });
      expect(
        await step("write", () => "done", {}, "safe_to_retry", [
          "workspace",
          "database",
        ]),
      ).toBe("done");
    });
    expect(k.completeStep.mock.calls[0]).toEqual([
      "e1",
      "s1",
      "done",
      LEASE,
      {
        captures: [{ key: "database", generation: 9, checkpointRef: "snap-1" }],
        captureFailures: [
          { key: "workspace", generation: 4, error: "snapshot failed" },
        ],
      },
    ]);
  });

  it("captures partial changes with a failed tool outcome", async () => {
    const k = resourceKernel({ covered: true }, [{ resources: [due()] }]);
    const d = driver();
    await withContext(k, async () => {
      const handle = await resource("workspace", {
        driver: d,
        checkpoints: {},
      });
      await expect(
        step(
          "write",
          () => {
            handle.files.push("partial");
            throw new Error("write failed");
          },
          {},
          "safe_to_retry",
          ["workspace"],
        ),
      ).rejects.toThrow(ToolError);
      expect(d.checkpoint).toHaveBeenCalledExactlyOnceWith({
        files: ["partial"],
      });
    });
    expect(k.failStep.mock.calls[0]).toEqual([
      "e1",
      "s1",
      { message: "write failed" },
      LEASE,
      {
        captures: [
          { key: "workspace", generation: 4, checkpointRef: "snap-1" },
        ],
      },
    ]);
    expect(k.completeStep).not.toHaveBeenCalled();
  });

  it.each([
    { result: "recorded", error: null },
    { result: null, error: { message: "recorded failure" } },
  ])("replays without running or capturing the tool", async (outcome) => {
    const k = resourceKernel({ covered: true }, [
      { decision: "replay", ...outcome, resources: [due()] },
    ]);
    const d = driver();
    const body = vi.fn(() => "live");
    await withContext(k, async () => {
      await resource("workspace", { driver: d, checkpoints: {} });
      const call = step("write", body, {}, "safe_to_retry", ["workspace"]);
      if (outcome.error) await expect(call).rejects.toThrow("recorded failure");
      else expect(await call).toBe("recorded");
    });
    expect(body).not.toHaveBeenCalled();
    expect(d.checkpoint).not.toHaveBeenCalled();
    expect(k.completeStep).not.toHaveBeenCalled();
    expect(k.failStep).not.toHaveBeenCalled();
  });

  it.each([
    new Blocked(),
    new Terminated("cancelled"),
    new LeaseSuperseded(),
    new PolicyError("denied"),
    new RateLimited(),
  ])(
    "propagates $name from capture without writing an outcome",
    async (signal) => {
      const k = resourceKernel({ covered: true }, [{ resources: [due()] }]);
      const d = driver();
      d.checkpoint.mockRejectedValue(signal);
      await withContext(k, async () => {
        await resource("workspace", { driver: d, checkpoints: {} });
        await expect(
          step("write", () => "ok", {}, "safe_to_retry", ["workspace"]),
        ).rejects.toBe(signal);
      });
      expect(k.completeStep).not.toHaveBeenCalled();
      expect(k.failStep).not.toHaveBeenCalled();
    },
  );

  it("finishes capture and outcome recording before another tool starts", async () => {
    const k = resourceKernel({ covered: true }, [
      { resources: [due()] },
      { resources: [due("workspace", 5)] },
    ]);
    const d = driver();
    const snapshots: string[][] = [];
    d.checkpoint.mockImplementation(async (handle) => {
      snapshots.push([...handle.files]);
      await Promise.resolve();
      return `snap-${snapshots.length}`;
    });
    const recorded: string[][] = [];
    await withContext(k, async () => {
      const handle = await resource("workspace", {
        driver: d,
        checkpoints: {},
      });
      k.completeStep.mockImplementation(async () => {
        await Promise.resolve();
        recorded.push([...handle.files]);
      });
      const write = defineTool({
        name: "write",
        resources: ["workspace"],
        execute: async ({ value }: { value: string }) => {
          handle.files.push(value);
          await Promise.resolve();
          return value;
        },
      });
      expect(
        await Promise.all([write({ value: "a" }), write({ value: "b" })]),
      ).toEqual(["a", "b"]);
    });
    expect(snapshots).toEqual([["a"], ["a", "b"]]);
    expect(recorded).toEqual(snapshots);
  });

  it("keeps calls concurrent in executions without resources", async () => {
    const k = fakeKernel();
    const started: string[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withContext(k, async () => {
      await Promise.all([
        step("first", async () => {
          started.push("first");
          await waiting;
        }),
        step("second", () => {
          started.push("second");
          release();
        }),
      ]);
    });
    expect(started).toEqual(["first", "second"]);
  });

  it("uses each resource's persisted completion policy and current generation", async () => {
    const k = resourceKernel({ covered: true });
    const a = driver();
    const b = driver();
    await withContext(k, async () => {
      await resource("workspace", {
        driver: a,
        checkpoints: { everySteps: 5 },
      });
      await resource("database", { driver: b, checkpoints: {} });
      const ctx = execution();
      await ctx.checkpointOnCompletion();
      expect(k.publishCheckpoints).not.toHaveBeenCalled();
      k.views.workspace.covered = false;
      k.views.workspace.generation = 7;
      k.views.database.covered = false;
      k.views.database.onCompletion = false;
      await ctx.checkpointOnCompletion();
    });
    expect(a.checkpoint).toHaveBeenCalledOnce();
    expect(b.checkpoint).not.toHaveBeenCalled();
    expect(k.publishCheckpoints).toHaveBeenCalledExactlyOnceWith(
      "e1",
      {
        captures: [
          { key: "workspace", generation: 7, checkpointRef: "snap-1" },
        ],
      },
      LEASE,
    );
  });
});
