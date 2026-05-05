import { shouldDisplayBackupOp } from "./backup-op-visibility";

function makeOp(overrides: Record<string, any> = {}): any {
  return {
    op_id: "op-1",
    summary: overrides.summary,
    last_progress: overrides.last_progress,
  };
}

describe("shouldDisplayBackupOp", () => {
  it("shows running backups", () => {
    expect(
      shouldDisplayBackupOp(
        makeOp({
          summary: {
            status: "running",
            dismissed_at: null,
            dismissed_by: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("shows failed backups until dismissed", () => {
    expect(
      shouldDisplayBackupOp(
        makeOp({
          summary: { status: "failed", dismissed_at: null, dismissed_by: null },
        }),
      ),
    ).toBe(true);
  });

  it("hides succeeded backups", () => {
    expect(
      shouldDisplayBackupOp(
        makeOp({
          summary: {
            status: "succeeded",
            dismissed_at: null,
            dismissed_by: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("hides dismissed failed backups", () => {
    expect(
      shouldDisplayBackupOp(
        makeOp({
          summary: {
            status: "failed",
            dismissed_at: new Date().toISOString(),
            dismissed_by: "user-1",
          },
        }),
      ),
    ).toBe(false);
  });
});
