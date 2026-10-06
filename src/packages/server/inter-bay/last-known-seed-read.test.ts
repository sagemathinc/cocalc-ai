/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lastKnownSeedRead } from "./last-known-seed-read";

describe("lastKnownSeedRead", () => {
  const options = {
    timeoutMs: 200,
    fallbackTimeoutMs: 50,
    backoffMs: 1_000,
    maxStaleMs: 60_000,
  };
  const never = () => new Promise<string>(() => {});
  const down = async (): Promise<string> => {
    throw Error("seed down");
  };
  const stale = { allowStale: true };

  afterEach(() => jest.useRealTimers());

  it("reads fresh while the seed answers", async () => {
    const read = lastKnownSeedRead<string>("test-fresh", options);
    read.clearForTests();
    expect(await read("k", async () => "one", stale)).toBe("one");
    expect(await read("k", async () => "two", stale)).toBe("two");
  });

  it("fails without a last-known value", async () => {
    const read = lastKnownSeedRead<string>("test-unknown", options);
    read.clearForTests();
    await expect(read("k", down, stale)).rejects.toThrow("seed down");
    await expect(read("other", never, stale)).rejects.toThrow("timed out");
  });

  it("never serves a stale value to callers that did not opt in", async () => {
    const read = lastKnownSeedRead<string>("test-strict", options);
    read.clearForTests();
    expect(await read("k", async () => "known")).toBe("known");
    await expect(read("k", down)).rejects.toThrow("seed down");
    // ... not even during another caller's backoff.
    expect(await read("k", down, stale)).toBe("known");
    await expect(read("k", down)).rejects.toThrow("seed down");
  });

  it("serves the last-known value when the seed does not answer, then backs off", async () => {
    const read = lastKnownSeedRead<string>("test-fallback", options);
    read.clearForTests();
    expect(await read("k", async () => "known")).toBe("known");

    const start = Date.now();
    expect(await read("k", never, stale)).toBe("known");
    expect(Date.now() - start).toBeLessThan(200); // the short timeout

    // During the backoff the seed is not asked at all.
    const fetch = jest.fn(async () => "fresh");
    expect(await read("k", fetch, stale)).toBe("known");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never serves a value older than maxStaleMs, however often it retries", async () => {
    jest.useFakeTimers({
      now: 1_000_000,
      doNotFake: ["setTimeout", "clearTimeout"],
    });
    const read = lastKnownSeedRead<string>("test-max-stale", options);
    read.clearForTests();
    expect(await read("k", async () => "known")).toBe("known");
    for (let t = 2_000; t < 60_000; t += 2_000) {
      jest.setSystemTime(1_000_000 + t);
      expect(await read("k", down, stale)).toBe("known");
    }
    jest.setSystemTime(1_000_000 + 60_001);
    await expect(read("k", down, stale)).rejects.toThrow("seed down");
  });
});
