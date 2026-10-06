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

  it("keeps succeeded backups that skipped files visible until dismissed", () => {
    const result = {
      oversized_files: {
        max_file_bytes: 10_000_000_000,
        count: 1,
        files: [{ path: "huge.img", size: 1_000_000_000_000 }],
      },
    };
    expect(
      shouldDisplayBackupOp(
        makeOp({
          summary: {
            status: "succeeded",
            result,
            dismissed_at: null,
            dismissed_by: null,
          },
        }),
      ),
    ).toBe(true);
    expect(
      shouldDisplayBackupOp(
        makeOp({
          summary: {
            status: "succeeded",
            result,
            dismissed_at: new Date(),
            dismissed_by: "account",
          },
        }),
      ),
    ).toBe(false);
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
