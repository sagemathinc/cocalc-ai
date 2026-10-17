import {
  logFetchDelay,
  noteLogFetchFailure,
  noteLogFetchSuccess,
  resetLogFetchBackoffForTests,
} from "./log-fetch-backoff";

describe("activity log fetch backoff", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetLogFetchBackoffForTests();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("fetches a key with no failures at once", () => {
    expect(logFetchDelay("a", 0)).toBe(0);
  });

  it("doubles the wait after each failure, up to a minute", () => {
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      noteLogFetchFailure("a", new Error("disconnected"), 0);
      waits.push(logFetchDelay("a", 0));
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(logFetchDelay("a", 60000)).toBe(0);
    expect(logFetchDelay("b", 0)).toBe(0);
  });

  it("clears the backoff on success", () => {
    noteLogFetchFailure("a", new Error("disconnected"), 0);
    noteLogFetchSuccess("a");
    expect(logFetchDelay("a", 0)).toBe(0);
  });

  it("logs the first and every tenth failure as one line without a stack", () => {
    for (let i = 0; i < 25; i++) {
      noteLogFetchFailure("a", new Error("disconnected"), 0);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    for (const [message, ...rest] of warn.mock.calls) {
      expect(typeof message).toBe("string");
      expect(rest).toEqual([]);
      expect(message).toContain("disconnected");
    }
  });
});
