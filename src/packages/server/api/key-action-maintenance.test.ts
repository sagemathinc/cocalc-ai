import {
  cleanupApiKeyActionHistory,
  startApiKeyActionMaintenance,
} from "./key-action-maintenance";

const query = jest.fn();
const prune = jest.fn();
const schema = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args) => query(...args) }),
}));
jest.mock("./key-action-store", () => ({
  ApiKeyActionStore: class {
    ensureSchema(...args) {
      return schema(...args);
    }
    pruneExpired(...args) {
      return prune(...args);
    }
  },
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ warn: jest.fn() }),
}));

describe("API approval history maintenance", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    jest.useFakeTimers();
    query.mockReset().mockResolvedValue({ rows: [] });
    prune.mockReset().mockResolvedValue(500);
    schema.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    stop?.();
    jest.useRealTimers();
  });
  it("advances past failing accounts and resets the cursor at the end", async () => {
    query.mockResolvedValueOnce({
      rows: [{ account_id: "a" }, { account_id: "b" }],
    });
    prune.mockRejectedValueOnce(Error("account rehoming"));
    await expect(cleanupApiKeyActionHistory("previous")).resolves.toEqual({
      cursor: "b",
      scanned: 2,
      deleted: 500,
    });
    expect(query.mock.calls[0][1]).toEqual([
      "bay-1",
      "previous",
      expect.any(Number),
      32,
    ]);
    expect(prune).toHaveBeenCalledWith("b");
    await expect(cleanupApiKeyActionHistory("b")).resolves.toEqual({
      cursor: undefined,
      scanned: 0,
      deleted: 0,
    });
  });
  it("is singleton, drains batches, idles and cancels", async () => {
    query.mockResolvedValueOnce({ rows: [{ account_id: "a" }] });
    stop = startApiKeyActionMaintenance();
    expect(startApiKeyActionMaintenance()).toBe(stop);
    await jest.advanceTimersByTimeAsync(1000);
    expect(prune).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60000);
    expect(query).toHaveBeenCalledTimes(3);
    stop();
    await jest.advanceTimersByTimeAsync(60000);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("does not overlap a pass or restart after a stopped pass finishes", async () => {
    let finish!: (value: unknown) => void;
    query.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    stop = startApiKeyActionMaintenance();
    await jest.advanceTimersByTimeAsync(120000);
    expect(query).toHaveBeenCalledTimes(1);
    stop();
    finish({ rows: [] });
    await jest.advanceTimersByTimeAsync(120000);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("backs off after a schema or scan failure", async () => {
    schema.mockRejectedValueOnce(Error("database unavailable"));
    stop = startApiKeyActionMaintenance();
    await jest.advanceTimersByTimeAsync(60000);
    expect(query).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
