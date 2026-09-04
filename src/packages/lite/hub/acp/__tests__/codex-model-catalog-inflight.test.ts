/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createInflightRequestCoalescer } from "../../codex-model-catalog-inflight";

describe("Lite Codex model catalog request coalescing", () => {
  it("shares identical concurrent loads and forgets completed work", async () => {
    const coalesce = createInflightRequestCoalescer<string>();
    let release: ((value: string) => void) | undefined;
    const load = jest.fn(
      async () =>
        await new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const first = coalesce("account\x00subscription\x00generation-0", load);
    const second = coalesce("account\x00subscription\x00generation-0", load);
    await new Promise((resolve) => setImmediate(resolve));
    expect(load).toHaveBeenCalledTimes(1);
    release?.("catalog");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "catalog",
      "catalog",
    ]);

    await expect(
      coalesce(
        "account\x00subscription\x00generation-0",
        async () => "new catalog",
      ),
    ).resolves.toBe("new catalog");
  });

  it("does not share work across credential generations", async () => {
    const coalesce = createInflightRequestCoalescer<number>();
    const values = await Promise.all([
      coalesce("account\x00subscription\x00generation-0", async () => 1),
      coalesce("account\x00subscription\x00generation-1", async () => 2),
    ]);
    expect(values).toEqual([1, 2]);
  });
});
