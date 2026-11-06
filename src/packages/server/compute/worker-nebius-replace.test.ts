/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A stopped Nebius VM whose machine or Spot cap changed is replaced, never
// started as is (#684): billing and the provider must agree.

const PROVISION_REACHED = "provision reached";
let vmRow: any;
const updateComputeVm = jest.fn(async (_id: string, patch: any) => {
  vmRow = { ...vmRow, ...patch };
  return vmRow;
});
const insertComputeInstance = jest.fn(async () => {
  throw new Error(PROVISION_REACHED);
});
const updateComputeInstance = jest.fn(async () => undefined);
const inspectProviderComputeVm = jest.fn();
const replaceProviderComputeInstance = jest.fn(async () => undefined);
const startProviderComputeVm = jest.fn(async () => undefined);
const setProviderComputeMachineType = jest.fn(async () => undefined);
const spotPolicyCap = jest.fn(async () => "2.400");

jest.mock("./db", () => ({
  ...jest.requireActual("./db"),
  getComputeVmById: async () => vmRow,
  updateComputeVm: (...a: any[]) => (updateComputeVm as any)(...a),
  updateComputeVmProviderObservation: async () => undefined,
  insertComputeInstance: (...a: any[]) => (insertComputeInstance as any)(...a),
  updateComputeInstance: (...a: any[]) => (updateComputeInstance as any)(...a),
  appendComputeEvent: async () => undefined,
  enqueueComputeWork: async () => undefined,
}));
jest.mock("./contract", () => ({
  ...jest.requireActual("./contract"),
  isComputeVmV2: () => true,
}));
jest.mock("./provider", () => {
  const actual = jest.requireActual("./provider");
  return {
    ...actual,
    inspectProviderComputeVm: (...a: any[]) =>
      (inspectProviderComputeVm as any)(...a),
    replaceProviderComputeInstance: (...a: any[]) =>
      (replaceProviderComputeInstance as any)(...a),
    startProviderComputeVm: (...a: any[]) =>
      (startProviderComputeVm as any)(...a),
    setProviderComputeMachineType: (...a: any[]) =>
      (setProviderComputeMachineType as any)(...a),
    // the real decision, with the observed policy cap from a fake Nebius
    nebiusComputeInstanceReplacementReason: async (vm: any, instance: any) =>
      actual.nebiusInstanceReplacementReason(vm, {
        machine_type: instance?.metadata?.machine_type,
        platform: instance?.metadata?.platform,
        spot_cap: instance?.metadata?.spot_pricing_policy_id
          ? await spotPolicyCap()
          : undefined,
      }),
  };
});

import { handleComputeWork } from "./worker";
import { specFor } from "./provider";

function nebiusVm(overrides: any = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "gpu-box",
    owner_account_id: "22222222-2222-4222-8222-222222222222",
    provider: "nebius",
    region: "eu-north1",
    zone: null,
    machine_type: "1gpu-32vcpu-400gb",
    provider_spec: { platform: "gpu-h100-sxm" },
    provider_instance_id: "computeinstance-abc",
    cpu: 32,
    ram_gb: 400,
    gpu_type: "h100",
    gpu_count: 1,
    boot_disk_gb: 100,
    boot_disk_id: "cocalc-vm-x-boot",
    state: "stopped",
    desired_state: "running",
    desired_pricing_model: "spot",
    effective_pricing_model: "spot",
    instance_generation: 2,
    ready_at: new Date("2026-11-01T00:00:00Z"),
    ssh_user: "user",
    public_ip: null,
    public_address_id: "alloc-1",
    metadata: {
      billing: {
        nebius_spot: { max_price_per_gpu_hour: "2.640" },
      },
    },
    ...overrides,
  };
}

function observedStopped(machineType: string) {
  return {
    status: "stopped",
    instance: {
      instance_id: "computeinstance-abc",
      status: "STOPPED",
      metadata: {
        machine_type: machineType,
        platform: "gpu-h100-sxm",
        pricing_model: "spot",
        spot_pricing_policy_id: "policy-old",
        provider_state: "STOPPED",
      },
    },
  };
}

const startWork = (vm: any) =>
  handleComputeWork({
    id: "work-1",
    resource_kind: "vm",
    resource_id: vm.id,
    action: "start",
    idempotency_key: "start-1",
  } as any);

describe("Nebius stale-instance replacement at start (#684)", () => {
  beforeEach(() => {
    for (const m of [
      updateComputeVm,
      insertComputeInstance,
      updateComputeInstance,
      inspectProviderComputeVm,
      replaceProviderComputeInstance,
      startProviderComputeVm,
      setProviderComputeMachineType,
    ])
      m.mockClear();
  });

  it("replaces an instance on the old machine and cap, and provisions the new one", async () => {
    // a machine change (and its new cap) while stopped: the instance is still
    // the old preset under the old cap's policy
    vmRow = nebiusVm({
      machine_type: "1gpu-16vcpu-200gb",
      cpu: 16,
      ram_gb: 200,
    });
    inspectProviderComputeVm.mockResolvedValue(
      observedStopped("1gpu-32vcpu-400gb"),
    );
    await expect(startWork(vmRow)).rejects.toThrow(PROVISION_REACHED);
    expect(replaceProviderComputeInstance).toHaveBeenCalledTimes(1);
    expect(updateComputeInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deleted: true,
        terminal_reason: "replaced_machine_type",
      }),
    );
    expect(startProviderComputeVm).not.toHaveBeenCalled();
    expect(setProviderComputeMachineType).not.toHaveBeenCalled();
    // the replacement is created from the VM: the new preset and billed cap
    const spec = specFor(vmRow, {} as any, undefined, "spot");
    expect(spec.metadata?.machine_type).toBe("1gpu-16vcpu-200gb");
    expect(spec.metadata?.spot_max_price_per_gpu_hour).toBe("2.640");
  });

  it("replaces an instance whose policy cap is not the billed cap", async () => {
    vmRow = nebiusVm();
    inspectProviderComputeVm.mockResolvedValue(
      observedStopped("1gpu-32vcpu-400gb"),
    );
    await expect(startWork(vmRow)).rejects.toThrow(PROVISION_REACHED);
    expect(replaceProviderComputeInstance).toHaveBeenCalledTimes(1);
    expect(updateComputeInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ terminal_reason: "replaced_spot_cap" }),
    );
    expect(startProviderComputeVm).not.toHaveBeenCalled();
  });

  it("starts a matching instance in place", async () => {
    vmRow = nebiusVm({
      metadata: {
        billing: { nebius_spot: { max_price_per_gpu_hour: "2.400" } },
      },
    });
    inspectProviderComputeVm.mockResolvedValue(
      observedStopped("1gpu-32vcpu-400gb"),
    );
    await startWork(vmRow).catch(() => undefined);
    expect(replaceProviderComputeInstance).not.toHaveBeenCalled();
    expect(insertComputeInstance).not.toHaveBeenCalled();
  });
});

describe("nebiusInstanceReplacementReason", () => {
  const { nebiusInstanceReplacementReason } = jest.requireActual("./provider");
  const vm = nebiusVm();
  it("matches only an instance with the VM's preset, platform and billed cap", () => {
    expect(
      nebiusInstanceReplacementReason(vm, {
        machine_type: "1gpu-32vcpu-400gb",
        platform: "gpu-h100-sxm",
        spot_cap: "2.640",
      }),
    ).toBeUndefined();
    expect(
      nebiusInstanceReplacementReason(vm, {
        machine_type: "1gpu-32vcpu-400gb",
        platform: "gpu-l40s",
        spot_cap: "2.640",
      }),
    ).toBe("platform");
    // a Spot VM without a billed cap, or an instance without a policy, fails closed
    expect(
      nebiusInstanceReplacementReason(
        { ...vm, metadata: {} },
        { machine_type: "1gpu-32vcpu-400gb", spot_cap: "2.640" },
      ),
    ).toBe("spot_cap");
    expect(
      nebiusInstanceReplacementReason(vm, {
        machine_type: "1gpu-32vcpu-400gb",
      }),
    ).toBe("spot_cap");
    // Standard and other clouds compare the machine only
    expect(
      nebiusInstanceReplacementReason(
        { ...vm, effective_pricing_model: "on_demand" },
        { machine_type: "1gpu-32vcpu-400gb" },
      ),
    ).toBeUndefined();
    expect(
      nebiusInstanceReplacementReason(
        { ...vm, provider: "gcp" },
        { machine_type: "x" },
      ),
    ).toBeUndefined();
  });
});
