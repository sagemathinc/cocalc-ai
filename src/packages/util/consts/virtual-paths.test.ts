import { BACKUPS, isBackupsPath } from "./backups";
import { SNAPSHOTS, isSnapshotsPath } from "./snapshots";

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
    expect(isSnapshotsPath("/tmp")).toBe(false);
  });
});
