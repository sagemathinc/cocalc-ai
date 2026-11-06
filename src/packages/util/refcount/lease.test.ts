import { RefcountLeaseManager } from "./lease";

describe("RefcountLeaseManager", () => {
  test("disposes after delay when refcount hits zero", async () => {
    let disposed = 0;
    const mgr = new RefcountLeaseManager<string>({
      delayMs: 10,
      disposer: async () => {
        disposed += 1;
      },
    });

    const release = await mgr.acquire("a");
    expect(mgr.getCount("a")).toBe(1);
    await release();
    expect(mgr.getCount("a")).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(disposed).toBe(1);
  });

  test("cancels dispose if reacquired before delay", async () => {
    let disposed = 0;
    const mgr = new RefcountLeaseManager<string>({
      delayMs: 30,
      disposer: async () => {
        disposed += 1;
      },
    });
    const release1 = await mgr.acquire("a");
    await release1(); // schedule dispose
    // Reacquire before delay expires
    await new Promise((r) => setTimeout(r, 10));
    const release2 = await mgr.acquire("a");
    await new Promise((r) => setTimeout(r, 40));
    expect(disposed).toBe(0);
    await release2();
    await new Promise((r) => setTimeout(r, 40));
    expect(disposed).toBe(1);
  });

  test("multiple acquires keep count accurate", async () => {
    let disposed = 0;
    const mgr = new RefcountLeaseManager<string>({
      delayMs: 10,
      disposer: async () => {
        disposed += 1;
      },
    });
    const release1 = await mgr.acquire("k");
    const release2 = await mgr.acquire("k");
    expect(mgr.getCount("k")).toBe(2);
    await release1();
    expect(mgr.getCount("k")).toBe(1);
    await release2();
    await new Promise((r) => setTimeout(r, 15));
    expect(disposed).toBe(1);
  });

  test("serialize concurrent acquire/release", async () => {
    let disposed = 0;
    const mgr = new RefcountLeaseManager<number>({
      delayMs: 5,
      disposer: async () => {
        disposed += 1;
      },
    });
    const [r1, r2, r3] = await Promise.all([
      mgr.acquire(1),
      mgr.acquire(1),
      mgr.acquire(1),
    ]);
    expect(mgr.getCount(1)).toBe(3);
    await Promise.all([r1(), r2(), r3()]);
    await new Promise((r) => setTimeout(r, 15));
    expect(disposed).toBe(1);
  });

  test("reacquire waits for in-flight dispose to finish", async () => {
    let disposeStart = 0;
    let disposeEnd = 0;
    const mgr = new RefcountLeaseManager<string>({
      delayMs: 10,
      disposer: async () => {
        disposeStart = Date.now();
        // simulate slow disposer
        await new Promise((r) => setTimeout(r, 50));
        disposeEnd = Date.now();
      },
    });

    const rel1 = await mgr.acquire("slow");
    await rel1(); // schedule dispose

    // Wait past delay so disposer starts, but not long enough to finish.
    await new Promise((r) => setTimeout(r, 20));
    const rel2 = await mgr.acquire("slow");
    const afterAcquire = Date.now();

    // Reacquire should only complete after disposer finished.
    expect(disposeStart).toBeGreaterThan(0);
    expect(disposeEnd).toBeGreaterThan(0);
    expect(afterAcquire).toBeGreaterThanOrEqual(disposeEnd);
    expect(mgr.getCount("slow")).toBe(1);

    await rel2();
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.getCount("slow")).toBe(0);
  });

  describe("maxIdle", () => {
    test("disposes the longest idle resource right away beyond the cap", async () => {
      const disposed: string[] = [];
      const mgr = new RefcountLeaseManager<string>({
        delayMs: 60_000,
        maxIdle: 2,
        disposer: async (key) => {
          disposed.push(key);
        },
      });
      for (const key of ["a", "b", "c", "d"]) {
        const release = await mgr.acquire(key);
        await release();
      }
      await new Promise((r) => setTimeout(r, 10));
      // a and b went idle first
      expect(disposed).toEqual(["a", "b"]);
      await mgr.close();
    });

    test("an acquire moves a resource out of the idle order", async () => {
      const disposed: string[] = [];
      const mgr = new RefcountLeaseManager<string>({
        delayMs: 60_000,
        maxIdle: 2,
        disposer: async (key) => {
          disposed.push(key);
        },
      });
      for (const key of ["a", "b"]) {
        await (
          await mgr.acquire(key)
        )();
      }
      // a is used again: now b is the longest idle
      await (
        await mgr.acquire("a")
      )();
      await (
        await mgr.acquire("c")
      )();
      await new Promise((r) => setTimeout(r, 10));
      expect(disposed).toEqual(["b"]);
      await mgr.close();
    });

    test("never disposes a resource in use, and in-use ones do not count", async () => {
      const disposed: string[] = [];
      const mgr = new RefcountLeaseManager<string>({
        delayMs: 60_000,
        maxIdle: 1,
        disposer: async (key) => {
          disposed.push(key);
        },
      });
      const holdA = await mgr.acquire("a");
      const holdB = await mgr.acquire("b");
      await (
        await mgr.acquire("c")
      )();
      await new Promise((r) => setTimeout(r, 10));
      expect(disposed).toEqual([]);
      expect(mgr.getCount("a")).toBe(1);
      expect(mgr.getCount("b")).toBe(1);
      await holdA();
      await new Promise((r) => setTimeout(r, 10));
      // c (idle longest) goes; a stays as the one allowed idle resource
      expect(disposed).toEqual(["c"]);
      await holdB();
      await mgr.close();
    });

    test("does not dispose a resource reacquired while its eviction waited for its lock", async () => {
      const disposed: string[] = [];
      const mgr = new RefcountLeaseManager<string>({
        delayMs: 60_000,
        maxIdle: 1,
        disposer: async (key) => {
          disposed.push(key);
        },
      });
      const releaseA = await mgr.acquire("a");
      const releaseB = await mgr.acquire("b");
      await releaseA(); // a idle, at the cap
      // in the same tick: b's release evicts a, while an acquire of a is
      // already queued on a's lock ahead of the eviction
      const p1 = releaseB();
      const p2 = mgr.acquire("a");
      await p1;
      const releaseA2 = await p2;
      await new Promise((r) => setTimeout(r, 10));
      expect(mgr.getCount("a")).toBe(1);
      expect(disposed).not.toContain("a");
      await releaseA2();
      await mgr.close();
    });

    test("without maxIdle nothing is disposed before the delay", async () => {
      const disposed: string[] = [];
      const mgr = new RefcountLeaseManager<string>({
        delayMs: 60_000,
        disposer: async (key) => {
          disposed.push(key);
        },
      });
      for (const key of ["a", "b", "c"]) {
        await (
          await mgr.acquire(key)
        )();
      }
      await new Promise((r) => setTimeout(r, 10));
      expect(disposed).toEqual([]);
      await mgr.close();
    });
  });
});
