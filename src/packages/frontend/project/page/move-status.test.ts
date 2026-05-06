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

  it("only shows successful move operations when this session requires reopen", () => {
    expect(
      shouldRenderMoveStatus({
        op_id: "move-5",
        summary: { status: "succeeded" } as any,
      }),
    ).toBe(false);
    expect(
      shouldRenderMoveStatus(
        {
          op_id: "move-5b",
          summary: { status: "succeeded" } as any,
        },
        true,
      ),
    ).toBe(true);
    expect(
      shouldRenderMoveStatus({
        op_id: "move-6",
        summary: {
          status: "succeeded",
          dismissed_at: "2026-05-06T15:00:00.000Z",
        } as any,
      }),
    ).toBe(false);
    expect(shouldRenderMoveStatus(undefined)).toBe(false);
  });
});
