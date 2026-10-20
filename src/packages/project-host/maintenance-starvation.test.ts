import { createMaintenanceStarvationQueue } from "./maintenance-starvation";
import type { StarvedMaintenance } from "./maintenance-starvation";

describe("shared maintenance starvation queue", () => {
  let now = 0;
  const items: StarvedMaintenance[] = [
    { projectId: "a", kind: "snapshot", retryAt: 0, dueAt: 20 },
    { projectId: "b", kind: "snapshot", retryAt: 0, dueAt: 10 },
    { projectId: "a", kind: "backup", retryAt: 0, dueAt: 20 },
    { projectId: "b", kind: "backup", retryAt: 0, dueAt: 10 },
  ];
  beforeEach(() => {
    now = 0;
  });

  it("takes the longest-overdue work first, then rotates through what was tried", () => {
    // 2026-10-16: prod hosts had work overdue since July behind newer work.
    const queue = createMaintenanceStarvationQueue(() => now);
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      // Repeated listings keep the attempt history.
      queue.update(items);
      const next = queue.next()!;
      order.push(`${next.kind}:${next.projectId}`);
      queue.reserve(next.projectId, next.kind, 100)!(true);
      now += 100;
    }
    // Oldest due (b) first in each kind; tried work goes behind untried, and
    // the least recently tried comes back first.
    expect(order).toEqual([
      "snapshot:b",
      "backup:b",
      "snapshot:a",
      "backup:a",
      "snapshot:b",
      "backup:b",
    ]);
  });

  it("paces each kind separately and is single-flight", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    queue.update(items);
    const release = queue.reserve("b", "snapshot", 60)!;
    expect(release).toBeDefined();
    // One override at a time, of either kind.
    expect(queue.reserve("b", "backup", 300)).toBeUndefined();
    release(true);
    release(true);
    // A snapshot just ran: the backup lane has its own pace.
    expect(queue.reserve("b", "backup", 300)).toBeDefined();
    now += 59;
    expect(queue.reserve("a", "snapshot", 60)).toBeUndefined();
    now += 1;
    expect(queue.nextAllowedAt("snapshot")).toBe(60);
  });

  it("does not charge denied admission or let partial updates displace the winner", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    queue.update(items);
    queue.reserve("b", "snapshot", 100)!(false);
    queue.update(
      items.filter((item) => item.projectId === "a"),
      ["a"],
    );
    expect(queue.reserve("a", "snapshot", 100)).toBeUndefined();
    expect(queue.next()).toEqual(items[1]);
    expect(queue.reserve("b", "snapshot", 100)).toBeDefined();
  });

  it("skips retry backoff and prunes removed, disabled or no-longer-overdue work", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    queue.update(
      items.map((item) => ({
        ...item,
        retryAt: item.projectId === "b" ? 100 : 0,
      })),
    );
    expect(queue.next()).toEqual(items[0]);
    queue.update([], ["a"]);
    expect(queue.next()).toBeUndefined();
    now = 100;
    expect(queue.next()?.projectId).toBe("b");
    queue.update([]);
    expect(queue.next()).toBeUndefined();
  });

  it("forgets attempt history of work that left the queue", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    const snapshots = items.filter((item) => item.kind === "snapshot");
    queue.update(snapshots);
    queue.reserve("b", "snapshot", 1)!(true);
    now += 1;
    // b was tried, so a goes next.
    expect(queue.next()?.projectId).toBe("a");
    queue.update(snapshots.filter((item) => item.projectId !== "b"));
    queue.update(snapshots);
    // b came back as new overdue work: oldest first again.
    expect(queue.next()?.projectId).toBe("b");
  });
});
