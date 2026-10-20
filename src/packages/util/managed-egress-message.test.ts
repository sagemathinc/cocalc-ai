/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  formatManagedEgressBlockedMessage,
  formatManagedEgressPolicyDetails,
  parseManagedEgressBlockedMessage,
} from "./managed-egress-message";

describe("formatManagedEgressPolicyDetails", () => {
  it("identifies a seven-day block and reports both category windows", () => {
    expect(
      formatManagedEgressPolicyDetails({
        blocked_by: "7d",
        managed_egress_5h_bytes: 0,
        managed_egress_7d_bytes: 4_050_000_000,
        egress_5h_bytes: 2_000_000_000,
        egress_7d_bytes: 3_500_000_000,
        managed_egress_categories_5h_bytes: {},
        managed_egress_categories_7d_bytes: {
          "backup-upload": 1_550_000_000,
          "file-download": 1_950_000_000,
          "raw-network": 550_000_000,
        },
      }),
    ).toEqual([
      "Limit triggered by the 7-day network usage window.",
      "5-hour usage: 0 bytes / 2 GB.",
      "7-day usage: 4.1 GB / 3.5 GB.",
      "7-day network usage by category: Project backup uploads: 1.6 GB, File downloads: 2 GB, Project outbound network traffic: 550 MB.",
    ]);
  });

  it("omits absent limits and empty or invalid category values", () => {
    expect(
      formatManagedEgressPolicyDetails({
        blocked_by: "5h",
        managed_egress_categories_5h_bytes: {
          ssh: 0,
          unknown_category: Number.NaN,
        },
      }),
    ).toEqual(["Limit triggered by the 5-hour network usage window."]);
  });
});

describe("formatManagedEgressBlockedMessage", () => {
  const now = new Date("2026-10-18T23:00:00.000Z");
  const policy = {
    blocked_by: "7d" as const,
    managed_egress_5h_bytes: 1_000_000_000,
    managed_egress_7d_bytes: 100_000_000_000,
    egress_5h_bytes: 10_000_000_000,
    egress_7d_bytes: 100_000_000_000,
    blocked_until: "2026-10-19T05:30:00.000Z",
  };

  it("names the limit, usage/limit, reset time, next step and a code line", () => {
    const message = formatManagedEgressBlockedMessage({
      category: "control-plane-conat",
      policy,
      blocked: "New browser sessions for this account are blocked.",
      now,
    });
    const lines = message.split("\n");
    expect(lines[0]).toBe(
      "Account control traffic limit reached for this account.",
    );
    expect(lines[1]).toBe("New browser sessions for this account are blocked.");
    expect(message).toContain("7-day usage: 100 GB / 100 GB.");
    expect(message).toContain(
      "It resets at 2026-10-19T05:30:00.000Z (in about 6 hours 30 minutes).",
    );
    expect(message).toContain("contact support");
    expect(lines[lines.length - 1]).toBe(
      "Code: managed-egress-blocked category=control-plane-conat window=7d resets_at=2026-10-19T05:30:00.000Z",
    );
  });

  it("explains a rolling reset when no reset time is known", () => {
    const message = formatManagedEgressBlockedMessage({
      category: "ssh",
      policy: { ...policy, blocked_by: "5h", blocked_until: undefined },
      blocked: "New SSH sessions are blocked.",
      now,
    });
    expect(message).toContain(
      "It resets as usage older than 5 hours leaves the window.",
    );
    expect(message).not.toContain("resets_at=");
  });

  it("round-trips through the parser, even behind a sign-in error prefix", () => {
    const message = formatManagedEgressBlockedMessage({
      category: "control-plane-conat",
      policy,
      blocked: "New browser sessions for this account are blocked.",
      now,
    });
    const parsed = parseManagedEgressBlockedMessage(
      `failed to sign in - Error: ${message}`,
    );
    expect(parsed).toMatchObject({
      category: "control-plane-conat",
      window: "7d",
      resets_at: "2026-10-19T05:30:00.000Z",
      title: "Account control traffic limit reached for this account.",
    });
    expect(parsed?.details).toContain("7-day usage: 100 GB / 100 GB.");
    expect(parsed?.details.some((line) => line.startsWith("Code:"))).toBe(
      false,
    );
  });

  it("does not match ordinary errors", () => {
    expect(
      parseManagedEgressBlockedMessage("You must sign in."),
    ).toBeUndefined();
    expect(
      parseManagedEgressBlockedMessage(
        "failed to sign in - Error: no auth cookie set",
      ),
    ).toBeUndefined();
    expect(parseManagedEgressBlockedMessage(undefined)).toBeUndefined();
  });
});
