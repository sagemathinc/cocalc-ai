/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { initHubApi, transformArgs } from "@cocalc/conat/hub/api";
import { createVolume, getCatalog } from "./compute";
import { requireSponsoredVmAdmission } from "@cocalc/server/compute/funding/vm-funding";
import {
  reserveCourseVolume,
  publicVolumeFundingStatus,
} from "@cocalc/server/compute/funding/volume-funding";
import { insertComputeVolume } from "@cocalc/server/compute/volume-db";
import { enqueueComputeWork } from "@cocalc/server/compute/db";
import { assertDedicatedHostAdmissionForAccount } from "@cocalc/server/project-host/admission";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";
import { getComputeVmConfig } from "@cocalc/server/compute/config";
import { getCatalog as getHostCatalog } from "./hosts";
import { estimateDedicatedHostRate } from "@cocalc/server/project-host/spend";

jest.mock("@cocalc/server/compute/config");
jest.mock("@cocalc/server/compute/provider");
jest.mock("@cocalc/server/compute/db");
jest.mock("@cocalc/server/compute/volume-db");
jest.mock("@cocalc/server/project-host/admission");
jest.mock("@cocalc/server/project-host/spend");
jest.mock("./dangerous-session-auth");
jest.mock("./hosts");
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: async () => false,
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({}),
}));
jest.mock("@cocalc/server/compute/funding/vm-funding", () => ({
  ...jest.requireActual("@cocalc/server/compute/funding/vm-funding"),
  requireSponsoredVmAdmission: jest.fn(),
}));
jest.mock("@cocalc/server/compute/funding/volume-funding", () => ({
  ...jest.requireActual("@cocalc/server/compute/funding/volume-funding"),
  reserveCourseVolume: jest.fn(),
  publicVolumeFundingStatus: jest.fn(),
}));

const student = "10000000-0000-4000-8000-000000000001";
const payer = "10000000-0000-4000-8000-000000000002";
const source = {
  kind: "course" as const,
  pool_id: "10000000-0000-4000-8000-000000000003",
  grant_id: "10000000-0000-4000-8000-000000000004",
  payer_account_id: payer,
};
const request = {
  name: "course-home",
  provider: "nebius" as const,
  region: "eu-north1",
  size_gb: 93,
  idempotency_key: "volume-operation",
  funding_source: source,
  accept_course_retention: true,
};
const api = initHubApi(async ({ name, args }) => {
  const transformed = await transformArgs({ name, args, account_id: student });
  if (name === "compute.createVolume")
    return await createVolume(transformed[0]);
  throw Error("unexpected API");
}).compute;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requireSponsoredVmAdmission).mockResolvedValue(undefined);
  jest.mocked(getComputeVmConfig).mockResolvedValue({
    environment: "development",
    max_volume_gb: 1024,
    max_volumes_per_account: 10,
  } as any);
  jest.mocked(estimateDedicatedHostRate).mockResolvedValue({
    hourly_cost_usd: "0.01",
    pricing_snapshot: { provider: "nebius" },
  } as any);
  jest
    .mocked(assertDedicatedHostAdmissionForAccount)
    .mockRejectedValue(Error("No personal payment or second factor"));
  jest
    .mocked(insertComputeVolume)
    .mockImplementation(
      async (volume) =>
        ({ ...volume, created_at: new Date(), updated_at: new Date() }) as any,
    );
  jest.mocked(reserveCourseVolume).mockImplementation(async (volume) => {
    expect(enqueueComputeWork).not.toHaveBeenCalled();
    expect(volume.owner_account_id).toBe(student);
    return { ...volume, funding_mode: "account-postpaid" };
  });
  jest.mocked(publicVolumeFundingStatus).mockImplementation((volume) => ({
    source: {
      kind: "course",
      pool_id: source.pool_id,
      grant_id: source.grant_id,
    },
    state: "ready",
    label: "Course funding",
    funding_version: volume.metadata.billing.course_funding.funding_epoch,
    as_of: new Date().toISOString(),
  }));
});

it("the authenticated volume caller reserves the selected course source without personal eligibility and preserves student ownership", async () => {
  const result = await api.createVolume({
    ...request,
    account_id: payer,
  } as any);
  expect(assertDedicatedHostAdmissionForAccount).not.toHaveBeenCalled();
  expect(requireDangerousSessionAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: student,
      require_second_factor: "if_enabled",
    }),
  );
  expect(insertComputeVolume).toHaveBeenCalledWith(
    expect.objectContaining({
      owner_account_id: student,
      metadata: expect.objectContaining({
        billing: expect.objectContaining({
          course_funding: expect.objectContaining({
            source,
            retention_agreement: expect.objectContaining({
              accepted_by: student,
              max_grace_hours: 72,
              independent_of_vm: true,
            }),
          }),
        }),
      }),
    }),
    10,
  );
  expect(reserveCourseVolume).toHaveBeenCalledTimes(1);
  expect(result.owner_account_id).toBe(student);
  expect(result.funding_mode).toBe("account-postpaid");
  expect(result.funding_source).toEqual({
    kind: "course",
    pool_id: source.pool_id,
    grant_id: source.grant_id,
  });
  expect(result.funding_status?.payer_account_id).toBeUndefined();
  expect(enqueueComputeWork).toHaveBeenCalledWith(
    expect.objectContaining({
      resource_kind: "volume",
      action: "provision_volume",
    }),
  );
});
it.each([false, undefined])(
  "rejects creation without explicit independent retention acknowledgment (%s)",
  async (accept) => {
    await expect(
      api.createVolume({ ...request, accept_course_retention: accept }),
    ).rejects.toThrow(/independent funded retention/);
    expect(insertComputeVolume).not.toHaveBeenCalled();
  },
);
it("does not queue provider work when payer reservation fails", async () => {
  jest
    .mocked(reserveCourseVolume)
    .mockRejectedValueOnce(Error("Grant unavailable"));
  await expect(api.createVolume(request)).rejects.toThrow("Grant unavailable");
  expect(enqueueComputeWork).not.toHaveBeenCalled();
});
it("keeps both personal policy and sponsored rollout enforcement at the public mutation", async () => {
  await expect(
    api.createVolume({ ...request, funding_source: undefined }),
  ).rejects.toThrow("No personal payment");
  await expect(
    api.createVolume({ ...request, funding_mode: "site-funded" }),
  ).rejects.toThrow("account funding lane");
  jest
    .mocked(requireSponsoredVmAdmission)
    .mockRejectedValueOnce(Error("rollout incomplete"));
  await expect(api.createVolume(request)).rejects.toThrow("rollout incomplete");
  expect(insertComputeVolume).not.toHaveBeenCalled();
});
it("advertises sponsored volumes only when the resource rollout admits sponsorship", async () => {
  jest.mocked(getHostCatalog).mockResolvedValue({ entries: [] } as any);
  expect(
    (await getCatalog({ account_id: student })).sponsored_home_volumes,
  ).toBe(true);
  jest
    .mocked(requireSponsoredVmAdmission)
    .mockRejectedValueOnce(Error("rollout incomplete"));
  expect(
    (await getCatalog({ account_id: student })).sponsored_home_volumes,
  ).toBe(false);
});
