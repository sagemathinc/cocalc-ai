/*
 * The board registry's ownership and limits, with managers whose every
 * step the test holds and releases.
 */

import type { BoardStatus } from "./manager";
import {
  BoardRegistry,
  type BoardManagerLike,
  type StartedBoard,
} from "./registry";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

class FakeManager implements BoardManagerLike {
  status: BoardStatus = { state: "ok", bytes: 10 };
  retired = false;
  revoked = false;
  closes = 0;
  // A close that waits for this gate (the final save held).
  closeGate: Promise<void> | undefined;
  private work: Promise<unknown> = Promise.resolve();
  getStatus() {
    return this.status;
  }
  isRetired() {
    return this.retired;
  }
  async save() {}
  close() {
    this.closes += 1;
    const step = this.closeGate ?? Promise.resolve();
    this.work = step;
    return step;
  }
  revoke() {
    this.revoked = true;
  }
  async settled() {
    await this.work;
  }
}

function harness(
  opts: Partial<ConstructorParameters<typeof BoardRegistry>[0]> = {},
) {
  const registry = new BoardRegistry({
    startTimeoutMs: 200,
    closeTimeoutMs: 100,
    takeoverWaitMs: 100,
    ...opts,
  });
  const managers: FakeManager[] = [];
  let running = 0;
  let maxRunning = 0;
  const start =
    (startGate?: Promise<void>, syncdbCloseGate?: Promise<void>) =>
    async (): Promise<StartedBoard> => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await startGate;
      const manager = new FakeManager();
      managers.push(manager);
      return {
        manager,
        close: async () => {
          await syncdbCloseGate;
          running -= 1;
        },
      };
    };
  return {
    registry,
    managers,
    start,
    maxRunning: () => maxRunning,
  };
}

test("a closing board blocks its reopening until its held final save ends", async () => {
  const h = harness();
  const first = await h.registry.open("p:a", "a", h.start());
  const held = gate();
  (first as FakeManager).closeGate = held.promise;
  h.registry.sweep(Date.now() + h.registry.leaseMs + 1);
  expect(h.registry.size()).toBe(1); // closing still counts
  // The final save outlives its timeout: the manager is revoked, but the
  // slot stays taken and the board is not handed to a second manager.
  await new Promise((r) => setTimeout(r, 150));
  expect((first as FakeManager).revoked).toBe(true);
  await expect(h.registry.open("p:a", "a", h.start())).rejects.toThrow(
    /still closing/,
  );
  expect(h.managers.length).toBe(1);
  expect(h.registry.size()).toBe(1);
  held.release();
  const second = await h.registry.open("p:a", "a", h.start());
  expect(second).not.toBe(first);
  expect(h.managers.length).toBe(2);
  expect(h.maxRunning()).toBe(1); // never two at once
  await h.registry.closeAll();
  expect(h.registry.size()).toBe(0);
});

test("a reopening waits for a close that finishes in time", async () => {
  const h = harness({ takeoverWaitMs: 2000, closeTimeoutMs: 2000 });
  const first = (await h.registry.open("p:a", "a", h.start())) as FakeManager;
  const held = gate();
  first.closeGate = held.promise;
  h.registry.sweep(Date.now() + h.registry.leaseMs + 1);
  const reopened = h.registry.open("p:a", "a", h.start());
  await new Promise((r) => setTimeout(r, 50));
  expect(h.managers.length).toBe(1);
  held.release();
  expect(await reopened).not.toBe(first);
  expect(first.revoked).toBe(false);
  expect(h.maxRunning()).toBe(1);
  await h.registry.closeAll();
});

test("a stalled start keeps its slot across lease expiry until it ends", async () => {
  const h = harness();
  const held = gate();
  await expect(
    h.registry.open("p:a", "a", h.start(held.promise)),
  ).rejects.toThrow(/timed out/);
  h.registry.sweep(Date.now() + h.registry.leaseMs + 1);
  h.registry.sweep(Date.now() + 2 * h.registry.leaseMs + 1);
  expect(h.registry.size()).toBe(1);
  await expect(h.registry.open("p:a", "a", h.start())).rejects.toThrow(
    /still closing/,
  );
  held.release();
  await new Promise((r) => setTimeout(r, 20));
  // The late start is closed, not left running.
  expect(h.managers[0].closes).toBe(1);
  expect(h.registry.size()).toBe(0);
  await h.registry.open("p:a", "a", h.start());
  expect(h.maxRunning()).toBe(1);
  await h.registry.closeAll();
});

test("a board whose file went away gets a new manager", async () => {
  const h = harness();
  const first = (await h.registry.open("p:a", "a", h.start())) as FakeManager;
  first.retired = true;
  const second = await h.registry.open("p:a", "a", h.start());
  expect(second).not.toBe(first);
  expect(first.closes).toBe(1);
  await h.registry.closeAll();
});

test("limits: per project, per host, and the open boards' bytes", async () => {
  // Each fake board is 10 bytes.
  const h = harness({ maxOpen: 4, maxPerGroup: 2, maxTotalBytes: 25 });
  await h.registry.open("p:a", "a", h.start());
  await h.registry.open("p:b", "b", h.start());
  await expect(h.registry.open("p:c", "c", h.start())).rejects.toThrow(
    /in this project/,
  );
  // Renewing an open board is not a new one.
  await h.registry.open("p:a", "a", h.start());
  await h.registry.open("q:a", "a", h.start()); // 20 bytes were open
  await expect(h.registry.open("r:a", "a", h.start())).rejects.toThrow(
    /too large/,
  );
  await h.registry.closeAll("p:");
  await h.registry.open("r:a", "a", h.start());
  await h.registry.closeAll();
  expect(h.registry.size()).toBe(0);

  const small = harness({ maxOpen: 2 });
  await small.registry.open("p:a", "a", small.start());
  await small.registry.open("q:a", "a", small.start());
  await expect(small.registry.open("r:a", "a", small.start())).rejects.toThrow(
    /too many open boards on this host/,
  );
  await small.registry.closeAll();
});

test("bytes are reserved at admission, so concurrent starts stay under the cap", async () => {
  const h = harness({ maxTotalBytes: 100, startTimeoutMs: 5000 });
  const held = gate();
  const opens = Array.from({ length: 10 }, (_, i) =>
    h.registry.open(`p${i}:a`, "a", h.start(held.promise), 30),
  );
  const outcomes = await Promise.allSettled(
    opens.map((p) => Promise.race([p, new Promise((r) => setTimeout(r, 50))])),
  );
  // Three fit (90 bytes); the rest were refused before starting.
  const refused = outcomes.filter((o) => o.status === "rejected");
  expect(refused.length).toBe(7);
  for (const o of refused) {
    expect(`${(o as PromiseRejectedResult).reason}`).toMatch(/too large/);
  }
  expect(h.registry.size()).toBe(3);
  expect(h.registry.chargedBytes()).toBe(90);
  held.release();
  await Promise.allSettled(opens);
  expect(h.registry.chargedBytes()).toBe(90);
  // A board that grows is charged its size.
  h.managers[0].status = { state: "ok", bytes: 50 };
  expect(h.registry.chargedBytes()).toBe(110);
  await expect(h.registry.open("q:a", "a", h.start(), 1)).rejects.toThrow(
    /too large/,
  );
  await h.registry.closeAll();
  expect(h.registry.chargedBytes()).toBe(0);
});

test("a syncdb close that does not end keeps the slot and blocks takeover", async () => {
  const h = harness();
  const closeHeld = gate();
  await h.registry.open("p:a", "a", h.start(undefined, closeHeld.promise), 10);
  h.registry.sweep(Date.now() + h.registry.leaseMs + 1);
  // Past the close timeout (100 ms): still charged and blocking.
  await new Promise((r) => setTimeout(r, 250));
  expect(h.registry.size()).toBe(1);
  expect(h.registry.chargedBytes()).toBe(10);
  await expect(h.registry.open("p:a", "a", h.start())).rejects.toThrow(
    /still closing/,
  );
  // Ending late frees it.
  closeHeld.release();
  await new Promise((r) => setTimeout(r, 20));
  expect(h.registry.size()).toBe(0);
  await h.registry.open("p:a", "a", h.start());
  expect(h.maxRunning()).toBe(1);
  await h.registry.closeAll();
});

test("a manager that retires is closed at once", async () => {
  const h = harness();
  let retire: (() => void) | undefined;
  const manager = (await h.registry.open("p:a", "a", async () => {
    const m = new FakeManager();
    (m as any).onRetire = (f: () => void) => (retire = f);
    return { manager: m, close: async () => {} };
  })) as FakeManager;
  retire!();
  await new Promise((r) => setTimeout(r, 20));
  expect(manager.closes).toBe(1);
  expect(h.registry.size()).toBe(0);
});
