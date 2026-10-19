/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { formatManagedEgressBlockedMessage } from "@cocalc/util/managed-egress-message";
import {
  managedEgressBlockUpgradeHelps,
  parseManagedEgressBlockedError,
} from "./managed-egress-blocked";

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

  // The 2026-10-18 lock-out: this message used to be treated as a failed
  // sign-in ("You must sign in.") and cleared the remember-me cookie.
  it("recognizes the account control traffic block", () => {
    const message = formatManagedEgressBlockedMessage({
      category: "control-plane-conat",
      policy: {
        blocked_by: "7d",
        managed_egress_7d_bytes: 100_000_000_000,
        egress_7d_bytes: 100_000_000_000,
        blocked_until: "2026-10-19T05:30:00.000Z",
      },
      blocked: "New browser sessions for this account are blocked.",
    });
    expect(
      parseManagedEgressBlockedError(`failed to sign in - Error: ${message}`),
    ).toMatchObject({
      category: "control-plane-conat",
      window: "7d",
      resets_at: "2026-10-19T05:30:00.000Z",
      title: "Account control traffic limit reached for this account.",
    });
  });

  it("recognizes the old control traffic message from servers not yet upgraded", () => {
    expect(
      parseManagedEgressBlockedError(
        "failed to sign in - Error: Account control traffic safety limit reached.\nNew browser control-plane connections are temporarily blocked because this account generated an abnormal amount of control traffic.\n7-day usage: 100 GB / 100 GB.",
      )?.title,
    ).toBe("Account control traffic safety limit reached.");
  });

  it("offers contact support, not a membership upgrade, for control-plane blocks in either format", () => {
    const old = parseManagedEgressBlockedError(
      "failed to sign in - Error: Account control traffic safety limit reached.\nNew browser control-plane connections are temporarily blocked because this account generated an abnormal amount of control traffic.",
    )!;
    expect(old.category).toBe("control-plane-conat");
    expect(managedEgressBlockUpgradeHelps(old)).toBe(false);
    const shared = parseManagedEgressBlockedError(
      "Project outbound network traffic limit reached for this account.\nCode: managed-egress-blocked category=raw-network window=5h",
    )!;
    expect(shared.category).toBe("raw-network");
    expect(managedEgressBlockUpgradeHelps(shared)).toBe(true);
  });
});
