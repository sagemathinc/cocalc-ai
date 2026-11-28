import { acpTestInternals } from "../index";
import { logStaleWorkerTreatedAsLive } from "../stale-worker-log";

const { workerRowStillLikelyOwnsTurns } = acpTestInternals;

describe("stale ACP worker log line", () => {
  it("logs once per worker per minute and counts the rest", () => {
    const logger = { debug: jest.fn() };
    const now = jest.spyOn(Date, "now").mockReturnValue(5_000_000);
    try {
      const fields = { worker_id: "w1", pid: 1, age_ms: 10, grace_ms: 100 };
      for (let i = 0; i < 7; i++) logStaleWorkerTreatedAsLive(logger, fields);
      logStaleWorkerTreatedAsLive(logger, { ...fields, worker_id: "w2" });
      expect(logger.debug).toHaveBeenCalledTimes(2);
      now.mockReturnValue(5_060_000);
      logStaleWorkerTreatedAsLive(logger, fields);
      expect(logger.debug).toHaveBeenCalledTimes(3);
      expect(logger.debug.mock.calls[2][1]).toEqual({
        ...fields,
        suppressed: 6,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("leaves the liveness decision unchanged on every repeat", () => {
    const live = {
      worker_id: "worker-live",
      pid: process.pid,
      heartbeat_at: Date.now(),
    };
    for (let i = 0; i < 100; i++)
      expect(workerRowStillLikelyOwnsTurns(live)).toBe(true);
    expect(
      workerRowStillLikelyOwnsTurns({ ...live, pid: 2 ** 22 + 12345 }),
    ).toBe(false);
    expect(workerRowStillLikelyOwnsTurns({ ...live, heartbeat_at: 0 })).toBe(
      false,
    );
    expect(workerRowStillLikelyOwnsTurns({ ...live, pid: null })).toBe(false);
  });
});
