import { shouldRenderMoveStatus } from "./move-status";

describe("shouldRenderMoveStatus", () => {
  it("shows queued and running move operations", () => {
    expect(
      shouldRenderMoveStatus({
        op_id: "move-1",
        summary: { status: "queued" } as any,
      }),
    ).toBe(true);
    expect(
      shouldRenderMoveStatus({
        op_id: "move-2",
        summary: { status: "running" } as any,
      }),
    ).toBe(true);
  });

  it("keeps failed move operations visible until dismissed", () => {
    expect(
      shouldRenderMoveStatus({
        op_id: "move-3",
        summary: { status: "failed" } as any,
      }),
    ).toBe(true);
    expect(
      shouldRenderMoveStatus({
        op_id: "move-4",
        summary: {
          status: "failed",
          dismissed_at: "2026-05-05T03:00:00.000Z",
        } as any,
      }),
    ).toBe(false);
  });

  it("hides successful move operations", () => {
    expect(
      shouldRenderMoveStatus({
        op_id: "move-5",
        summary: { status: "succeeded" } as any,
      }),
    ).toBe(false);
    expect(shouldRenderMoveStatus(undefined)).toBe(false);
  });
});
