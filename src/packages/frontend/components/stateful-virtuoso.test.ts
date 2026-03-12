import { hasViableSnapshotMetrics } from "./stateful-virtuoso";

describe("hasViableSnapshotMetrics", () => {
  it("rejects snapshots saved with a tiny viewport", () => {
    expect(
      hasViableSnapshotMetrics({
        viewportHeight: 24,
        scrollHeight: 800,
      }),
    ).toBe(false);
  });

  it("rejects snapshots saved without real scrollable height", () => {
    expect(
      hasViableSnapshotMetrics({
        viewportHeight: 200,
        scrollHeight: 180,
      }),
    ).toBe(false);
  });

  it("keeps snapshots with healthy viewport metrics", () => {
    expect(
      hasViableSnapshotMetrics({
        viewportHeight: 320,
        scrollHeight: 2400,
      }),
    ).toBe(true);
  });

  it("keeps legacy snapshots that do not record metrics", () => {
    expect(hasViableSnapshotMetrics({})).toBe(true);
  });
});
