import { createBrowserExecOperations } from "./exec-operations";

const PROJECT_ID = "94ee01cf-2d7a-4e56-b8af-76d9a697877b";

const flushAsyncExec = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("browser exec operation admission", () => {
  it("rejects async exec starts while the active execution slot is saturated", async () => {
    let nextId = 0;
    let active = 0;
    const finishers: Array<(value: unknown) => void> = [];

    const ops = createBrowserExecOperations({
      maxExecOps: 10,
      execOpTtlMs: 60_000,
      maxExecCodeLength: 10_000,
      createExecId: () => `exec-${++nextId}`,
      resolveExecMode: () => ({
        posture: "prod",
        mode: "quickjs_wasm",
      }),
      claimExecutionSlot: () => {
        if (active >= 1) {
          throw Error("browser exec is busy");
        }
        active += 1;
        return () => {
          active -= 1;
        };
      },
      executeBrowserScript: async () =>
        await new Promise((resolve) => {
          finishers.push(resolve);
        }),
    });

    const first = ops.startExec({
      project_id: PROJECT_ID,
      code: "return 1;",
    });
    expect(first).toEqual({ exec_id: "exec-1", status: "running" });
    expect(active).toBe(1);

    expect(() =>
      ops.startExec({
        project_id: PROJECT_ID,
        code: "return 2;",
      }),
    ).toThrow("browser exec is busy");

    finishers.shift()?.("done");
    await flushAsyncExec();

    expect(ops.getExec({ exec_id: first.exec_id })).toMatchObject({
      status: "succeeded",
      result: "done",
    });
    expect(active).toBe(0);

    const second = ops.startExec({
      project_id: PROJECT_ID,
      code: "return 3;",
    });
    expect(second).toEqual({ exec_id: "exec-2", status: "running" });
    finishers.shift()?.("again");
    await flushAsyncExec();
    expect(active).toBe(0);
  });
});
