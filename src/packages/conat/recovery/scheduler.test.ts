import { RecoveryScheduler } from "./scheduler";

describe("RecoveryScheduler", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("runs forced recoveries even when the resource reports connected", async () => {
    const recover = jest.fn(async () => {});
    const scheduler = new RecoveryScheduler({
      canRun: () => true,
      isTransportReady: () => true,
    });
    const resource = scheduler.registerResource({
      isConnected: () => true,
      recover,
    });

    try {
      resource.requestRecovery({
        force: true,
        reason: "stale_connected_probe",
      });

      await jest.advanceTimersByTimeAsync(999);
      expect(recover).toHaveBeenCalledTimes(0);

      await jest.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledWith({
        force: true,
        reason: "stale_connected_probe",
      });
    } finally {
      resource.close();
      scheduler.close();
    }
  });

  it("keeps skipping ordinary recoveries when the resource reports connected", async () => {
    const recover = jest.fn(async () => {});
    const scheduler = new RecoveryScheduler({
      canRun: () => true,
      isTransportReady: () => true,
    });
    const resource = scheduler.registerResource({
      isConnected: () => true,
      recover,
    });

    try {
      resource.requestRecovery({ reason: "already_connected" });

      await jest.advanceTimersByTimeAsync(1_000);
      expect(recover).toHaveBeenCalledTimes(0);
    } finally {
      resource.close();
      scheduler.close();
    }
  });
});
