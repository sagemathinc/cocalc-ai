/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { RecentTimes } from "./recent-times";

describe("RecentTimes", () => {
  it("takes up to the limit within the window, and again after it", () => {
    const r = new RecentTimes({ windowMs: 100, maxKeys: 10 });
    expect(r.take("a", 0, 2)).toBe(true);
    expect(r.take("a", 10, 2)).toBe(true);
    expect(r.take("a", 20, 2)).toBe(false);
    expect(r.count("a", 20)).toBe(2);
    expect(r.take("b", 20, 2)).toBe(true);
    // The first event leaves the window at 100: one slot frees.
    expect(r.take("a", 100, 2)).toBe(true);
    expect(r.take("a", 101, 2)).toBe(false);
  });

  it("deletes a key whose window has emptied", () => {
    const r = new RecentTimes({ windowMs: 100, maxKeys: 10 });
    r.add("a", 0);
    expect(r.size).toBe(1);
    expect(r.count("a", 100)).toBe(0);
    expect(r.size).toBe(0);
  });

  it("one-shot keys over time stay within one window's worth", () => {
    const r = new RecentTimes({ windowMs: 100, maxKeys: 1_000 });
    for (let i = 0; i < 50_000; i++) {
      expect(r.take(`k${i}`, i, 1)).toBe(true);
      expect(r.size).toBeLessThanOrEqual(100);
    }
  });

  it("never keeps more than maxKeys, dropping the oldest", () => {
    const r = new RecentTimes({ windowMs: 1_000_000, maxKeys: 3 });
    for (let i = 0; i < 10; i++) r.add(`k${i}`, i);
    expect(r.size).toBe(3);
    expect(r.count("k9", 10)).toBe(1);
    expect(r.count("k6", 10)).toBe(0);
    // A key used again moves to the end and outlives older ones.
    r.add("k7", 11);
    r.add("new", 12);
    expect(r.count("k7", 13)).toBe(2);
    expect(r.count("k8", 13)).toBe(0);
  });

  it("refuses a bad window or key limit", () => {
    expect(() => new RecentTimes({ windowMs: 0, maxKeys: 1 })).toThrow();
    expect(() => new RecentTimes({ windowMs: 1, maxKeys: 0 })).toThrow();
    expect(() => new RecentTimes({ windowMs: 1, maxKeys: 1.5 })).toThrow();
  });
});
