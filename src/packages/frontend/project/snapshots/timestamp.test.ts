import {
  extractSnapshotTimestamp,
  formatSnapshotLocalTimestamp,
} from "./timestamp";

describe("snapshot timestamp helpers", () => {
  it("extracts ISO timestamps from plain snapshot names", () => {
    const timestamp = extractSnapshotTimestamp("2026-04-11T00:23:54.375Z");
    expect(timestamp?.toISOString()).toBe("2026-04-11T00:23:54.375Z");
  });

  it("extracts ISO timestamps embedded in named snapshots", () => {
    const timestamp = extractSnapshotTimestamp(
      "rootfs-publish-2026-04-10T16:01:40.971Z-778890ce-57dd-43ac-bf70-4aa8835c719c",
    );
    expect(timestamp?.toISOString()).toBe("2026-04-10T16:01:40.971Z");
  });

  it("returns undefined when no ISO timestamp is present", () => {
    expect(extractSnapshotTimestamp("manual-before-upgrade")).toBeUndefined();
  });

  it("formats extracted timestamps for the local timezone", () => {
    const timestamp = new Date("2026-04-11T00:23:54.375Z");
    expect(formatSnapshotLocalTimestamp(timestamp)).toBeTruthy();
  });
});
