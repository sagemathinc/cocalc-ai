import {
  confirmedBackupForIds,
  confirmedBackupTimeForIds,
  newestBackupTimeForIds,
  parseCreatedBackupSnapshot,
  trackUploadedBackups,
} from "./backup-created";

describe("parseCreatedBackupSnapshot", () => {
  it("parses the created rustic backup snapshot shape", () => {
    const parsed = parseCreatedBackupSnapshot({
      id: "backup-1",
      time: "2026-05-22T12:34:56.000Z",
      snapshotGeneration: 1234,
      summary: { total_bytes_processed: 123, ignored: true },
    });

    expect(parsed).toEqual({
      id: "backup-1",
      time: new Date("2026-05-22T12:34:56.000Z"),
      summary: { total_bytes_processed: 123 },
      snapshotGeneration: 1234,
    });
  });

  it("rejects created values without a usable backup id", () => {
    expect(parseCreatedBackupSnapshot(undefined)).toBeUndefined();
    expect(parseCreatedBackupSnapshot({ time: new Date() })).toBeUndefined();
    expect(parseCreatedBackupSnapshot({ id: "" })).toBeUndefined();
  });
});

describe("confirmedBackupTimeForIds", () => {
  const created = new Set(["new-1", "new-2"]);
  const backups = [
    { id: "new-1", time: new Date("2026-09-23T10:00:00Z") },
    { id: "new-2", time: new Date("2026-09-23T11:00:00Z") },
  ];

  it("returns the newest time only when all created IDs are readable", () => {
    expect(confirmedBackupForIds({ backups, backupIds: created })).toEqual({
      id: "new-2",
      time: new Date("2026-09-23T11:00:00Z"),
    });
    expect(confirmedBackupTimeForIds({ backups, backupIds: created })).toEqual(
      new Date("2026-09-23T11:00:00Z"),
    );
    expect(
      confirmedBackupTimeForIds({
        backups: backups.slice(0, 1),
        backupIds: created,
      }),
    ).toBeUndefined();
    expect(
      confirmedBackupForIds({
        backups: backups.slice(0, 1),
        backupIds: created,
      }),
    ).toBeUndefined();
  });

  it("rejects missing or invalid repository times", () => {
    expect(
      confirmedBackupTimeForIds({
        backups: [{ id: "new-1", time: new Date("invalid") }, backups[1]],
        backupIds: created,
      }),
    ).toBeUndefined();
    expect(
      confirmedBackupTimeForIds({ backups, backupIds: new Set() }),
    ).toBeUndefined();
  });
});

describe("newestBackupTimeForIds", () => {
  it("uses the newest matching snapshot time and ignores unrelated backups", () => {
    const fallback = new Date("2026-05-22T10:00:00.000Z");

    expect(
      newestBackupTimeForIds({
        backupIds: new Set(["created-1", "created-2"]),
        fallback,
        backups: [
          { id: "other", time: new Date("2026-05-22T13:00:00.000Z") },
          { id: "created-1", time: new Date("2026-05-22T11:00:00.000Z") },
          { id: "created-2", time: new Date("2026-05-22T12:00:00.000Z") },
        ],
      }),
    ).toEqual(new Date("2026-05-22T12:00:00.000Z"));
  });
});

describe("trackUploadedBackups", () => {
  it("remembers uploads that the outer wrapper then abandons", async () => {
    const tracker = trackUploadedBackups(async (upload) => {
      await upload();
      throw new Error("volume changed");
    });
    await expect(
      tracker.wrapUpload(async () => ({
        id: "backup-1",
        time: "2026-10-15T20:37:37.000Z",
        summary: { data_added_packed: 3_000 },
      })),
    ).rejects.toThrow("volume changed");
    expect(tracker.uploaded()).toEqual([
      expect.objectContaining({
        id: "backup-1",
        summary: { data_added_packed: 3_000 },
      }),
    ]);
  });

  it("accounts an upload whose confirmation failed exactly once", async () => {
    const tracker = trackUploadedBackups();
    // The upload commits; a later step (e.g. confirming the snapshot exists)
    // fails with an ordinary error before afterCreate records it.
    await tracker.wrapUpload(async () => ({
      id: "backup-1",
      summary: { data_added_packed: 3_000 },
    }));
    const confirm = async () => {
      throw new Error("new backup is not confirmed in the repository");
    };
    await expect(confirm()).rejects.toThrow("not confirmed");
    expect(tracker.unaccounted(new Set()).map(({ id }) => id)).toEqual([
      "backup-1",
    ]);
    // A retry of the same run must not count it again.
    expect(tracker.unaccounted(new Set())).toEqual([]);
  });

  it("skips uploads that afterCreate already recorded", async () => {
    const tracker = trackUploadedBackups();
    await tracker.wrapUpload(async () => ({ id: "recorded" }));
    await tracker.wrapUpload(async () => ({ id: "abandoned" }));
    expect(
      tracker.unaccounted(new Set(["recorded"])).map(({ id }) => id),
    ).toEqual(["abandoned"]);
  });

  it("records nothing when the upload itself fails", async () => {
    const tracker = trackUploadedBackups();
    await expect(
      tracker.wrapUpload(async () => {
        throw new Error("upload failed");
      }),
    ).rejects.toThrow("upload failed");
    expect(tracker.uploaded()).toEqual([]);
  });
});
