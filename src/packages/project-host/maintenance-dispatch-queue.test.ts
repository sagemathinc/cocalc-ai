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

it("returns detached submissions once queued without holding waiters", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  const started: string[] = [];
  const run = async (row: HostProjectMaintenanceSchedule) => {
    started.push(row.project_id);
    await held.promise;
  };
  // Repeated sweeps over the same backlog, as while a long backup runs.
  for (let observedAt = 1; observedAt <= 5; observedAt++) {
    await queue.submit({
      rows: [row("a"), row("b")],
      observedAt,
      parallelism: 1,
      due,
      run,
      detach: true,
    });
  }
  await flush();
  expect(started).toEqual(["a"]);
  const internal = queue as unknown as {
    active: Map<string, { waiters: unknown[] }>;
    pending: Map<string, { waiters: unknown[] }>;
  };
  expect(internal.active.get("a")?.waiters).toEqual([]);
  expect(internal.pending.get("b")?.waiters).toEqual([]);
  held.release();
  await flush();
  await flush();
  // The newer row for "a" still runs once after the operation it queued behind.
  expect([...started].sort()).toEqual(["a", "a", "b"]);
});

it("reports failures of detached work to onError", async () => {
  const queue = new MaintenanceDispatchQueue();
  const onError = jest.fn();
  await queue.submit({
    rows: [row("a")],
    observedAt: 1,
    parallelism: 1,
    due,
    run: async () => {
      throw new Error("boom");
    },
    detach: true,
    onError,
  });
  await flush();
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "boom" }),
    expect.objectContaining({ project_id: "a" }),
  );
});

it("gives a refused operation's account turn back", async () => {
  const queue = new MaintenanceDispatchQueue();
  const held = gate();
  const order: string[] = [];
  const dated = (id: string, account: string, at: string) => ({
    ...row(id, "paying", account),
    backup_due_since: at,
  });
  const run = async (r: HostProjectMaintenanceSchedule) => {
    order.push(r.project_id);
    // Storage admission refuses the oldest debt, e.g. in a recovery window.
    if (r.project_id === "old-1") return "deferred" as const;
    if (r.project_id === "busy") await held.promise;
  };
  const first = queue.submit({
    rows: [
      dated("old-1", "a", "2026-09-01T00:00:00Z"),
      dated("busy", "b", "2026-09-02T00:00:00Z"),
    ],
    observedAt: 1,
    parallelism: 1,
    due,
    run,
  });
  await flush();
  await flush();
  expect(order).toEqual(["old-1", "busy"]);
  // The refused project comes back while the queue is still busy, together
  // with an account that has never been served.
  const second = queue.submit({
    rows: [
      dated("new", "c", "2026-09-03T00:00:00Z"),
      dated("old-1", "a", "2026-09-01T00:00:00Z"),
    ],
    observedAt: 2,
    parallelism: 1,
    due,
    run: async (r) => {
      order.push(r.project_id);
    },
  });
  held.release();
  await Promise.all([first, second]);
  expect(order).toEqual(["old-1", "busy", "old-1", "new"]);
});

it.each([
  ["in dispatch order", ["a1", "a2"]],
  ["in reverse order", ["a2", "a1"]],
])(
  "gives back every turn of concurrent refusals finishing %s",
  async (_label, finishOrder) => {
    const queue = new MaintenanceDispatchQueue();
    const busy = gate();
    const refusals = new Map(["a1", "a2"].map((id) => [id, gate()] as const));
    const order: string[] = [];
    const dated = (id: string, account: string, at: string) => ({
      ...row(id, "paying", account),
      backup_due_since: at,
    });
    const first = queue.submit({
      rows: [
        dated("a1", "a", "2026-09-01T00:00:00Z"),
        dated("busy", "b", "2026-09-02T00:00:00Z"),
        dated("a2", "a", "2026-09-03T00:00:00Z"),
      ],
      observedAt: 1,
      parallelism: 3,
      due,
      run: async (r) => {
        order.push(r.project_id);
        if (r.project_id === "busy") return await busy.promise;
        await refusals.get(r.project_id)!.promise;
        return "deferred" as const;
      },
    });
    await flush();
    expect(order.sort()).toEqual(["a1", "a2", "busy"]);
    for (const id of finishOrder) {
      refusals.get(id)!.release();
      await flush();
      await flush();
    }
    // While "busy" still runs (so the queue keeps its turns), the refused
    // oldest project returns with an account that was never served.
    order.length = 0;
    const second = queue.submit({
      rows: [
        dated("new", "c", "2026-09-04T00:00:00Z"),
        dated("a1", "a", "2026-09-01T00:00:00Z"),
      ],
      observedAt: 2,
      parallelism: 1,
      due,
      run: async (r) => {
        order.push(r.project_id);
      },
    });
    busy.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a1", "new"]);
  },
);

describe("requeue and parking", () => {
  const dated = (
    id: string,
    service: "paying" | "free",
    account: string,
    at: string,
  ) => ({ ...row(id, service, account), backup_due_since: at });
  const internal = (queue: MaintenanceDispatchQueue) =>
    queue as unknown as {
      pending: Map<
        string,
        { observedAt: number; afterRunning?: boolean; waiters: unknown[] }
      >;
      active: Map<string, unknown>;
    };
  const until = async (fn: () => boolean, ms = 2_000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  it("puts a refused item back in exactly its place and parks until the check clears", async () => {
    let blocked: string | undefined;
    const queue = new MaintenanceDispatchQueue({
      parkCheck: () => blocked,
      parkPollMs: 5,
    });
    const held = gate();
    const order: string[] = [];
    let refusedOnce = false;
    const run = async (r: HostProjectMaintenanceSchedule) => {
      order.push(r.project_id);
      if (r.project_id === "b" && !refusedOnce) {
        refusedOnce = true;
        blocked = "lifecycle_active";
        return { requeue: "lifecycle_active" };
      }
      if (r.project_id !== "b" && r.project_id !== "d") await held.promise;
    };
    let bDone = false;
    const first = queue.submit({
      rows: [
        dated("a", "paying", "acct-a", "2026-09-01T00:00:00Z"),
        dated("b", "paying", "acct-b", "2026-09-02T00:00:00Z"),
        dated("c", "paying", "acct-c", "2026-09-03T00:00:00Z"),
      ],
      observedAt: 1,
      parallelism: 3,
      due,
      run,
    });
    const bWaiter = queue
      .submit({
        rows: [dated("b", "paying", "acct-b", "2026-09-02T00:00:00Z")],
        observedAt: 1,
        parallelism: 3,
        due,
        run,
      })
      .then(() => {
        bDone = true;
      });
    await flush();
    await flush();
    expect(order.sort()).toEqual(["a", "b", "c"]);
    // b is pending again, same observation, no waiter settled; the lane parks.
    expect(queue.has("b")).toBe("pending");
    expect(internal(queue).pending.get("b")?.observedAt).toBe(1);
    // ...and reads its row afresh when it runs again.
    expect(internal(queue).pending.get("b")?.afterRunning).toBe(true);
    expect(bDone).toBe(false);
    expect(queue.status()).toMatchObject({
      parked: true,
      park_reason: "lifecycle_active",
      requeued_total: { lifecycle_active: 1 },
    });
    // A later arrival from a never-served account, due later, waits behind b.
    order.length = 0;
    void queue.submit({
      rows: [dated("d", "paying", "acct-d", "2026-09-04T00:00:00Z")],
      observedAt: 2,
      parallelism: 3,
      due,
      run,
      detach: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Parked: nothing popped while the check is blocked (several polls).
    expect(order).toEqual([]);
    expect(queue.status().requeued_total).toEqual({ lifecycle_active: 1 });
    blocked = undefined;
    await until(() => order.length >= 2);
    expect(order.slice(0, 2)).toEqual(["b", "d"]);
    await bWaiter;
    expect(bDone).toBe(true);
    expect(queue.status().parked).toBe(false);
    held.release();
    await first;
  });

  it("merges a requeued item into a newer submission: the newer row wins, all waiters wait once", async () => {
    const queue = new MaintenanceDispatchQueue({
      parkCheck: () => undefined,
      parkPollMs: 5,
    });
    const held = gate();
    const calls: { fn: string; afterRunning: boolean }[] = [];
    const old = async (
      _r: HostProjectMaintenanceSchedule,
      { afterRunning }: { afterRunning: boolean },
    ) => {
      calls.push({ fn: "old", afterRunning });
      await held.promise;
      return { requeue: "lifecycle_settle" };
    };
    const fresh = jest.fn(
      async (
        _r: HostProjectMaintenanceSchedule,
        { afterRunning }: { afterRunning: boolean },
      ) => {
        calls.push({ fn: "fresh", afterRunning });
      },
    );
    const first = queue.submit({
      rows: [row("a")],
      observedAt: 1,
      parallelism: 1,
      due,
      run: old,
    });
    await flush();
    const second = queue.submit({
      rows: [row("a", "paying")],
      observedAt: 2,
      parallelism: 1,
      due,
      run: fresh,
    });
    await flush();
    expect(internal(queue).pending.get("a")?.afterRunning).toBe(true);
    held.release();
    await Promise.all([first, second]);
    // The old operation was requeued into the newer pending entry: its newer
    // row and run are used once, after the poll, still marked afterRunning.
    expect(calls).toEqual([
      { fn: "old", afterRunning: false },
      { fn: "fresh", afterRunning: true },
    ]);
    expect(fresh).toHaveBeenCalledWith(
      expect.objectContaining({ storage_service_class: "paying" }),
      { afterRunning: true },
    );
  });

  it("keeps the free share after more than 64 paying dispatches, with a requeue inside the ring", async () => {
    let blocked: string | undefined;
    const queue = new MaintenanceDispatchQueue({
      parkCheck: () => blocked,
      parkPollMs: 2,
    });
    const hold = gate();
    const order: string[] = [];
    let requeued = false;
    const run = async (r: HostProjectMaintenanceSchedule) => {
      order.push(r.project_id);
      if (r.project_id === "hold") await hold.promise;
      if (r.project_id === "p-030" && !requeued) {
        requeued = true;
        return { requeue: "io_pressure_emergency" };
      }
    };
    // "hold" keeps the queue non-empty, so its interleave state survives.
    const holding = queue.submit({
      rows: [dated("hold", "paying", "acct-hold", "2026-01-01T00:00:00Z")],
      observedAt: 1,
      parallelism: 2,
      due,
      run,
    });
    const paying = Array.from({ length: 70 }, (_, i) =>
      dated(
        `p-${String(i).padStart(3, "0")}`,
        "paying",
        `acct-${i}`,
        `2026-09-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
      ),
    );
    await queue.submit({
      rows: paying,
      observedAt: 1,
      parallelism: 2,
      due,
      run,
    });
    expect(order.filter((id) => id.startsWith("p-")).length).toBe(71);
    // Now a free item arrives with more paying work: the derived count is
    // capped at 9, so the free one goes next.
    order.length = 0;
    await queue.submit({
      rows: [
        dated("free", "free", "acct-free", "2026-09-05T00:00:00Z"),
        ...Array.from({ length: 12 }, (_, i) =>
          dated(`q-${i}`, "paying", `acct-q-${i}`, "2026-09-01T00:00:00Z"),
        ),
      ],
      observedAt: 2,
      parallelism: 2,
      due,
      run,
    });
    expect(order.indexOf("free")).toBe(0);
    hold.release();
    await holding;
  });

  it("treats a full ring of given-back dispatches as at least nine paid", async () => {
    const queue = new MaintenanceDispatchQueue();
    const hold = gate();
    const order: string[] = [];
    const run = async (r: HostProjectMaintenanceSchedule) => {
      order.push(r.project_id);
      if (r.project_id === "hold") await hold.promise;
      // Refused before any work: their paid slots are given back.
      if (r.project_id.startsWith("refused-")) return "deferred" as const;
    };
    const holding = queue.submit({
      rows: [dated("hold", "paying", "acct-hold", "2026-01-01T00:00:00Z")],
      observedAt: 1,
      parallelism: 2,
      due,
      run,
    });
    // 66 refused and 4 completed paying dispatches, no free one: the ring
    // (64) no longer shows how many paid ran since the last free.
    await queue.submit({
      rows: Array.from({ length: 66 }, (_, i) =>
        dated(`refused-${i}`, "paying", `acct-r-${i}`, "2026-09-01T00:00:00Z"),
      ),
      observedAt: 1,
      parallelism: 2,
      due,
      run,
    });
    await queue.submit({
      rows: Array.from({ length: 4 }, (_, i) =>
        dated(`paid-${i}`, "paying", `acct-p-${i}`, "2026-09-02T00:00:00Z"),
      ),
      observedAt: 1,
      parallelism: 2,
      due,
      run,
    });
    order.length = 0;
    await queue.submit({
      rows: [
        dated("free", "free", "acct-free", "2026-09-05T00:00:00Z"),
        ...Array.from({ length: 3 }, (_, i) =>
          dated(`q-${i}`, "paying", `acct-q-${i}`, "2026-09-01T00:00:00Z"),
        ),
      ],
      observedAt: 2,
      parallelism: 2,
      due,
      run,
    });
    // Unknown history beyond the ring counts as "at least nine": free next.
    expect(order[0]).toBe("free");
    hold.release();
    await holding;
  });

  it("restores the account turn of an item requeued after it left the ring", async () => {
    let blocked: string | undefined;
    const queue = new MaintenanceDispatchQueue({
      parkCheck: () => blocked,
      parkPollMs: 2,
    });
    const old = gate();
    const order: string[] = [];
    let requeued = false;
    const run = async (r: HostProjectMaintenanceSchedule) => {
      order.push(r.project_id);
      if (r.project_id === "old" && !requeued) {
        await old.promise;
        requeued = true;
        return { requeue: "lifecycle_active" };
      }
    };
    const started = queue.submit({
      rows: [dated("old", "paying", "acct-old", "2026-08-01T00:00:00Z")],
      observedAt: 1,
      parallelism: 2,
      due,
      run,
    });
    await flush();
    await queue.submit({
      rows: Array.from({ length: 70 }, (_, i) =>
        dated(`p-${i}`, "paying", `acct-${i}`, "2026-09-01T00:00:00Z"),
      ),
      observedAt: 1,
      parallelism: 2,
      due,
      run,
    });
    order.length = 0;
    old.release();
    await until(() => order.length >= 1);
    // Its dispatch left the 64-entry ring long ago; its account turn is still
    // given back exactly, so it runs again first.
    expect(order[0]).toBe("old");
    await started;
  });

  it("holds no waiters for submissions made while parked", async () => {
    let blocked: string | undefined = "lifecycle_active";
    const queue = new MaintenanceDispatchQueue({
      parkCheck: () => blocked,
      parkPollMs: 2,
    });
    const run = jest.fn(async () => {});
    // The lane parks on its first look at the queue.
    await queue.submit({
      rows: [row("a")],
      observedAt: 0,
      parallelism: 1,
      due,
      run,
      detach: true,
    });
    expect(queue.status().parked).toBe(true);
    // e.g. a changed-project drain every 15 s during a long storm
    const submissions = Array.from({ length: 50 }, (_, i) =>
      queue.submit({
        rows: [row("a")],
        observedAt: i + 1,
        parallelism: 1,
        due,
        run,
      }),
    );
    await flush();
    await Promise.all(submissions);
    expect(internal(queue).pending.get("a")?.waiters).toEqual([]);
    expect(internal(queue).pending.get("a")?.observedAt).toBe(50);
    expect(run).not.toHaveBeenCalled();
    blocked = undefined;
    await until(() => run.mock.calls.length === 1);
  });

  it("never pops while the check is blocked before any dispatch", async () => {
    let blocked: string | undefined = "lifecycle_active";
    const queue = new MaintenanceDispatchQueue({
      parkCheck: () => blocked,
      parkPollMs: 2,
    });
    const run = jest.fn(async () => {});
    void queue.submit({
      rows: [row("a"), row("b")],
      observedAt: 1,
      parallelism: 1,
      due,
      run,
      detach: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(run).not.toHaveBeenCalled();
    expect(queue.status()).toMatchObject({
      parked: true,
      park_reason: "lifecycle_active",
      pending: 2,
      requeued_total: {},
    });
    blocked = undefined;
    await until(() => run.mock.calls.length === 2);
    expect(queue.status().parked).toBe(false);
    expect(queue.status().parked_ms_total).toBeGreaterThan(0);
  });
});

describe("max-age promotion", () => {
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const PROMOTE = { paying: 60 * 60_000, free: 4 * 60 * 60_000 };
  const aged = (
    project_id: string,
    service: "paying" | "free",
    account: string,
    ageMin: number,
    failures = 0,
  ): HostProjectMaintenanceSchedule => ({
    ...row(project_id, service, account),
    backup_due_since: new Date(NOW - ageMin * 60_000).toISOString(),
    snapshot_failures: failures,
  });
  const idle = async (queue: MaintenanceDispatchQueue) => {
    for (let i = 0; i < 10_000; i++) {
      const status = queue.status();
      if (status.pending === 0 && status.active === 0) return;
      await flush();
    }
    throw Error("the queue did not drain");
  };
  // Runs the rows one at a time; arrive(n) gives the rows submitted when the
  // n-th dispatch starts.
  const dispatchOrder = async (
    options: ConstructorParameters<typeof MaintenanceDispatchQueue>[0],
    initial: HostProjectMaintenanceSchedule[],
    arrive?: (n: number) => HostProjectMaintenanceSchedule[],
  ) => {
    const queue = new MaintenanceDispatchQueue({ now: () => NOW, ...options });
    const order: string[] = [];
    const run = async (r: HostProjectMaintenanceSchedule) => {
      order.push(r.project_id);
      const rows = arrive?.(order.length) ?? [];
      if (rows.length) {
        void queue.submit({
          rows,
          observedAt: order.length + 1,
          parallelism: 1,
          due,
          run,
          detach: true,
        });
      }
    };
    void queue.submit({
      rows: initial,
      observedAt: 1,
      parallelism: 1,
      due,
      run,
      detach: true,
    });
    await idle(queue);
    return { order, queue };
  };
  const fiveOfA = () =>
    Array.from({ length: 5 }, (_, i) => aged(`A-${i}`, "paying", "A", 120));
  // A new single-project account at every dispatch, for 30 dispatches.
  const newAccounts = (n: number) =>
    n <= 30 ? [aged(`new-${n}`, "paying", `acct-${n}`, 1)] : [];

  it("without promotion, an account's later projects wait out a stream of new accounts", async () => {
    const { order } = await dispatchOrder({}, fiveOfA(), newAccounts);
    expect(order[0]).toBe("A-0");
    // served only once the arrivals stop
    expect(order.indexOf("A-1")).toBe(31);
  });

  it("serves an account's overdue projects by the promote age, ahead of new accounts", async () => {
    const { order, queue } = await dispatchOrder(
      { promoteAfterMs: PROMOTE },
      fiveOfA(),
      newAccounts,
    );
    expect(order.slice(0, 5)).toEqual(["A-0", "A-1", "A-2", "A-3", "A-4"]);
    expect(queue.status().promoted_dispatched_total).toEqual({
      paying: 5,
      free: 0,
    });
  });

  it("a promoted dispatch takes its account's turn", async () => {
    const { order } = await dispatchOrder({ promoteAfterMs: PROMOTE }, [
      aged("A-old", "paying", "A", 120),
      aged("A-young", "paying", "A", 1),
      aged("B-young", "paying", "B", 1),
    ]);
    // Without the turn, A-young would go first (same due, lower id).
    expect(order).toEqual(["A-old", "B-young", "A-young"]);
  });

  it("a promoted free snapshot waits at most nine paying selections, even behind endless promoted paying work", async () => {
    const { order, queue } = await dispatchOrder(
      { promoteAfterMs: PROMOTE },
      [aged("F", "free", "f", 300), aged("P-0", "paying", "p0", 120)],
      (n) => (n <= 40 ? [aged(`P-${n}`, "paying", `p${n}`, 90)] : []),
    );
    expect(order.indexOf("F")).toBe(9);
    expect(order.slice(0, 9).every((id) => id.startsWith("P-"))).toBe(true);
    expect(queue.status().promoted_dispatched_total.free).toBe(1);
  });

  it("a promoted paying snapshot is never passed by younger arrivals, promoted or not", async () => {
    const initial = () => [
      aged("S", "paying", "x", 241),
      aged("Q", "paying", "x", 240),
      aged("P", "paying", "x", 180),
    ];
    const arrivals = (n: number) =>
      n <= 20
        ? [
            aged(`old-${n}`, "paying", `o${n}`, 120),
            aged(`young-${n}`, "paying", `y${n}`, 1),
          ]
        : [];
    const promoted = await dispatchOrder(
      { promoteAfterMs: PROMOTE },
      initial(),
      arrivals,
    );
    expect(promoted.order.slice(0, 3)).toEqual(["S", "Q", "P"]);
    // Without promotion the new accounts pass them.
    const plain = await dispatchOrder({}, initial(), arrivals);
    expect(plain.order.indexOf("Q")).toBeGreaterThan(3);
  });

  it("below the promote ages, the order is exactly today's", async () => {
    const rows = () => {
      const out: HostProjectMaintenanceSchedule[] = [];
      for (let i = 0; i < 24; i++) {
        const paying = i % 3 !== 0;
        out.push(
          aged(
            `r-${String(i).padStart(2, "0")}`,
            paying ? "paying" : "free",
            `acct-${i % 4}`,
            paying ? (i * 7) % 59 : (i * 37) % 239,
          ),
        );
      }
      return out;
    };
    const arrivals = (n: number) =>
      n <= 10
        ? [aged(`n-${n}`, n % 2 ? "paying" : "free", `acct-${n % 5}`, n)]
        : [];
    const today = await dispatchOrder({}, rows(), arrivals);
    const promoted = await dispatchOrder(
      { promoteAfterMs: PROMOTE },
      rows(),
      arrivals,
    );
    expect(promoted.order).toEqual(today.order);
    expect(promoted.queue.status().promoted_dispatched_total).toEqual({
      paying: 0,
      free: 0,
    });
  });

  it("never promotes work its promotable check refuses (failure backoff)", async () => {
    const promotable = (r: HostProjectMaintenanceSchedule) =>
      (r.snapshot_failures ?? 0) === 0;
    const order = async (failures: number) =>
      (
        await dispatchOrder({ promoteAfterMs: PROMOTE, promotable }, [
          aged("S", "paying", "a", 200),
          aged("F", "paying", "a", 180, failures),
          aged("B", "paying", "b", 1),
        ])
      ).order;
    // F's account was just served: unpromoted, B goes first.
    expect(await order(2)).toEqual(["S", "B", "F"]);
    // The control: without failures, F is promoted past B.
    expect(await order(0)).toEqual(["S", "F", "B"]);
  });

  it("serves one account's 20 promoted snapshots and the others' strictly by due, and reports them", async () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) =>
        aged(`A-${String(i).padStart(2, "0")}`, "paying", "A", 200 - i),
      ),
      aged("B-0", "paying", "B", 195.5),
      aged("B-1", "paying", "B", 185.5),
      aged("C-0", "paying", "C", 190.5),
      aged("C-1", "paying", "C", 182.5),
    ];
    const queue = new MaintenanceDispatchQueue({
      now: () => NOW,
      promoteAfterMs: PROMOTE,
    });
    const held = gate();
    const order: string[] = [];
    const done = queue.submit({
      rows,
      observedAt: 1,
      parallelism: 1,
      due,
      run: async (r) => {
        order.push(r.project_id);
        if (order.length === 1) await held.promise;
      },
    });
    await flush();
    // A-00, the oldest, runs; the other 23 wait, 19 of them A's.
    expect(queue.status()).toMatchObject({
      pending: 23,
      active: 1,
      promoted_pending: 23,
      promoted_largest_account_count: 19,
    });
    held.release();
    await done;
    const byAge = [...rows]
      .sort(
        (a, b) =>
          Date.parse(a.backup_due_since!) - Date.parse(b.backup_due_since!),
      )
      .map((r) => r.project_id);
    expect(order).toEqual(byAge);
    // Each other account's project goes at its own oldest-due position:
    // B-0 after the five older A projects, and so on.
    expect(order.indexOf("B-0")).toBe(5);
    expect(order.indexOf("C-0")).toBe(11);
    // A's share of the first ten dispatches.
    expect(order.slice(0, 10).filter((id) => id.startsWith("A-"))).toHaveLength(
      9,
    );
    expect(queue.status()).toMatchObject({
      promoted_pending: 0,
      promoted_largest_account_count: 0,
      promoted_dispatched_total: { paying: 24, free: 0 },
    });
  });

  it("promotes nothing unless configured", async () => {
    const queue = new MaintenanceDispatchQueue({ now: () => NOW });
    const held = gate();
    const done = queue.submit({
      rows: [aged("A", "paying", "a", 600), aged("B", "paying", "b", 600)],
      observedAt: 1,
      parallelism: 1,
      due,
      run: async () => held.promise,
    });
    await flush();
    expect(queue.status()).toMatchObject({
      promoted_pending: 0,
      promoted_largest_account_count: 0,
      promoted_dispatched_total: { paying: 0, free: 0 },
    });
    held.release();
    await done;
  });
});
