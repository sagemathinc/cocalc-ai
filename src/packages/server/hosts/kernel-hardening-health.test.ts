/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

import {
  kernelHardeningHealth,
  summarizeHostKernelHardening,
} from "./kernel-hardening-health";

const check = (key: string, ok: boolean, actual: number | null) => ({
  key,
  expected: ">= 2",
  actual,
  ok,
  managed: true,
});

describe("project host kernel hardening health", () => {
  const rows = [
    {
      host_id: "h1",
      host_name: "good",
      hardening: {
        ok: true,
        config_path: "/etc/sysctl.d/92-cocalc-project-host-hardening.conf",
        checks: [check("kernel.io_uring_disabled", true, 2)],
      },
    },
    {
      host_id: "h2",
      host_name: "drifted",
      hardening: {
        ok: false,
        config_path: "/etc/sysctl.d/92-cocalc-project-host-hardening.conf",
        checks: [
          check("kernel.io_uring_disabled", false, 0),
          check("kernel.unprivileged_bpf_disabled", false, null),
        ],
      },
    },
    { host_id: "h3", host_name: null, hardening: null },
  ];

  it("lists drifted hosts and counts hosts that don't report yet", () => {
    const summary = summarizeHostKernelHardening(rows);
    expect(summary).toEqual({
      active_hosts: 3,
      unreported_hosts: 1,
      failing: [
        {
          host_id: "h2",
          host_name: "drifted",
          failed: [
            "kernel.io_uring_disabled=0 (want >= 2)",
            "kernel.unprivileged_bpf_disabled=missing (want >= 2)",
          ],
        },
      ],
    });
    expect(
      kernelHardeningHealth({ status: "fulfilled", value: summary }),
    ).toEqual({
      level: "warning",
      summary:
        "1/2 reporting hosts have kernel hardening drift. 1 host does not report it yet.",
      details: [
        "drifted (h2): kernel.io_uring_disabled=0 (want >= 2), kernel.unprivileged_bpf_disabled=missing (want >= 2)",
      ],
    });
  });

  it("is healthy when every reporting host matches, even during a rollout", () => {
    const summary = summarizeHostKernelHardening([rows[0], rows[2]]);
    expect(
      kernelHardeningHealth({ status: "fulfilled", value: summary }),
    ).toEqual({
      level: "healthy",
      summary:
        "1/2 active hosts report the expected kernel hardening. 1 host does not report it yet.",
      details: [],
    });
  });

  it("is unknown when the reports can't be read", () => {
    expect(
      kernelHardeningHealth({
        status: "rejected",
        reason: new Error("db down"),
      }),
    ).toMatchObject({ level: "unknown" });
  });
});
