import { startProjectApiKeyRevocationMaintenance } from "./project-membership-maintenance";
const query = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args) => query(...args) }),
}));
jest.mock("./project-membership-revocation", () => ({
  resolveProjectApiKeyRevocation: jest.fn(async () => true),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ warn: jest.fn() }),
}));
describe("project API revocation maintenance scheduling", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    jest.useFakeTimers();
    query.mockReset().mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    stop?.();
    jest.useRealTimers();
  });
  it("starts only once, waits after completion, and cancels on stop", async () => {
    stop = startProjectApiKeyRevocationMaintenance();
    expect(startProjectApiKeyRevocationMaintenance()).toBe(stop);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(query).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(query).toHaveBeenCalledTimes(2);
    stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("does not overlap a running pass or reschedule it after stop", async () => {
    let finish: (value: unknown) => void;
    query.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    stop = startProjectApiKeyRevocationMaintenance();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(1);
    stop();
    finish!({ rows: [] });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("backs off after a scan error", async () => {
    query.mockRejectedValueOnce(Error("database unavailable"));
    stop = startProjectApiKeyRevocationMaintenance();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(query).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
