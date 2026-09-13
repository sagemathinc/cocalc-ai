/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  enforceComputeVmFunding,
  handleComputeWork,
  startComputeVmWorker,
} from "./worker";
import * as db from "./db";
import * as provider from "./provider";
import * as funding from "./funding/vm-funding";
import { recoverTerminalCourseVmFunding } from "./funding/vm-worker-recovery";
import { recoverTerminalCourseVolumeFunding } from "./funding/volume-recovery";
import { finalizeSettledCourseFundingPools } from "./funding/pool-lifecycle-worker";
import { processVmPersonalFundingHandoffs } from "./funding/vm-personal";
import { enqueueScheduledComputeStops } from "./scheduled-stop";
import { getComputeVmConfig } from "./config";
import * as volumes from "./volume-db";
import * as access from "./project-access";
import { listManagedVmDnsRecords } from "../cloud/dns";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import * as volumeFunding from "./funding/volume-funding";

jest.mock("./db");
jest.mock("./provider");
jest.mock("./config");
jest.mock("./volume-db");
jest.mock("./project-access");
jest.mock("../cloud/dns");
jest.mock("./orphans");
jest.mock("./schema", () => ({
  ensureComputeWorkQueueSchema: jest.fn(async () => {}),
  ensureComputeScheduledStopSchema: jest.fn(async () => {}),
}));
jest.mock("./scheduled-stop", () => ({
  enqueueScheduledComputeStops: jest.fn(async () => {}),
}));
jest.mock("./funding/vm-funding");
jest.mock("./funding/vm-worker-recovery");
jest.mock("./funding/volume-funding");
jest.mock("./funding/volume-recovery");
jest.mock("./funding/vm-personal", () => ({
  processVmPersonalFundingHandoffs: jest.fn(async () => {}),
}));
jest.mock("./funding/pool-lifecycle-worker", () => ({
  finalizeSettledCourseFundingPools: jest.fn(async () => {}),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
  withSessionAdvisoryLock: jest.fn(async ({ fn }) => fn()),
}));

function pendingVm() {
  return {
    id: "vm",
    owner_account_id: "owner",
    owning_bay_id: "bay",
    public_hostname: "vm.example.test",
    bootstrap_revision: 2,
    funding_mode: "account-prepaid",
    instance_generation: 1,
    provider: "nebius",
    state: "requested",
    desired_state: "running",
    metadata: {
      billing: { course_funding: { funding_epoch: "epoch", binding: {} } },
    },
  } as any;
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-12T20:00:00Z"));
  jest
    .mocked(withSessionAdvisoryLock)
    .mockImplementation(async ({ fn }: any) => fn());
  jest
    .mocked(funding.hasCourseVmFunding)
    .mockImplementation((vm) => !!vm.metadata?.billing?.course_funding);
  jest.mocked(funding.enforceCourseVmFunding).mockResolvedValue(undefined);
  jest
    .mocked(funding.enqueueCourseFundingDeadlines)
    .mockResolvedValue(undefined);
  jest.mocked(recoverTerminalCourseVmFunding).mockResolvedValue(undefined);
  jest.mocked(recoverTerminalCourseVolumeFunding).mockResolvedValue(undefined);
  jest.mocked(processVmPersonalFundingHandoffs).mockResolvedValue(undefined);
  jest.mocked(finalizeSettledCourseFundingPools).mockResolvedValue(0);
  jest.mocked(enqueueScheduledComputeStops).mockResolvedValue(0);
  jest.mocked(db.listComputeVmsForBillingEnforcement).mockResolvedValue([]);
  jest.mocked(db.listComputeVmsForEgressMetering).mockResolvedValue([]);
  jest.mocked(db.listComputeVmsForInventory).mockResolvedValue([]);
  jest.mocked(db.claimComputeWork).mockResolvedValue([]);
  jest.mocked(volumes.listComputeVolumesForInventory).mockResolvedValue([]);
  jest.mocked(access.listComputeVmProjectAccess).mockResolvedValue([]);
  jest
    .mocked(provider.listProviderComputeInventory)
    .mockResolvedValue({ instances: [], disks: [], addresses: [] } as any);
  jest.mocked(getComputeVmConfig).mockResolvedValue({} as any);
  jest.mocked(listManagedVmDnsRecords).mockResolvedValue([]);
});
afterEach(() => {
  jest.useRealTimers();
});

it("does not meter or stop an admitted VM that has not reached a provider lifecycle edge", async () => {
  jest
    .mocked(db.listComputeVmsForBillingEnforcement)
    .mockResolvedValue([pendingVm()]);
  jest
    .mocked(funding.meterCourseVm)
    .mockRejectedValue(new Error("VM reservation has not been dispatched."));
  await enforceComputeVmFunding();
  expect(funding.enforceCourseVmFunding).toHaveBeenCalled();
  expect(funding.meterCourseVm).not.toHaveBeenCalled();
  expect(funding.queueCourseVmEnforcement).not.toHaveBeenCalled();
});

it("keeps settlement failures separate from service authorization", async () => {
  const vm = { ...pendingVm(), ready_at: new Date() };
  jest.mocked(db.listComputeVmsForBillingEnforcement).mockResolvedValue([vm]);
  jest
    .mocked(funding.meterCourseVm)
    .mockRejectedValue(new Error("meter retry"));
  await enforceComputeVmFunding();
  expect(funding.meterCourseVm).toHaveBeenCalledWith(vm);
  expect(funding.queueCourseVmEnforcement).not.toHaveBeenCalled();
  jest.mocked(funding.enforceCourseVmFunding).mockResolvedValue("stop");
  await enforceComputeVmFunding();
  expect(funding.queueCourseVmEnforcement).toHaveBeenCalledWith(vm, "stop");
});

it("claims queued cleanup while funding is pending and never overlaps the pending pass", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const vm = { ...pendingVm(), ready_at: new Date() };
  jest.mocked(db.listComputeVmsForBillingEnforcement).mockResolvedValue([vm]);
  jest.mocked(funding.enforceCourseVmFunding).mockImplementation(async () => {
    await blocked;
    return undefined;
  });
  const stop = startComputeVmWorker();
  try {
    await jest.advanceTimersByTimeAsync(2_000);
    expect(funding.enforceCourseVmFunding).toHaveBeenCalledTimes(1);
    const claims = jest.mocked(db.claimComputeWork).mock.calls.length;
    let deleting = {
      ...pendingVm(),
      id: "cleanup-vm",
      desired_state: "deleted",
      state: "deleting",
    };
    jest.mocked(db.getComputeVmById).mockImplementation(async () => deleting);
    jest.mocked(db.updateComputeVm).mockImplementation(async (_, patch) => {
      deleting = { ...deleting, ...patch };
      return deleting;
    });
    jest.mocked(db.claimComputeWork).mockResolvedValueOnce([
      {
        id: "cleanup-work",
        resource_kind: "vm",
        resource_id: deleting.id,
        action: "delete",
      } as any,
    ]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.claimComputeWork).toHaveBeenCalledTimes(claims + 30);
    expect(funding.enforceCourseVmFunding).toHaveBeenCalledTimes(1);
    expect(funding.enqueueCourseFundingDeadlines).toHaveBeenCalled();
    expect(enqueueScheduledComputeStops).toHaveBeenCalled();
    expect(processVmPersonalFundingHandoffs).toHaveBeenCalled();
    expect(recoverTerminalCourseVmFunding).toHaveBeenCalled();
    expect(provider.deleteProviderComputeVm).toHaveBeenCalled();
    expect(db.finishComputeWork).toHaveBeenCalledWith({
      id: "cleanup-work",
      state: "done",
    });
    expect(deleting.state).toBe("deleted");
    release();
    await jest.advanceTimersByTimeAsync(16_000);
    expect(funding.enforceCourseVmFunding).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    release();
    await jest.advanceTimersByTimeAsync(0);
  }
});

it("claims work while egress and provider inventory calls are pending, preserving their single-flight locks", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .mocked(db.listComputeVmsForEgressMetering)
    .mockImplementation(async () => {
      await blocked;
      return [];
    });
  jest
    .mocked(provider.listProviderComputeInventory)
    .mockImplementation(async () => {
      await blocked;
      return { instances: [], disks: [], addresses: [] } as any;
    });
  const stop = startComputeVmWorker();
  try {
    await jest.advanceTimersByTimeAsync(16 * 60_000);
    expect(db.claimComputeWork).toHaveBeenCalled();
    expect(db.listComputeVmsForEgressMetering).toHaveBeenCalledTimes(1);
    expect(provider.listProviderComputeInventory).toHaveBeenCalledTimes(1);
    expect(withSessionAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ lockKey: "managed-compute-egress-meter" }),
    );
  } finally {
    stop();
    release();
    await jest.advanceTimersByTimeAsync(0);
  }
});

it("completes provider deletion without requiring a missing binding or an available payer", async () => {
  let vm = { ...pendingVm(), desired_state: "deleted", state: "deleting" };
  vm.metadata.billing.course_funding.binding = undefined;
  jest.mocked(db.getComputeVmById).mockImplementation(async () => vm);
  jest.mocked(db.updateComputeVm).mockImplementation(async (_, patch) => {
    vm = { ...vm, ...patch };
    return vm;
  });
  jest
    .mocked(funding.meterCourseVm)
    .mockRejectedValue(new Error("payer unavailable"));
  await handleComputeWork({
    resource_kind: "vm",
    resource_id: vm.id,
    action: "delete",
  } as any);
  expect(provider.deleteProviderComputeVm).toHaveBeenCalled();
  expect(vm.state).toBe("deleted");
  expect(vm.deleted_at).toBeInstanceOf(Date);
  expect(funding.reserveCourseVmLaunch).not.toHaveBeenCalled();
  expect(funding.meterCourseVm).not.toHaveBeenCalled();
});

it("ignores cleanup work carrying an obsolete funding epoch", async () => {
  jest.mocked(db.getComputeVmById).mockResolvedValue(pendingVm());
  await handleComputeWork({
    resource_kind: "vm",
    resource_id: "vm",
    action: "delete",
    payload: { funding_epoch: "old-epoch" },
  } as any);
  expect(provider.deleteProviderComputeVm).not.toHaveBeenCalled();
  expect(funding.reserveCourseVmLaunch).not.toHaveBeenCalled();
});

it.each([true, false])(
  "observes retained storage without provisioning or resizing (present=%s)",
  async (present) => {
    const volume = {
      id: "volume",
      role: "home",
      funding_mode: "account-prepaid",
      owner_account_id: "owner",
      owning_bay_id: "bay",
      provider: "gcp",
      state: "failed",
      desired_state: "ready",
      size_gb: 10,
      desired_size_gb: 10,
      ready_at: new Date(),
      attached_vm_id: null,
      attachment_generation: 2,
      metadata: {
        billing: {
          course_funding: {
            funding_epoch: "epoch",
            binding: {},
            service_ended_at: new Date().toISOString(),
          },
        },
      },
    } as any;
    const query = jest.fn().mockResolvedValue({ rows: [] });
    jest.mocked(getPool).mockReturnValue({ query } as any);
    jest.mocked(volumes.getComputeVolumeById).mockResolvedValue(volume);
    jest.mocked(volumeFunding.hasCourseVolumeFunding).mockReturnValue(true);
    jest
      .mocked(volumeFunding.requireCourseVolumeService)
      .mockRejectedValue(Error("Protected storage"));
    jest
      .mocked(provider.inspectProviderComputeVolume)
      .mockResolvedValue(
        present ? ({ size_gb: 10, users: [] } as any) : undefined,
      );
    await handleComputeWork({
      resource_kind: "volume",
      resource_id: volume.id,
      action: "reconcile_volume",
    } as any);
    expect(volumeFunding.endCourseVolumeService).toHaveBeenCalledWith(volume);
    expect(provider.inspectProviderComputeVolume).toHaveBeenCalledWith(volume);
    expect(provider.ensureProviderComputeVolume).not.toHaveBeenCalled();
    expect(provider.resizeProviderComputeVolume).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("AND attachment_generation=$6"),
      expect.arrayContaining([
        volume.id,
        present ? "ready" : "failed",
        "epoch",
        2,
      ]),
    );
    expect(query.mock.calls[0][0]).toContain("service_ended_at}' IS NOT NULL");
  },
);
