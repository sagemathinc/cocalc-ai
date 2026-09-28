import { startAgentMessagingMaintenance } from "./maintenance";
import { cleanupCocalcConnectorCredentials } from "./cocalc-connector-retention";

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn() }),
}));
jest.mock("./cocalc-connector-retention", () => ({
  cleanupCocalcConnectorCredentials: jest.fn(),
}));
jest.mock("./store", () => ({
  agentStore: () => ({
    transaction: async (fn) =>
      fn({ query: async () => ({ rows: [{ locked: true }], rowCount: 0 }) }),
  }),
}));

const cleanup = jest.mocked(cleanupCocalcConnectorCredentials);
const empty = { connector_secrets: 0, connector_keys: 0, connector_history: 0 };
describe("agent maintenance scheduling", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    jest.useFakeTimers();
    cleanup.mockReset().mockResolvedValue(empty);
  });
  afterEach(() => {
    stop?.();
    jest.useRealTimers();
  });
  it("drains successive full batches before returning to the idle interval", async () => {
    cleanup
      .mockResolvedValueOnce({ ...empty, connector_keys: 5000 })
      .mockResolvedValueOnce({ ...empty, connector_secrets: 5000 });
    stop = startAgentMessagingMaintenance();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_001);
    expect(cleanup).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(6 * 60 * 60_000 - 1);
    expect(cleanup).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(cleanup).toHaveBeenCalledTimes(4);
  });
  it("does not overlap a slow transaction or reschedule after stopping", async () => {
    let finish!: (value: typeof empty) => void;
    cleanup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    stop = startAgentMessagingMaintenance();
    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    stop();
    finish({ ...empty, connector_keys: 5000 });
    await jest.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it("backs off failures instead of spinning or waiting six hours", async () => {
    cleanup.mockRejectedValueOnce(new Error("temporary database outage"));
    stop = startAgentMessagingMaintenance();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
