import type { HostProjectMaintenanceSchedule } from "@cocalc/conat/project-host/api";
import { MaintenanceDispatchQueue } from "./maintenance-dispatch-queue";

function row(
  project_id: string,
  service: "paying" | "free" = "free",
  account = project_id,
): HostProjectMaintenanceSchedule {
  return {
    project_id,
    storage_service_class: service,
    storage_account_id: account,
    last_edited: null,
    snapshots: null,
    backups: null,
    backup_due_since: "2026-09-01T00:00:00Z",
  };
}
function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const due = (row: HostProjectMaintenanceSchedule) => row.backup_due_since;

it("admits new paying work before the remaining free tail without overlapping operations", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  const order: string[] = [];
  const run = async (row: HostProjectMaintenanceSchedule) => {
    order.push(row.project_id);
    if (row.project_id === "free-0") await held.promise;
  };
  const free = queue.submit({
    rows: Array.from({ length: 20 }, (_, i) => row(`free-${i}`)),
    observedAt: 1,
    parallelism: 1,
    due,
    run,
  });
  await flush();
  const paid = queue.submit({
    rows: [row("paid", "paying")],
    observedAt: 2,
    parallelism: 1,
    due,
    run,
  });
  await flush();
  expect(order).toEqual(["free-0"]);
  held.release();
  await paid;
  expect(order.slice(0, 2)).toEqual(["free-0", "paid"]);
  await free;
});

it("coalesces pending rows using the newest inventory and completes all submitters", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  const old = jest.fn(async (r) => {
    if (r.project_id === "active") await held.promise;
  });
  const fresh = jest.fn(async () => {});
  const first = queue.submit({
    rows: [row("active"), row("pending")],
    observedAt: 1,
    parallelism: 1,
    due,
    run: old,
  });
  await flush();
  const newer = queue.submit({
    rows: [row("pending", "paying")],
    observedAt: 3,
    parallelism: 1,
    due,
    run: fresh,
  });
  const stale = queue.submit({
    rows: [row("pending")],
    observedAt: 2,
    parallelism: 1,
    due,
    run: old,
  });
  held.release();
  await Promise.all([first, newer, stale]);
  expect(old).toHaveBeenCalledTimes(1);
  expect(fresh).toHaveBeenCalledTimes(1);
  expect(fresh).toHaveBeenCalledWith(
    expect.objectContaining({ storage_service_class: "paying" }),
    { afterRunning: false },
  );
});

it("preserves free progress and account rotation across new submissions", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  const order: string[] = [];
  const run = async (r: HostProjectMaintenanceSchedule) => {
    order.push(r.project_id);
    if (order.length === 1) await held.promise;
  };
  const first = queue.submit({
    rows: [
      ...Array.from({ length: 20 }, (_, i) =>
        row(`a-${String(i).padStart(2, "0")}`, "paying", "a"),
      ),
      row("free"),
    ],
    observedAt: 1,
    parallelism: 1,
    due,
    run,
  });
  await flush();
  const second = queue.submit({
    rows: [row("b", "paying", "b")],
    observedAt: 2,
    parallelism: 1,
    due,
    run,
  });
  held.release();
  await Promise.all([first, second]);
  expect(order[1]).toBe("b");
  expect(order[9]).toBe("free");
});

it("never runs two generations of the same project together", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  const run = jest.fn(async () => held.promise);
  const next = jest.fn(async () => {});
  const first = queue.submit({
    rows: [row("a")],
    observedAt: 1,
    parallelism: 2,
    due,
    run,
  });
  await flush();
  const second = queue.submit({
    rows: [row("a")],
    observedAt: 2,
    parallelism: 2,
    due,
    run: next,
  });
  await flush();
  expect(next).not.toHaveBeenCalled();
  held.release();
  await Promise.all([first, second]);
  expect(next).toHaveBeenCalledTimes(1);
  // A completed waiter cannot leave an active tombstone that loses a new waiter.
  await queue.submit({
    rows: [row("a")],
    observedAt: 3,
    parallelism: 2,
    due,
    run: next,
  });
  expect(next).toHaveBeenCalledTimes(2);
});

it("releases capacity after an unexpected worker error", async () => {
  const queue = new MaintenanceDispatchQueue();
  const run = jest.fn(async (r) => {
    if (r.project_id === "a") throw Error("failed");
  });
  const batch = queue.submit({
    rows: [row("a"), row("b")],
    observedAt: 1,
    parallelism: 1,
    due,
    run,
  });
  await expect(batch).rejects.toThrow("failed");
  await flush();
  expect(run).toHaveBeenCalledTimes(2);
});

it("shares the configured concurrency across overlapping submissions", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  let active = 0;
  let peak = 0;
  const run = async () => {
    active++;
    peak = Math.max(peak, active);
    await held.promise;
    active--;
  };
  const first = queue.submit({
    rows: [row("a"), row("b"), row("c")],
    observedAt: 1,
    parallelism: 2,
    due,
    run,
  });
  const second = queue.submit({
    rows: [row("d", "paying"), row("e", "paying")],
    observedAt: 2,
    parallelism: 2,
    due,
    run,
  });
  await flush();
  expect(active).toBe(2);
  held.release();
  await Promise.all([first, second]);
  expect(peak).toBe(2);
});

it("marks work submitted while the same project runs for a fresh read", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  const calls: { project_id: string; afterRunning: boolean }[] = [];
  const run = async (
    row: HostProjectMaintenanceSchedule,
    { afterRunning }: { afterRunning: boolean },
  ) => {
    calls.push({ project_id: row.project_id, afterRunning });
    if (calls.length === 1) await held.promise;
  };
  const first = queue.submit({
    rows: [row("a")],
    observedAt: 1,
    parallelism: 2,
    due,
    run,
  });
  await flush();
  const later = queue.submit({
    rows: [row("a"), row("b")],
    observedAt: 2,
    parallelism: 2,
    due,
    run,
  });
  await flush();
  held.release();
  await Promise.all([first, later]);
  expect(calls).toEqual([
    { project_id: "a", afterRunning: false },
    { project_id: "b", afterRunning: false },
    { project_id: "a", afterRunning: true },
  ]);
});
