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

import { PROJECT_HOST_KERNEL_HARDENING } from "@cocalc/conat/project-host/kernel-hardening";
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

// A complete, passing report of every expected setting.
const allChecks = () =>
  PROJECT_HOST_KERNEL_HARDENING.map(({ key }) => check(key, true, 2));

describe("project host kernel hardening health", () => {
  const rows = [
    {
      host_id: "h1",
      host_name: "good",
      hardening: {
        ok: true,
        config_path: "/etc/sysctl.d/92-cocalc-project-host-hardening.conf",
        checks: allChecks(),
      },
    },
    {
      host_id: "h2",
      host_name: "drifted",
      hardening: {
        ok: false,
        config_path: "/etc/sysctl.d/92-cocalc-project-host-hardening.conf",
        checks: allChecks().map((c) =>
          c.key === "kernel.io_uring_disabled"
            ? check(c.key, false, 0)
            : c.key === "kernel.unprivileged_bpf_disabled"
              ? check(c.key, false, null)
              : c,
        ),
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

  it("treats a partial or inconsistent report as failing", () => {
    const config_path = "/etc/sysctl.d/92-cocalc-project-host-hardening.conf";
    const summary = summarizeHostKernelHardening([
      {
        host_id: "p",
        host_name: "partial",
        hardening: {
          ok: true,
          config_path,
          checks: allChecks().filter(
            ({ key }) => key !== "kernel.perf_event_paranoid",
          ),
        },
      },
      {
        host_id: "e",
        host_name: "empty",
        hardening: { ok: false, config_path, checks: [] },
      },
      {
        host_id: "i",
        host_name: "inconsistent",
        hardening: { ok: false, config_path, checks: allChecks() },
      },
    ]);
    expect(summary.unreported_hosts).toBe(0);
    expect(summary.failing).toEqual([
      {
        host_id: "p",
        host_name: "partial",
        failed: ["kernel.perf_event_paranoid not reported"],
      },
      {
        host_id: "e",
        host_name: "empty",
        failed: PROJECT_HOST_KERNEL_HARDENING.map(
          ({ key }) => `${key} not reported`,
        ),
      },
      {
        host_id: "i",
        host_name: "inconsistent",
        failed: ["report says not ok but lists no failed setting"],
      },
    ]);
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
