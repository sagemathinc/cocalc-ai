import { earlyPassDelayMs, waitForNextPass } from "./host-agent";

// A fake clock: wait() advances it instead of sleeping.
function clock() {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms: number) => {
      t += ms;
    },
  };
}

describe("host agent: respawn a managed process as soon as it exits", () => {
  it("waits the whole poll while every watched process runs", async () => {
    const c = clock();
    const result = await waitForNextPass({
      pollMs: 5000,
      minDelayMs: 0,
      pids: [11, 12],
      isRunning: () => true,
      ...c,
    });
    expect(result).toBe("poll");
    expect(c.now()).toBe(5000);
  });

  it("supervises within a quarter second when one exits", async () => {
    const c = clock();
    const result = await waitForNextPass({
      pollMs: 5000,
      minDelayMs: 0,
      pids: [11, 12],
      isRunning: (pid) => !(pid == 12 && c.now() >= 1000),
      ...c,
    });
    expect(result).toBe("exited");
    expect(c.now()).toBeLessThanOrEqual(1250);
  });

  it("not before the minimum delay, so a crash loop is not respawned in a tight loop", async () => {
    const c = clock();
    const result = await waitForNextPass({
      pollMs: 5000,
      minDelayMs: 2000,
      pids: [11],
      isRunning: () => false,
      ...c,
    });
    expect(result).toBe("exited");
    expect(c.now()).toBe(2000);
  });

  it("stops waiting when the agent is stopping", async () => {
    const c = clock();
    let stopping = false;
    const result = await waitForNextPass({
      pollMs: 5000,
      minDelayMs: 0,
      pids: [11],
      isRunning: () => true,
      shouldStop: () => stopping,
      wait: async (ms) => {
        await c.wait(ms);
        stopping = c.now() >= 500;
      },
      now: c.now,
    });
    expect(result).toBe("poll");
    expect(c.now()).toBe(500);
  });

  it("backs off early passes 0, 1, 2, 4 s, capped at the poll interval", () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => earlyPassDelayMs(n, 5000))).toEqual([
      0, 1000, 2000, 4000, 5000, 5000,
    ]);
  });
});
