import {
  assertManualSnapshotCreateAllowed,
  manualSnapshotQuota,
  normalizeManualSnapshotName,
  rollingSnapshotReservedSlots,
} from "./manual-snapshot-admission";

describe("manual snapshot admission", () => {
  it("reserves configured rolling snapshot slots", () => {
    expect(
      rollingSnapshotReservedSlots({
        frequent: 2,
        daily: 3,
        weekly: 1,
        monthly: 0,
      }),
    ).toBe(6);
    expect(
      rollingSnapshotReservedSlots({
        disabled: true,
        frequent: 2,
        daily: 3,
      }),
    ).toBe(0);
  });

  it("counts non-ISO snapshots against the manual quota", () => {
    expect(
      manualSnapshotQuota({
        totalLimit: 8,
        schedule: { frequent: 1, daily: 1, weekly: 0, monthly: 0 },
        snapshotNames: [
          "manual-demo",
          "2026-05-16T12:00:00.000Z",
          "before-install",
        ],
      }),
    ).toEqual({
      limit: 6,
      current: 2,
      rolling_reserved: 2,
    });
  });

  it("rejects when manual snapshots fill the non-rolling reserve", () => {
    expect(() =>
      assertManualSnapshotCreateAllowed({
        totalLimit: 3,
        schedule: { frequent: 1, daily: 1, weekly: 0, monthly: 0 },
        snapshotNames: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertManualSnapshotCreateAllowed({
        totalLimit: 3,
        schedule: { frequent: 1, daily: 1, weekly: 0, monthly: 0 },
        snapshotNames: ["named-1", "named-2"],
      }),
    ).toThrow("Manual snapshot limit reached");
  });

  it("normalizes missing and exact ISO names to manual names", () => {
    expect(normalizeManualSnapshotName("snapshot-1")).toBe("snapshot-1");
    expect(normalizeManualSnapshotName("2026-05-16T12:00:00.000Z")).toBe(
      "manual-2026-05-16T12:00:00.000Z",
    );
    expect(normalizeManualSnapshotName()).toMatch(/^manual-/);
  });
});
