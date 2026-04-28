import { BACKUPS, isBackupsPath } from "./backups";
import { SNAPSHOTS, getSnapshotPathTarget, isSnapshotsPath } from "./snapshots";

describe("virtual path helpers", () => {
  test("isBackupsPath handles with and without leading slash", () => {
    expect(isBackupsPath(BACKUPS)).toBe(true);
    expect(isBackupsPath(`/${BACKUPS}`)).toBe(true);
    expect(isBackupsPath(`${BACKUPS}/2026-01-01`)).toBe(true);
    expect(isBackupsPath(`/${BACKUPS}/2026-01-01`)).toBe(true);
    expect(isBackupsPath("/tmp")).toBe(false);
  });

  test("isSnapshotsPath handles with and without leading slash", () => {
    expect(isSnapshotsPath(SNAPSHOTS)).toBe(true);
    expect(isSnapshotsPath(`/${SNAPSHOTS}`)).toBe(true);
    expect(isSnapshotsPath(`${SNAPSHOTS}/2026-01-01`)).toBe(true);
    expect(isSnapshotsPath(`/${SNAPSHOTS}/2026-01-01`)).toBe(true);
    expect(isSnapshotsPath(`/home/user/${SNAPSHOTS}`)).toBe(true);
    expect(isSnapshotsPath(`/home/user/${SNAPSHOTS}/2026-01-01`)).toBe(true);
    expect(isSnapshotsPath("/tmp")).toBe(false);
  });

  test("getSnapshotPathTarget detects snapshot roots and entries", () => {
    expect(getSnapshotPathTarget(".snapshots")).toEqual({
      kind: "snapshots-root",
    });
    expect(getSnapshotPathTarget(".snapshots/2026-01-01")).toEqual({
      kind: "snapshot",
      name: "2026-01-01",
    });
    expect(
      getSnapshotPathTarget("/home/user/.snapshots/2026-01-01/file.txt"),
    ).toEqual({
      kind: "snapshot-entry",
      name: "2026-01-01",
      relativePath: "file.txt",
    });
    expect(
      getSnapshotPathTarget("/mnt/projects/demo/.snapshots/2026-01-01", {
        homePath: "/mnt/projects/demo",
      }),
    ).toEqual({
      kind: "snapshot",
      name: "2026-01-01",
    });
    expect(getSnapshotPathTarget("/tmp")).toBeUndefined();
  });
});
