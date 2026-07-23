import LRU from "lru-cache";
import { checkAndRecordCount } from "./connector-rate-limit";

const WINDOW_MS = 250;

function makeCache(): LRU<string, number> {
  return new LRU<string, number>({ max: 100, ttl: WINDOW_MS });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("checkAndRecordCount", () => {
  it("allows requests up to the limit and rejects beyond it", () => {
    const cache = makeCache();
    for (let i = 0; i < 5; i++) {
      expect(checkAndRecordCount(cache, "k", 5)).toBe(true);
    }
    expect(checkAndRecordCount(cache, "k", 5)).toBe(false);
  });

  it("counts keys independently", () => {
    const cache = makeCache();
    expect(checkAndRecordCount(cache, "a", 1)).toBe(true);
    expect(checkAndRecordCount(cache, "a", 1)).toBe(false);
    expect(checkAndRecordCount(cache, "b", 1)).toBe(true);
  });

  // Regression test for https://github.com/sagemathinc/cocalc-ai/issues/199:
  // lru-cache's set() refreshes the entry TTL by default, so continuous
  // sub-limit traffic (like the connector's 10s polling) kept the window
  // alive forever, the counter grew monotonically, and every connector was
  // permanently locked out. A true fixed window must expire relative to the
  // first request, so steady traffic below the per-window limit stays
  // allowed indefinitely.
  it("never rejects steady traffic below the per-window rate", async () => {
    const cache = makeCache();
    // 4 requests per window against a limit of 10 per window; run for
    // several windows. With the TTL-refresh bug the cumulative count
    // crosses the limit during the third window and never recovers.
    const intervalMs = WINDOW_MS / 4;
    const rounds = 16; // 4 windows worth of traffic
    for (let i = 0; i < rounds; i++) {
      expect(checkAndRecordCount(cache, "k", 10)).toBe(true);
      await sleep(intervalMs);
    }
  });

  it("recovers after one window even when rejected requests keep arriving", async () => {
    const cache = makeCache();
    for (let i = 0; i < 3; i++) {
      expect(checkAndRecordCount(cache, "k", 3)).toBe(true);
    }
    // Over the limit now; retries during the window are rejected and must
    // not extend the window.
    expect(checkAndRecordCount(cache, "k", 3)).toBe(false);
    await sleep(WINDOW_MS / 2);
    expect(checkAndRecordCount(cache, "k", 3)).toBe(false);
    // After the window (measured from the first request) expires, the
    // counter resets and requests are allowed again.
    await sleep(WINDOW_MS);
    expect(checkAndRecordCount(cache, "k", 3)).toBe(true);
  });
});
