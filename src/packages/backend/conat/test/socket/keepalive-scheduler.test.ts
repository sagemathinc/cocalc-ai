import { KeepAlive } from "@cocalc/conat/socket/keepalive";
import { HeartbeatScheduler } from "@cocalc/conat/recovery/heartbeat-scheduler";
import { delay } from "awaiting";

describe("KeepAlive scheduler", () => {
  it("defers pinging when recv updates activity", async () => {
    let pingCount = 0;
    const alive = new KeepAlive(
      async () => {
        pingCount += 1;
      },
      () => {},
      50,
      "client",
    );
    try {
      await delay(20);
      alive.recv();
      await delay(35);
      expect(pingCount).toBe(0);
      await delay(35);
      expect(pingCount).toBeGreaterThanOrEqual(1);
    } finally {
      alive.close();
    }
  });

  it("stops pinging while paused and resumes afterwards", async () => {
    let pingCount = 0;
    const alive = new KeepAlive(
      async () => {
        pingCount += 1;
      },
      () => {},
      40,
      "client",
    );
    try {
      await delay(60);
      expect(pingCount).toBeGreaterThanOrEqual(1);
      alive.pause();
      const pausedCount = pingCount;
      await delay(120);
      expect(pingCount).toBe(pausedCount);
      alive.resume();
      await delay(60);
      expect(pingCount).toBeGreaterThan(pausedCount);
    } finally {
      alive.close();
    }
  });

  it("serializes heartbeats across many keepalives on one scheduler", async () => {
    const scheduler = new HeartbeatScheduler({
      canRun: () => true,
      maxConcurrentHeartbeats: 1,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let pingCount = 0;
    const alive = Array.from({ length: 5 }, () => {
      return new KeepAlive(
        async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pingCount += 1;
          await delay(20);
          inFlight -= 1;
        },
        () => {},
        15,
        "client",
        scheduler,
      );
    });
    try {
      await delay(200);
      expect(pingCount).toBeGreaterThanOrEqual(alive.length);
      expect(maxInFlight).toBe(1);
    } finally {
      for (const keepalive of alive) {
        keepalive.close();
      }
      scheduler.close();
    }
  });
});
