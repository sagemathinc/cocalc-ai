/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lastKnownSeedRead } from "./last-known-seed-read";

describe("lastKnownSeedRead", () => {
  const options = { timeoutMs: 200, fallbackTimeoutMs: 50, backoffMs: 1_000 };
  const never = () => new Promise<string>(() => {});

  it("reads fresh while the seed answers", async () => {
    const read = lastKnownSeedRead<string>("test-fresh", options);
    expect(await read("k", async () => "one")).toBe("one");
    expect(await read("k", async () => "two")).toBe("two");
  });

  it("fails without a last-known value", async () => {
    const read = lastKnownSeedRead<string>("test-unknown", options);
    await expect(
      read("k", async () => {
        throw Error("seed down");
      }),
    ).rejects.toThrow("seed down");
    await expect(read("other", never)).rejects.toThrow("timed out");
  });

  it("serves the last-known value when the seed does not answer, then backs off", async () => {
    const read = lastKnownSeedRead<string>("test-fallback", options);
    read.clearForTests();
    expect(await read("k", async () => "known")).toBe("known");

    const start = Date.now();
    expect(await read("k", never)).toBe("known");
    expect(Date.now() - start).toBeLessThan(200); // the short timeout, not 200ms

    // During the backoff the seed is not asked at all.
    const fetch = jest.fn(async () => "fresh");
    expect(await read("k", fetch)).toBe("known");
    expect(fetch).not.toHaveBeenCalled();
  });
});
