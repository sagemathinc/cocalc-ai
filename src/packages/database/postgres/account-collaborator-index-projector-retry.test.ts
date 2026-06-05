/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { retryAccountCollaboratorIndexDeadlock } from "./account-collaborator-index-projector";

describe("retryAccountCollaboratorIndexDeadlock", () => {
  it("retries PostgreSQL deadlocks", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      )
      .mockResolvedValueOnce("ok");

    await expect(
      retryAccountCollaboratorIndexDeadlock(fn, {
        retries: 1,
        base_delay_ms: 0,
      }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
