import {
  BACKUP_LRO_KIND,
  backupLroDedupeKey,
  getBackupOpReferenceTime,
  isBackupOpTimedOut,
} from "./backup-lro";

describe("backup-lro helpers", () => {
  it("builds a stable dedupe key per project", () => {
    expect(backupLroDedupeKey("abc")).toBe(`${BACKUP_LRO_KIND}:abc`);
  });

  it("prefers started_at over created_at for timeout checks", () => {
    expect(
      getBackupOpReferenceTime({
        created_at: "2026-03-18T00:00:00.000Z",
        started_at: "2026-03-18T01:00:00.000Z",
      }),
    ).toBe(new Date("2026-03-18T01:00:00.000Z").getTime());
  });

  it("treats ancient backup ops as timed out", () => {
    expect(
      isBackupOpTimedOut(
        {
          started_at: "2026-03-18T00:00:00.000Z",
        },
        new Date("2026-03-18T07:00:00.001Z").getTime(),
        6 * 60 * 60 * 1000,
      ),
    ).toBe(true);
  });

  it("does not time out recent backup ops", () => {
    expect(
      isBackupOpTimedOut(
        {
          created_at: "2026-03-18T00:00:00.000Z",
        },
        new Date("2026-03-18T05:59:59.999Z").getTime(),
        6 * 60 * 60 * 1000,
      ),
    ).toBe(false);
  });
});
