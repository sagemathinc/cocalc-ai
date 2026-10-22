const query = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));

import {
  backupPurgeHealthLevel,
  backupPurgeHealthSummary,
  getBackupPurgeHealth,
  type BackupPurgeHealth,
} from "./backup-purge-health";

const clean: BackupPurgeHealth = {
  quarantined: 0,
  overdue: 0,
  overdue_critical: 0,
  oldest_overdue_due_at: null,
  oldest_quarantined_at: null,
};

describe("backup purge health", () => {
  it("is healthy with nothing quarantined or overdue", () => {
    expect(backupPurgeHealthLevel(clean)).toBe("healthy");
    expect(backupPurgeHealthSummary(clean)).toBe(
      "No deleted-project backup purge is quarantined or overdue.",
    );
  });

  it("warns on a short backlog past the due time", () => {
    expect(backupPurgeHealthLevel({ ...clean, overdue: 3 })).toBe("warning");
  });

  it("is critical when a purge is more than a day overdue", () => {
    expect(
      backupPurgeHealthLevel({ ...clean, overdue: 3, overdue_critical: 1 }),
    ).toBe("critical");
  });

  it("is critical for any quarantined purge, even if not counted overdue", () => {
    const health = {
      ...clean,
      quarantined: 147,
      oldest_quarantined_at: "2026-08-18T00:00:00.000Z",
    };
    expect(backupPurgeHealthLevel(health)).toBe("critical");
    expect(backupPurgeHealthSummary(health)).toContain(
      "147 deleted-project backup purges are quarantined",
    );
  });

  it("reads the counts and oldest timestamps from deleted_projects", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          quarantined: "147",
          overdue: "147",
          overdue_critical: "147",
          oldest_overdue_due_at: new Date("2026-07-26T00:00:00Z"),
          oldest_quarantined_at: new Date("2026-08-18T01:00:00Z"),
        },
      ],
    });
    await expect(getBackupPurgeHealth()).resolves.toEqual({
      quarantined: 147,
      overdue: 147,
      overdue_critical: 147,
      oldest_overdue_due_at: "2026-07-26T00:00:00.000Z",
      oldest_quarantined_at: "2026-08-18T01:00:00.000Z",
    });
    expect(query.mock.calls[0][0]).toContain("FROM deleted_projects");
    expect(query.mock.calls[0][1]).toEqual([24 * 60 * 60]);
  });

  it("uses the singular for one purge", () => {
    expect(
      backupPurgeHealthSummary({
        ...clean,
        quarantined: 1,
        overdue: 1,
        overdue_critical: 1,
      }),
    ).toBe(
      "1 deleted-project backup purge is quarantined and 1 is overdue (1 more than a day past due); their backups are kept past the retention promise until resolved.",
    );
  });
});
