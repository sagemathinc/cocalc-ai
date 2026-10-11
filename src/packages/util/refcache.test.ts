/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import refCache, { refCacheSync } from "./refcache";

describe("refCache", () => {
  it("replaces invalid entries without letting old references evict the replacement", async () => {
    let nextId = 0;
    const closed: number[] = [];
    const get = refCache<
      { key: string },
      { id: number; valid: boolean; close: () => void }
    >({
      name: "refcache-invalid-entry-test",
      createKey: ({ key }) => key,
      createObject: async () => {
        const id = ++nextId;
        return {
          id,
          valid: true,
          close: () => {
            closed.push(id);
          },
        };
      },
      isValid: (obj) => obj.valid,
    });

    const first = await get({ key: "shared" });
    const secondReference = await get({ key: "shared" });
    expect(secondReference).toBe(first);

    first.valid = false;
    const replacement = await get({ key: "shared" });
    expect(replacement).not.toBe(first);
    expect(get.one()).toBe(replacement);

    first.close();
    secondReference.close();
    expect(closed).toEqual([first.id]);
    expect(get.one()).toBe(replacement);

    replacement.close();
    expect(closed).toEqual([first.id, replacement.id]);
    expect(get.size()).toBe(0);
  });
});

describe("refCacheSync", () => {
  it("replaces invalid entries without letting old references evict the replacement", () => {
    let nextId = 0;
    const closed: number[] = [];
    const get = refCacheSync<
      { key: string },
      { id: number; valid: boolean; close: () => void }
    >({
      name: "refcache-sync-invalid-entry-test",
      createKey: ({ key }) => key,
      createObject: () => {
        const id = ++nextId;
        return {
          id,
          valid: true,
          close: () => {
            closed.push(id);
          },
        };
      },
      isValid: (obj) => obj.valid,
    });

    const first = get({ key: "shared" });
    const secondReference = get({ key: "shared" });
    expect(secondReference).toBe(first);

    first.valid = false;
    const replacement = get({ key: "shared" });
    expect(replacement).not.toBe(first);
    expect(get.one()).toBe(replacement);

    first.close();
    secondReference.close();
    expect(closed).toEqual([first.id]);
    expect(get.one()).toBe(replacement);
    expect(get.info().count).toEqual({ shared: 1 });

    replacement.close();
    expect(closed).toEqual([first.id, replacement.id]);
    expect(get.size()).toBe(0);
  });

  it("closes once and ignores extra close calls", () => {
    const close = jest.fn();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const get = refCacheSync<{ key: string }, { close: () => void }>({
      name: "refcache-sync-extra-close-test",
      createKey: ({ key }) => key,
      createObject: () => ({ close }),
    });
    const obj = get({ key: "a" });
    obj.close();
    obj.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
