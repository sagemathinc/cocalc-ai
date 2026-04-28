/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseManagedEgressBlockedError } from "./managed-egress-blocked";

describe("parseManagedEgressBlockedError", () => {
  it("parses managed egress blocking errors", () => {
    const blocked =
      parseManagedEgressBlockedError(`failed to sign in - Error: Interactive session traffic limit reached for this account.
New browser session traffic is temporarily blocked until the egress usage window resets.
5-hour usage: 57 MB / 50 MB.
7-day usage: 648 MB / 1 GB.
Current managed egress categories (5 hours): Interactive session traffic: 57 MB.`);
    expect(blocked).toEqual({
      raw: expect.stringContaining("Interactive session traffic limit reached"),
      title: "Interactive session traffic limit reached for this account.",
      details: [
        "New browser session traffic is temporarily blocked until the egress usage window resets.",
        "5-hour usage: 57 MB / 50 MB.",
        "7-day usage: 648 MB / 1 GB.",
        "Current managed egress categories (5 hours): Interactive session traffic: 57 MB.",
      ],
    });
  });

  it("ignores unrelated sign-in failures", () => {
    expect(
      parseManagedEgressBlockedError(
        "failed to sign in - Error: missing project-host bearer token",
      ),
    ).toBeUndefined();
  });
});
