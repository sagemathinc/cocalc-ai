import { startApiRelayQuotaMaintenance } from "./api-relay-maintenance";

jest.mock("./api-relay-quota", () => ({ cleanupApiRelayQuota: jest.fn() }));

it("runs without relay traffic and never overlaps a slow cleanup", async () => {
  jest.useFakeTimers();
  let finish!: (result: { leases: number; accounts: number }) => void;
  const cleanup = jest.fn(
    () =>
      new Promise<{ leases: number; accounts: number }>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startApiRelayQuotaMaintenance({ cleanup, intervalMs: 100 });
  try {
    expect(cleanup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    finish({ leases: 0, accounts: 0 });
    await jest.advanceTimersByTimeAsync(100);
    expect(cleanup).toHaveBeenCalledTimes(2);
    stop();
    finish({ leases: 1, accounts: 0 });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    stop();
    jest.useRealTimers();
  }
});

it("continues after a cleanup error", async () => {
  jest.useFakeTimers();
  const cleanup = jest
    .fn()
    .mockRejectedValueOnce(Error("database temporarily unavailable"))
    .mockResolvedValue({ leases: 1, accounts: 0 });
  const stop = startApiRelayQuotaMaintenance({ cleanup, intervalMs: 100 });
  try {
    await jest.advanceTimersByTimeAsync(100);
    expect(cleanup).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    jest.useRealTimers();
  }
});
