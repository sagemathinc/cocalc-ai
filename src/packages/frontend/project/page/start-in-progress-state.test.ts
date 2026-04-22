import { isStartInProgressActive } from "./start-in-progress-state";

describe("isStartInProgressActive", () => {
  it("does not keep the delayed start banner visible after the project is running", () => {
    expect(
      isStartInProgressActive({
        lifecycleState: "running",
        startLro: { summary: { status: "running" } } as any,
        activeOp: { kind: "project-start", status: "running" },
      }),
    ).toBe(false);
  });

  it("still shows active start progress before the project reaches running", () => {
    expect(
      isStartInProgressActive({
        lifecycleState: "opened",
        startLro: { summary: { status: "running" } } as any,
      }),
    ).toBe(true);
  });

  it("shows lifecycle-only starts while waiting for detailed LRO progress", () => {
    expect(
      isStartInProgressActive({
        lifecycleState: "starting",
      }),
    ).toBe(true);
  });
});
