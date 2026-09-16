/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  recoverExistingCourseVmFunding,
  recoverTerminalCourseVmFunding,
} from "./vm-worker-recovery";
import { meterCourseVm, payerApi } from "./vm-funding";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay",
}));
jest.mock("./vm-funding", () => ({
  meterCourseVm: jest.fn(),
  payerApi: jest.fn(),
}));

const query = jest.fn();
const lookup = jest.fn();
function fixture() {
  const source = {
    kind: "course",
    payer_account_id: "payer",
    pool_id: "pool",
    grant_id: "grant",
  };
  const binding = {
    source,
    payer_account_id: "payer",
    payer_authority_epoch: "authority",
    owner_account_id: "owner",
    owning_bay_id: "bay",
    resource_id: "vm",
    resource_generation: 1,
    funding_epoch: "epoch",
    lane: "prepaid",
  };
  const vm = {
    id: "vm",
    owner_account_id: "owner",
    owning_bay_id: "bay",
    instance_generation: 1,
    state: "deleted",
    desired_state: "deleted",
    deleted_at: new Date(),
    metadata: {
      billing: { course_funding: { source, funding_epoch: "epoch" } },
    },
  } as any;
  return { vm, binding };
}

beforeEach(() => {
  jest.clearAllMocks();
  query.mockReset();
  jest.mocked(getPool).mockReturnValue({ query } as any);
  lookup.mockReset();
  jest
    .mocked(payerApi)
    .mockResolvedValue({ lookupComputeVmFunding: lookup } as any);
});

it("attaches an existing lost-reply reservation to a deleted VM without changing intent or creating funding", async () => {
  const { vm, binding } = fixture();
  const recovered = {
    ...vm,
    metadata: {
      billing: {
        course_funding: { ...vm.metadata.billing.course_funding, binding },
      },
    },
  };
  lookup.mockResolvedValueOnce(binding);
  query.mockResolvedValueOnce({ rows: [recovered] });
  expect(await recoverExistingCourseVmFunding(vm)).toBe(recovered);
  expect(payerApi).toHaveBeenCalledWith("payer");
  expect(lookup).toHaveBeenCalledWith({
    account_id: "payer",
    source: binding.source,
    resource_kind: "compute-vm",
    resource_id: "vm",
    resource_generation: 1,
    owner_account_id: "owner",
    owning_bay_id: "bay",
    funding_epoch: "epoch",
  });
  const sql = query.mock.calls[0][0];
  expect(sql).toContain("instance_generation=$6");
  expect(sql).toContain("course_funding,funding_epoch");
  expect(sql).not.toMatch(
    /deleted_at IS NULL|SET desired_state|INSERT|reserved_usd/i,
  );
  expect(meterCourseVm).not.toHaveBeenCalled();
});

it("leaves a missing reservation retryable without creating or releasing one", async () => {
  lookup.mockResolvedValue(null);
  expect(await recoverExistingCourseVmFunding(fixture().vm)).toBeUndefined();
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  "owner_account_id",
  "owning_bay_id",
  "resource_id",
  "resource_generation",
  "funding_epoch",
  "payer_authority_epoch",
])("preserves a payer-home rejection for mismatched %s", async (key) => {
  const { vm } = fixture();
  lookup.mockRejectedValueOnce(new Error(`mismatched ${key}`));
  await expect(recoverExistingCourseVmFunding(vm)).rejects.toThrow(
    /mismatched/,
  );
  expect(query).not.toHaveBeenCalled();
});

it("does not fall back to a local projection when the payer route is unavailable", async () => {
  jest
    .mocked(payerApi)
    .mockRejectedValueOnce(new Error("payer route unavailable"));
  await expect(recoverExistingCourseVmFunding(fixture().vm)).rejects.toThrow(
    /payer route unavailable/,
  );
  expect(query).not.toHaveBeenCalled();
});

it("does not settle a stale result when a concurrent epoch change defeats the binding CAS", async () => {
  const { vm, binding } = fixture();
  lookup.mockResolvedValueOnce(binding);
  query.mockResolvedValueOnce({ rows: [] });
  expect(await recoverExistingCourseVmFunding(vm)).toBeUndefined();
  expect(meterCourseVm).not.toHaveBeenCalled();
});

it("durably rediscovers deleted rows and retries settlement after payer failure", async () => {
  const { vm, binding } = fixture();
  vm.metadata.billing.course_funding.binding = binding;
  query.mockResolvedValue({ rows: [vm] });
  jest
    .mocked(meterCourseVm)
    .mockRejectedValueOnce(new Error("payer unavailable"))
    .mockResolvedValueOnce(undefined);
  await recoverTerminalCourseVmFunding();
  await recoverTerminalCourseVmFunding();
  expect(meterCourseVm).toHaveBeenCalledTimes(2);
  expect(meterCourseVm).toHaveBeenLastCalledWith(vm, true);
  expect(query.mock.calls[0][0]).toContain("deleted_at IS NOT NULL");
  expect(query.mock.calls[0][0]).toContain("ORDER BY id LIMIT $3");
  expect(query.mock.calls[0][1][2]).toBe(20);
});

it("recovers stopped intent without claiming provider deletion or releasing backing", async () => {
  const { vm, binding } = fixture();
  delete vm.deleted_at;
  vm.desired_state = "stopped";
  const recovered = {
    ...vm,
    metadata: {
      billing: {
        course_funding: { ...vm.metadata.billing.course_funding, binding },
      },
    },
  };
  query
    .mockResolvedValueOnce({ rows: [vm] })
    .mockResolvedValueOnce({ rows: [recovered] });
  lookup.mockResolvedValueOnce(binding);
  await recoverTerminalCourseVmFunding();
  expect(meterCourseVm).not.toHaveBeenCalled();
});
