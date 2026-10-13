/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  acquireProjectWriteLease,
  ProjectWriteFenceUnavailableError,
  resetProjectWriteFenceForTesting,
  withProjectWriteFence,
  withProjectWriteLease,
} from "./project-write-fence";

const P = "00000000-1000-4000-8000-000000000001";
const OTHER = "00000000-1000-4000-8000-000000000002";

describe("project write fence", () => {
  afterEach(() => resetProjectWriteFenceForTesting());

  it("refuses, without waiting, while a write is in progress", async () => {
    const release = await acquireProjectWriteLease(P);
    const fenced = jest.fn(async () => "ran");
    await expect(withProjectWriteFence(P, fenced)).rejects.toBeInstanceOf(
      ProjectWriteFenceUnavailableError,
    );
    expect(fenced).not.toHaveBeenCalled();
    // Other projects are unaffected.
    await expect(withProjectWriteFence(OTHER, fenced)).resolves.toBe("ran");
    release();
    release(); // idempotent
    await expect(withProjectWriteFence(P, fenced)).resolves.toBe("ran");
  });

  it("makes writers wait until the fence is released", async () => {
    const events: string[] = [];
    let open!: () => void;
    const fence = withProjectWriteFence(P, async () => {
      events.push("fence start");
      await new Promise<void>((resolve) => (open = resolve));
      events.push("fence end");
    });
    const write = withProjectWriteLease(P, async () => {
      events.push("write");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["fence start"]);
    open();
    await Promise.all([fence, write]);
    expect(events).toEqual(["fence start", "fence end", "write"]);
  });

  it("refuses a second fence and releases after a failure", async () => {
    let open!: () => void;
    const first = withProjectWriteFence(
      P,
      async () => await new Promise<void>((resolve) => (open = resolve)),
    );
    await expect(
      withProjectWriteFence(P, async () => undefined),
    ).rejects.toBeInstanceOf(ProjectWriteFenceUnavailableError);
    open();
    await first;
    await expect(
      withProjectWriteFence(P, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withProjectWriteLease(P, async () => "ok")).resolves.toBe(
      "ok",
    );
  });
});
