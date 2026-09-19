/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { handleComputeWork } from "../worker";
import { getComputeVmById } from "../db";
import { createProviderComputeVm, startProviderComputeVm } from "../provider";
import { enforceCourseVmFunding, queueCourseVmEnforcement } from "./vm-funding";

jest.mock("../db", () => ({ getComputeVmById: jest.fn() }));
jest.mock("../provider", () => ({
  createProviderComputeVm: jest.fn(),
  startProviderComputeVm: jest.fn(),
}));
jest.mock("./vm-funding", () => ({
  hasCourseVmFunding: () => true,
  enforceCourseVmFunding: jest.fn(),
  queueCourseVmEnforcement: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (getComputeVmById as jest.Mock).mockResolvedValue({
    id: "vm",
    desired_state: "running",
    public_hostname: "vm.example.test",
    bootstrap_revision: 2,
    funding_mode: "account-prepaid",
    metadata: { billing: { course_funding: { binding: {} } } },
  });
});

it.each(["provision", "start", "reconcile", "probe_spot"])(
  "does not let queued %s bypass sponsored exhaustion",
  async (action) => {
    (enforceCourseVmFunding as jest.Mock).mockResolvedValue("stop");
    await handleComputeWork({
      resource_kind: "vm",
      resource_id: "vm",
      action,
    } as any);
    expect(queueCourseVmEnforcement).toHaveBeenCalledWith(
      expect.objectContaining({ id: "vm" }),
      "stop",
    );
    expect(createProviderComputeVm).not.toHaveBeenCalled();
    expect(startProviderComputeVm).not.toHaveBeenCalled();
  },
);

it("fails closed on an unavailable payer without starting provider work", async () => {
  (enforceCourseVmFunding as jest.Mock).mockRejectedValue(
    new Error("payer unavailable"),
  );
  await expect(
    handleComputeWork({
      resource_kind: "vm",
      resource_id: "vm",
      action: "start",
    } as any),
  ).rejects.toThrow("payer unavailable");
  expect(queueCourseVmEnforcement).toHaveBeenCalledWith(
    expect.anything(),
    "stop",
  );
  expect(startProviderComputeVm).not.toHaveBeenCalled();
});
