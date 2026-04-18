import { KeepAlive } from "@cocalc/conat/socket/keepalive";
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
});
