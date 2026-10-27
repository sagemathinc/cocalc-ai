/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AccountUsageMeter,
  AccountUsageOverview,
} from "@cocalc/conat/hub/api/purchases";
import { getAccountCpuWarning } from "./account-cpu-warning";

function makeMeter({
  id,
  percent,
  severity = "ok",
  used,
}: {
  id: "managed-cpu-5h" | "managed-cpu-7d";
  percent: number;
  severity?: AccountUsageMeter["severity"];
  used: number;
}): AccountUsageMeter {
  return {
    id,
    category: "compute",
    window: id === "managed-cpu-5h" ? "5h" : "7d",
    label: id === "managed-cpu-5h" ? "CPU 5-hour usage" : "CPU 7-day usage",
    help: "Managed CPU usage.",
    unit: "seconds",
    used,
    limit: 100,
    ratio: percent / 100,
    percent,
    severity,
    upgrade_relevant: true,
  };
}

function makeOverview(meters: AccountUsageMeter[]): AccountUsageOverview {
  return {
    collected_at: new Date().toISOString(),
    summary: {},
    meters,
    recent_events: {},
    measurement_warnings: [],
  };
}

describe("getAccountCpuWarning", () => {
  it("returns no warning below the CPU threshold", () => {
    expect(
      getAccountCpuWarning(
        makeOverview([
          makeMeter({ id: "managed-cpu-5h", percent: 40, used: 40 }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("selects the most pressured CPU window", () => {
    expect(
      getAccountCpuWarning(
        makeOverview([
          makeMeter({ id: "managed-cpu-5h", percent: 80, used: 80 }),
          makeMeter({ id: "managed-cpu-7d", percent: 95, used: 95 }),
        ]),
      ),
    ).toEqual(
      expect.objectContaining({
        percent: 95,
        severity: "severe",
        meter: expect.objectContaining({ id: "managed-cpu-7d" }),
      }),
    );
  });

  it("treats an over-limit CPU window as blocked", () => {
    expect(
      getAccountCpuWarning(
        makeOverview([
          makeMeter({
            id: "managed-cpu-5h",
            percent: 175,
            severity: "over",
            used: 175,
          }),
        ]),
      ),
    ).toEqual(
      expect.objectContaining({
        percent: 175,
        severity: "blocked",
      }),
    );
  });
});
