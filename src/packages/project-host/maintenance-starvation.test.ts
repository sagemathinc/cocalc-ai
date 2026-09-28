import { createMaintenanceStarvationQueue } from "./maintenance-starvation";
import type { StarvedMaintenance } from "./maintenance-starvation";

describe("shared maintenance starvation queue", () => {
  let now = 0;
  const items: StarvedMaintenance[] = [
    { projectId: "a", kind: "snapshot", retryAt: 0 },
    { projectId: "b", kind: "snapshot", retryAt: 0 },
    { projectId: "a", kind: "backup", retryAt: 0 },
    { projectId: "b", kind: "backup", retryAt: 0 },
  ];
  beforeEach(() => {
    now = 0;
  });

  it("alternates types and rotates projects across repeated stale listings", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    const attempts: string[] = [];
    for (let i = 0; i < 8; i++) {
      queue.update(items);
      const next = queue.next()!;
      attempts.push(`${next.kind}:${next.projectId}`);
      const release = queue.reserve(next.projectId, next.kind, 100)!;
      expect(release).toBeDefined();
      release(true);
      now += 100;
    }
    expect(attempts).toEqual([
      "snapshot:a",
      "backup:a",
      "snapshot:b",
      "backup:b",
      "snapshot:a",
      "backup:a",
      "snapshot:b",
      "backup:b",
    ]);
  });

  it("paces from completion, is single-flight, and releases idempotently", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    queue.update(items);
    const release = queue.reserve("a", "snapshot", 100)!;
    now = 1_000;
    expect(queue.reserve("a", "backup", 100)).toBeUndefined();
    release(true);
    now += 99;
    expect(queue.reserve("a", "backup", 100)).toBeUndefined();
    release(true);
    now++;
    expect(queue.reserve("a", "backup", 100)).toBeDefined();
  });

  it("does not charge denied admission or let partial updates displace the winner", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    queue.update(items);
    queue.reserve("a", "snapshot", 100)!(false);
    queue.update(
      items.filter((item) => item.projectId === "b"),
      ["b"],
    );
    expect(queue.reserve("b", "snapshot", 100)).toBeUndefined();
    expect(queue.next()).toEqual(items[0]);
    expect(queue.reserve("a", "snapshot", 100)).toBeDefined();
  });

  it("skips retry backoff and prunes removed, disabled or no-longer-overdue work", () => {
    const queue = createMaintenanceStarvationQueue(() => now);
    queue.update(
      items.map((item) => ({
        ...item,
        retryAt: item.projectId === "a" ? 100 : 0,
      })),
    );
    expect(queue.next()).toEqual(items[1]);
    queue.update([], ["b"]);
    expect(queue.next()).toBeUndefined();
    now = 100;
    expect(queue.next()?.projectId).toBe("a");
    queue.update([]);
    expect(queue.next()).toBeUndefined();
  });
});
