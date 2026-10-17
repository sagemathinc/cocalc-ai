const get = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: async () => ({ sync: { akv: () => ({ get }) } }),
      registerReconnectResource: () => ({ close: () => {} }),
    },
  },
}));
jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({ warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

import { act, renderHook } from "@testing-library/react";
import { resetLogFetchBackoffForTests } from "./log-fetch-backoff";
import { useCodexLog } from "./use-codex-log";

describe("useCodexLog retries a failing persisted-log fetch", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetLogFetchBackoffForTests();
    get.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps one stable error through background retries, then loads", async () => {
    get.mockRejectedValue(new Error("disconnected"));
    const states: string[] = [];
    const logKey = `key-${Math.random()}`;
    const { result, unmount } = renderHook(() => {
      const log = useCodexLog({
        projectId: "00000000-0000-4000-8000-000000000000",
        logStore: "acp-log",
        logKey,
      });
      states.push(`${log.loadState}:${log.loadError ?? ""}`);
      return log;
    });
    await act(async () => {});
    expect(result.current.loadState).toBe("error");
    const firstError = states.indexOf("error:disconnected");
    expect(firstError).toBeGreaterThan(-1);

    // Several backoff retries (1 s, 2 s, 4 s, 8 s) that fail the same way.
    for (const ms of [1000, 2000, 4000, 8000]) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    }
    expect(get.mock.calls.length).toBe(5);
    // A consumer that dedupes on (loadState, loadError) never sees the error
    // clear and reappear, so it reports it once.
    expect(new Set(states.slice(firstError))).toEqual(
      new Set(["error:disconnected"]),
    );

    get.mockResolvedValue([{ event: "done" }]);
    await act(async () => {
      jest.advanceTimersByTime(16000);
    });
    expect(result.current.loadState).toBe("loaded");
    expect(result.current.loadError).toBeUndefined();
    unmount();
  });
});
